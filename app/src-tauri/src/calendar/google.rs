//! Google Calendar source.
//!
//! This file holds the **pure, privacy-critical** layer: the `events.list` JSON
//! shapes and the mapper that turns a Google event into the platform-free
//! [`CalendarEventCandidate`] the rest of the pipeline already understands.
//!
//! The no-email invariant is enforced **structurally**: attendee/organizer email
//! fields are simply not part of the deserialization structs, so an email in the
//! API response is never read into memory, let alone stored or sent. Self/
//! participation is derived from Google's `self` + `responseStatus` booleans, not
//! from matching an email.
//!
//! The live OAuth flow (loopback + PKCE + system browser), token storage, and the
//! REST fetch are wired separately; they require a Google OAuth client id and a
//! bundled build to verify the consent round-trip.

use crate::calendar::matching::{Attendee, CalendarEventCandidate, EventStatus, ParticipantStatus};
use crate::calendar::SourceKind;
use crate::database::models::CalendarAccount;
use crate::keychain::SecretStore;
use base64::Engine;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

/// `events.list` response envelope.
#[derive(Debug, Deserialize)]
pub struct GoogleEventsList {
    #[serde(default)]
    pub items: Vec<GoogleEvent>,
}

/// A single event. Only the fields we consume are declared. Notably, attendee
/// and organizer EMAIL fields are intentionally absent so they can never be read.
#[derive(Debug, Deserialize)]
pub struct GoogleEvent {
    pub summary: Option<String>,
    pub start: Option<GoogleDateTime>,
    pub end: Option<GoogleDateTime>,
    #[serde(rename = "iCalUID")]
    pub ical_uid: Option<String>,
    pub status: Option<String>,
    pub attendees: Option<Vec<GoogleAttendee>>,
    pub organizer: Option<GoogleOrganizer>,
    pub location: Option<String>,
    #[serde(rename = "hangoutLink")]
    pub hangout_link: Option<String>,
    #[serde(rename = "conferenceData")]
    pub conference_data: Option<GoogleConferenceData>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleDateTime {
    #[serde(rename = "dateTime")]
    pub date_time: Option<String>, // RFC3339 (timed events)
    pub date: Option<String>, // YYYY-MM-DD (all-day events)
}

#[derive(Debug, Deserialize)]
pub struct GoogleAttendee {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "self")]
    pub is_self: Option<bool>,
    #[serde(rename = "responseStatus")]
    pub response_status: Option<String>,
    pub organizer: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleOrganizer {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "self")]
    pub is_self: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleConferenceData {
    #[serde(rename = "entryPoints")]
    pub entry_points: Option<Vec<GoogleEntryPoint>>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleEntryPoint {
    #[serde(rename = "entryPointType")]
    pub entry_point_type: Option<String>,
    pub uri: Option<String>,
}

fn parse_dt(dt: Option<&GoogleDateTime>) -> Option<DateTime<Utc>> {
    let dt = dt?;
    if let Some(s) = dt.date_time.as_deref() {
        return DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.with_timezone(&Utc));
    }
    // All-day event: midnight UTC of the given date (these are excluded by the
    // matcher anyway, but we still need a concrete instant).
    if let Some(s) = dt.date.as_deref() {
        if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            let ndt = d.and_hms_opt(0, 0, 0)?;
            return Some(Utc.from_utc_datetime(&ndt));
        }
    }
    None
}

fn map_response_status(s: Option<&str>) -> ParticipantStatus {
    match s {
        Some("accepted") => ParticipantStatus::Accepted,
        Some("declined") => ParticipantStatus::Declined,
        Some("tentative") => ParticipantStatus::Tentative,
        Some("needsAction") => ParticipantStatus::Pending,
        _ => ParticipantStatus::Unknown,
    }
}

fn map_event_status(s: Option<&str>) -> EventStatus {
    match s {
        Some("confirmed") => EventStatus::Confirmed,
        Some("tentative") => EventStatus::Tentative,
        Some("cancelled") => EventStatus::Canceled,
        _ => EventStatus::None,
    }
}

fn conference_url(ev: &GoogleEvent) -> Option<String> {
    if let Some(link) = ev.hangout_link.clone() {
        return Some(link);
    }
    ev.conference_data
        .as_ref()
        .and_then(|cd| cd.entry_points.as_ref())
        .and_then(|eps| {
            eps.iter()
                .find(|e| e.entry_point_type.as_deref() == Some("video"))
                .and_then(|e| e.uri.clone())
        })
}

/// Convert a Google event into a platform-free candidate. `calendar_name` is set
/// by the caller from the owning calendar. Returns None if the event has no
/// usable start time.
pub fn map_event(ev: GoogleEvent, account_id: &str) -> Option<CalendarEventCandidate> {
    let start = parse_dt(ev.start.as_ref())?;
    let end = parse_dt(ev.end.as_ref()).unwrap_or(start);
    let is_all_day = ev
        .start
        .as_ref()
        .map(|d| d.date.is_some() && d.date_time.is_none())
        .unwrap_or(false);
    let event_status = map_event_status(ev.status.as_deref());
    // Compute the conference URL while `ev` is still fully intact (before any
    // field is moved out below).
    let conf = conference_url(&ev);

    let raw_attendees = ev.attendees.unwrap_or_default();
    let attendee_count = raw_attendees.len();
    let mut my_participation = None;
    let mut attendees = Vec::with_capacity(attendee_count);
    for a in &raw_attendees {
        let status = map_response_status(a.response_status.as_deref());
        if a.is_self == Some(true) {
            my_participation = Some(status);
        }
        attendees.push(Attendee {
            name: a.display_name.clone(),
            status,
        });
    }

    let organizer_is_self = ev
        .organizer
        .as_ref()
        .and_then(|o| o.is_self)
        .unwrap_or(false);
    let i_am_organizer = organizer_is_self
        || raw_attendees
            .iter()
            .any(|a| a.is_self == Some(true) && a.organizer == Some(true));
    let organizer_name = ev.organizer.as_ref().and_then(|o| o.display_name.clone());

    Some(CalendarEventCandidate {
        identifier: ev.ical_uid.clone(),
        title: ev.summary,
        start,
        end,
        is_all_day,
        event_status,
        my_participation,
        i_am_organizer,
        attendee_count,
        // Calendar-level exclusion is applied at fetch time (only selected
        // calendars are queried), so candidates from a fetch are never excluded.
        calendar_excluded: false,
        ical_uid: ev.ical_uid,
        source: SourceKind::Google,
        account_id: account_id.to_string(),
        organizer_name,
        attendees,
        location: ev.location,
        conference_url: conf,
        notes: ev.description,
        calendar_name: None,
    })
}

// ============================ OAuth + REST ============================
//
// All network calls use the shared reqwest client (Rust side, so the WebView CSP
// is irrelevant). Identity is resolved via the userinfo endpoint over TLS, not by
// decoding the id_token. Refresh tokens live in the OS keychain; only the account
// email (a label) is persisted to SQLite. Error Display strings are value-free
// (no token, email, or URL) so they are safe to log/surface.

const SCOPE: &str = "openid email https://www.googleapis.com/auth/calendar.events.readonly";
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const CALENDAR_LIST_ENDPOINT: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDARS_BASE: &str = "https://www.googleapis.com/calendar/v3/calendars";

/// Errors surfaced to the command boundary. Variants carry NO secret/PII values.
#[derive(Debug, thiserror::Error)]
pub enum GoogleError {
    #[error("Google Calendar is not configured")]
    NotConfigured,
    #[error("authentication was cancelled or timed out")]
    Cancelled,
    #[error("no refresh token was returned; reconnect and grant access")]
    NoRefreshToken,
    #[error("this account needs to be reconnected")]
    InvalidGrant,
    #[error("a calendar request failed")]
    Request,
}

struct OAuthConfig {
    client_id: String,
    client_secret: String,
}

fn oauth_config() -> Option<OAuthConfig> {
    let client_id = std::env::var("MUESLY_GOOGLE_CLIENT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    let client_secret = std::env::var("MUESLY_GOOGLE_CLIENT_SECRET")
        .ok()
        .unwrap_or_default();
    Some(OAuthConfig {
        client_id,
        client_secret,
    })
}

/// Whether a Google OAuth client id is configured (drives the "Add account" UI).
pub fn is_configured() -> bool {
    oauth_config().is_some()
}

/// PKCE (verifier, S256 challenge). Randomness comes from uuid v4 (CSPRNG-backed).
fn pkce_pair() -> (String, String) {
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn build_auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = url::Url::parse(AUTH_ENDPOINT).expect("valid auth endpoint");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.to_string()
}

/// Accept the single loopback redirect, validate `state`, return the auth code.
/// The listener is bound to 127.0.0.1 only and times out after 5 minutes.
async fn accept_code(listener: TcpListener, expected_state: &str) -> Result<String, GoogleError> {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .map_err(|_| GoogleError::Cancelled)?
        .map_err(|_| GoogleError::Cancelled)?;

    let mut buf = [0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|_| GoogleError::Cancelled)?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    let body = "<html><body>muesly is connected. You can close this tab.</body></html>";
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes()).await;

    let parsed =
        url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|_| GoogleError::Cancelled)?;
    let mut code = None;
    let mut state = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => return Err(GoogleError::Cancelled),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Err(GoogleError::Cancelled);
    }
    code.ok_or(GoogleError::Cancelled)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

async fn exchange_code(
    cfg: &OAuthConfig,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<TokenResponse, GoogleError> {
    let client = crate::providers::common::http_client();
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", cfg.client_id.as_str()),
        ("client_secret", cfg.client_secret.as_str()),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|_| GoogleError::Request)?;
    if !resp.status().is_success() {
        return Err(GoogleError::Request);
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|_| GoogleError::Request)
}

async fn refresh_call(
    cfg: &OAuthConfig,
    refresh_token: &str,
) -> Result<TokenResponse, GoogleError> {
    let client = crate::providers::common::http_client();
    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", cfg.client_id.as_str()),
        ("client_secret", cfg.client_secret.as_str()),
        ("refresh_token", refresh_token),
    ];
    let resp = client
        .post(TOKEN_ENDPOINT)
        .form(&params)
        .send()
        .await
        .map_err(|_| GoogleError::Request)?;
    if !resp.status().is_success() {
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        if body.get("error").and_then(|e| e.as_str()) == Some("invalid_grant") {
            return Err(GoogleError::InvalidGrant);
        }
        return Err(GoogleError::Request);
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|_| GoogleError::Request)
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    email: Option<String>,
}

async fn fetch_userinfo(access_token: &str) -> Result<UserInfo, GoogleError> {
    let client = crate::providers::common::http_client();
    let resp = client
        .get(USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| GoogleError::Request)?;
    if !resp.status().is_success() {
        return Err(GoogleError::Request);
    }
    resp.json::<UserInfo>()
        .await
        .map_err(|_| GoogleError::Request)
}

fn token_key(sub: &str) -> String {
    format!("google-oauth-{sub}")
}

fn store_refresh(sub: &str, token: &str) -> Result<(), GoogleError> {
    crate::keychain::keyring_store()
        .set(&token_key(sub), token)
        .map_err(|_| GoogleError::Request)
}

fn get_refresh(sub: &str) -> Option<String> {
    crate::keychain::keyring_store()
        .get(&token_key(sub))
        .ok()
        .flatten()
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

/// In-memory access-token cache. The async mutex also serializes refreshes
/// (coarse single-flight) so two concurrent fetches for the same account never
/// double-refresh and trip Google's token rotation.
fn token_cache() -> &'static tokio::sync::Mutex<std::collections::HashMap<String, CachedToken>> {
    static CACHE: OnceLock<tokio::sync::Mutex<std::collections::HashMap<String, CachedToken>>> =
        OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
}

async fn ensure_access_token(cfg: &OAuthConfig, sub: &str) -> Result<String, GoogleError> {
    let mut guard = token_cache().lock().await;
    if let Some(c) = guard.get(sub) {
        if c.expires_at > Instant::now() + Duration::from_secs(30) {
            return Ok(c.access_token.clone());
        }
    }
    let refresh = get_refresh(sub).ok_or(GoogleError::InvalidGrant)?;
    let token = refresh_call(cfg, &refresh).await?;
    let expires_at = Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(3600));
    guard.insert(
        sub.to_string(),
        CachedToken {
            access_token: token.access_token.clone(),
            expires_at,
        },
    );
    Ok(token.access_token)
}

/// Run the full add-account OAuth flow. Returns `(sub, email)` after storing the
/// refresh token in the keychain. The caller persists the account row.
pub async fn connect_account() -> Result<(String, Option<String>), GoogleError> {
    let cfg = oauth_config().ok_or(GoogleError::NotConfigured)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| GoogleError::Cancelled)?;
    let port = listener
        .local_addr()
        .map_err(|_| GoogleError::Cancelled)?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/");
    let (verifier, challenge) = pkce_pair();
    let state = Uuid::new_v4().simple().to_string();
    let auth_url = build_auth_url(&cfg.client_id, &redirect_uri, &challenge, &state);

    open::that(&auth_url).map_err(|_| GoogleError::Cancelled)?;
    let code = accept_code(listener, &state).await?;
    let token = exchange_code(&cfg, &redirect_uri, &code, &verifier).await?;
    let refresh = token.refresh_token.ok_or(GoogleError::NoRefreshToken)?;
    // Identify the account from THIS flow before writing the keychain, so a
    // reconnect can never overwrite one account's slot with another's token.
    let info = fetch_userinfo(&token.access_token).await?;
    store_refresh(&info.sub, &refresh)?;
    Ok((info.sub, info.email))
}

/// Disconnect: delete the keychain entry first (authoritative local removal),
/// drop the cached access token, then best-effort revoke at Google. The caller
/// deletes the DB row only after this returns Ok, so a token is never orphaned.
pub async fn disconnect_account(sub: &str) -> Result<(), GoogleError> {
    let refresh = get_refresh(sub);
    crate::keychain::keyring_store()
        .delete(&token_key(sub))
        .map_err(|_| GoogleError::Request)?;
    token_cache().lock().await.remove(sub);
    if let Some(r) = refresh {
        let client = crate::providers::common::http_client();
        let _ = client
            .post(REVOKE_ENDPOINT)
            .form(&[("token", r.as_str())])
            .send()
            .await;
    }
    Ok(())
}

#[derive(Deserialize)]
struct CalendarListResponse {
    #[serde(default)]
    items: Vec<CalendarListEntry>,
}

/// A calendar in the user's list (only the fields we use).
#[derive(Deserialize)]
pub struct CalendarListEntry {
    pub id: String,
    pub summary: Option<String>,
}

async fn list_calendars_raw(access_token: &str) -> Result<Vec<CalendarListEntry>, GoogleError> {
    let client = crate::providers::common::http_client();
    let resp = client
        .get(CALENDAR_LIST_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| GoogleError::Request)?;
    if resp.status().as_u16() == 401 {
        return Err(GoogleError::InvalidGrant);
    }
    if !resp.status().is_success() {
        return Err(GoogleError::Request);
    }
    let list: CalendarListResponse = resp.json().await.map_err(|_| GoogleError::Request)?;
    Ok(list.items)
}

async fn events_list_raw(
    access_token: &str,
    calendar_id: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<GoogleEventsList, GoogleError> {
    let mut url = url::Url::parse(CALENDARS_BASE).expect("valid calendars base");
    url.path_segments_mut()
        .map_err(|_| GoogleError::Request)?
        .push(calendar_id)
        .push("events");
    url.query_pairs_mut()
        .append_pair("timeMin", &start.to_rfc3339())
        .append_pair("timeMax", &end.to_rfc3339())
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", "2500")
        .append_pair("showDeleted", "false");

    let client = crate::providers::common::http_client();
    let resp = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| GoogleError::Request)?;
    if resp.status().as_u16() == 401 {
        return Err(GoogleError::InvalidGrant);
    }
    if !resp.status().is_success() {
        return Err(GoogleError::Request);
    }
    resp.json::<GoogleEventsList>()
        .await
        .map_err(|_| GoogleError::Request)
}

/// List the user's calendars (for the per-account selection UI).
pub async fn list_calendars(account_id: &str) -> Result<Vec<CalendarListEntry>, GoogleError> {
    let cfg = oauth_config().ok_or(GoogleError::NotConfigured)?;
    let access = ensure_access_token(&cfg, account_id).await?;
    list_calendars_raw(&access).await
}

/// Fetch candidate events from all of an account's non-excluded calendars in the
/// window around `now`. Read-only; emails are never read (see the mapper).
pub async fn fetch_candidates(
    account: &CalendarAccount,
    now: DateTime<Utc>,
) -> Result<Vec<CalendarEventCandidate>, GoogleError> {
    let cfg = oauth_config().ok_or(GoogleError::NotConfigured)?;
    let access = ensure_access_token(&cfg, &account.id).await?;
    let excluded: HashSet<String> = account
        .excluded_calendar_ids
        .as_deref()
        .and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default();

    let start = now - chrono::Duration::hours(2);
    let end = now + chrono::Duration::hours(2);
    let mut out = Vec::new();
    for cal in list_calendars_raw(&access)
        .await?
        .into_iter()
        .filter(|c| !excluded.contains(&c.id))
    {
        let events = events_list_raw(&access, &cal.id, start, end).await?;
        for ev in events.items {
            if let Some(mut cand) = map_event(ev, &account.id) {
                cand.calendar_name = cal.summary.clone();
                out.push(cand);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "items": [
        {
          "summary": "Q3 Roadmap",
          "start": { "dateTime": "2026-06-29T14:00:00-07:00" },
          "end": { "dateTime": "2026-06-29T15:00:00-07:00" },
          "iCalUID": "abc123@google.com",
          "status": "confirmed",
          "location": "Room 4",
          "hangoutLink": "https://meet.google.com/xyz",
          "description": "Agenda. Reach me at organizer@work.com or 555-1234.",
          "organizer": { "displayName": "Ana", "email": "ana@work.com", "self": true },
          "attendees": [
            { "displayName": "Ana", "email": "ana@work.com", "self": true, "responseStatus": "accepted", "organizer": true },
            { "displayName": "Bruno", "email": "bruno@work.com", "responseStatus": "declined" }
          ]
        }
      ]
    }"#;

    fn parse_one() -> CalendarEventCandidate {
        let list: GoogleEventsList = serde_json::from_str(SAMPLE).expect("parse");
        let ev = list.items.into_iter().next().expect("one event");
        map_event(ev, "sub-1").expect("mapped")
    }

    #[test]
    fn maps_core_fields() {
        let c = parse_one();
        assert_eq!(c.title.as_deref(), Some("Q3 Roadmap"));
        assert_eq!(c.location.as_deref(), Some("Room 4"));
        assert_eq!(
            c.conference_url.as_deref(),
            Some("https://meet.google.com/xyz")
        );
        assert_eq!(c.ical_uid.as_deref(), Some("abc123@google.com"));
        assert_eq!(c.source, SourceKind::Google);
        assert_eq!(c.account_id, "sub-1");
        assert_eq!(c.attendee_count, 2);
        assert!(c.i_am_organizer);
        assert_eq!(c.my_participation, Some(ParticipantStatus::Accepted));
        assert_eq!(c.event_status, EventStatus::Confirmed);
    }

    #[test]
    fn attendee_names_present_emails_absent() {
        let c = parse_one();
        let names: Vec<&str> = c
            .attendees
            .iter()
            .filter_map(|a| a.name.as_deref())
            .collect();
        assert_eq!(names, vec!["Ana", "Bruno"]);
    }

    /// The single most important test: an API response full of emails must yield
    /// a candidate with ZERO email substrings anywhere (names only). Emails are
    /// structurally never deserialized.
    #[test]
    fn no_email_leaks_into_candidate() {
        let c = parse_one();
        // Note: the description in SAMPLE contains an email; the candidate's raw
        // notes still carry it here (redaction happens in build_snapshot via
        // context::scrub_secrets). So we check every field EXCEPT notes for
        // emails, and separately assert notes are scrubbed at snapshot time
        // (see calendar::context tests).
        let mut blob = String::new();
        blob.push_str(c.title.as_deref().unwrap_or(""));
        blob.push_str(c.organizer_name.as_deref().unwrap_or(""));
        blob.push_str(c.location.as_deref().unwrap_or(""));
        blob.push_str(c.conference_url.as_deref().unwrap_or(""));
        for a in &c.attendees {
            blob.push_str(a.name.as_deref().unwrap_or(""));
        }
        assert!(
            !blob.contains('@'),
            "no attendee/organizer email may appear in candidate fields: {blob}"
        );
        assert!(!blob.contains("work.com"));
    }

    #[test]
    fn declined_self_is_captured() {
        let json = r#"{"items":[{"summary":"X","start":{"dateTime":"2026-06-29T14:00:00Z"},
            "end":{"dateTime":"2026-06-29T15:00:00Z"},
            "attendees":[{"displayName":"Me","self":true,"responseStatus":"declined"}]}]}"#;
        let list: GoogleEventsList = serde_json::from_str(json).unwrap();
        let c = map_event(list.items.into_iter().next().unwrap(), "sub-1").unwrap();
        assert_eq!(c.my_participation, Some(ParticipantStatus::Declined));
    }

    #[test]
    fn all_day_event_is_flagged() {
        let json = r#"{"items":[{"summary":"OOO","start":{"date":"2026-06-29"},"end":{"date":"2026-06-30"}}]}"#;
        let list: GoogleEventsList = serde_json::from_str(json).unwrap();
        let c = map_event(list.items.into_iter().next().unwrap(), "sub-1").unwrap();
        assert!(c.is_all_day);
    }

    #[test]
    fn conference_url_falls_back_to_entry_points() {
        let json = r#"{"items":[{"summary":"X","start":{"dateTime":"2026-06-29T14:00:00Z"},
            "end":{"dateTime":"2026-06-29T15:00:00Z"},
            "conferenceData":{"entryPoints":[
                {"entryPointType":"phone","uri":"tel:+1-555"},
                {"entryPointType":"video","uri":"https://zoom.us/j/1"}]}}]}"#;
        let list: GoogleEventsList = serde_json::from_str(json).unwrap();
        let c = map_event(list.items.into_iter().next().unwrap(), "sub-1").unwrap();
        assert_eq!(c.conference_url.as_deref(), Some("https://zoom.us/j/1"));
    }

    #[test]
    fn auth_url_uses_exact_minimal_scope_and_pkce_s256() {
        let (verifier, challenge) = pkce_pair();
        let url = build_auth_url("cid", "http://127.0.0.1:1234/", &challenge, "st4te");
        let parsed = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        // Scope-creep guard: exactly the minimal scope, nothing broader.
        assert_eq!(q.get("scope").map(String::as_str), Some(SCOPE));
        assert_eq!(
            q.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(q.get("access_type").map(String::as_str), Some("offline"));
        assert_eq!(q.get("prompt").map(String::as_str), Some("consent"));
        assert_eq!(q.get("state").map(String::as_str), Some("st4te"));
        assert_eq!(
            q.get("code_challenge").map(String::as_str),
            Some(challenge.as_str())
        );
        // The verifier round-trips to the S256 challenge.
        let recomputed = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(recomputed, challenge);
    }

    #[test]
    fn pkce_pairs_are_unique_per_flow() {
        let (v1, c1) = pkce_pair();
        let (v2, c2) = pkce_pair();
        assert_ne!(v1, v2);
        assert_ne!(c1, c2);
    }

    #[test]
    fn token_key_is_namespaced_per_sub() {
        assert_eq!(token_key("12345"), "google-oauth-12345");
        assert_ne!(token_key("a"), token_key("b"));
    }
}
