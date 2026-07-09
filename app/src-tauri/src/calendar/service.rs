//! High-level calendar coordination: resolve the meeting happening at an
//! instant, build/persist snapshots, and render the redacted summary block.
//! Every public entry point degrades to `None`/`false` on failure - calendar
//! work must never block a recording or a summary.

use crate::calendar::matching::{self, CalendarEventCandidate, MatchConfidence, ParticipantStatus};
use crate::calendar::{context, dedup, eventkit, google, CalendarAuthStatus, SourceKind};
use crate::database::models::{CalendarAccount, CalendarEvent};
use crate::database::repositories::calendar::CalendarEventsRepository;
use crate::database::repositories::calendar_accounts::CalendarAccountsRepository;
use crate::database::repositories::calendar_event_rules::CalendarEventRulesRepository;
use crate::database::repositories::folders::FoldersRepository;
use crate::database::repositories::setting::SettingsRepository;
use crate::summary::llm_client::LLMProvider;
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::time::Duration;

#[derive(serde::Serialize)]
struct AttendeePayload {
    name: Option<String>,
    status: String,
    /// Whether this attendee is the local user. Persisted so the speaker-naming
    /// layer can exclude "you" and auto-fill the single remote attendee. Boolean
    /// only - still no email.
    is_self: bool,
}

fn participant_status_str(s: ParticipantStatus) -> &'static str {
    match s {
        ParticipantStatus::Accepted => "accepted",
        ParticipantStatus::Tentative => "tentative",
        ParticipantStatus::Pending => "pending",
        ParticipantStatus::Declined => "declined",
        ParticipantStatus::Unknown => "unknown",
    }
}

/// Parse an account's excluded-calendar id set (best-effort).
fn excluded_set(account: &CalendarAccount) -> HashSet<String> {
    account
        .excluded_calendar_ids
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

/// Fetch candidates from every enabled source, then de-duplicate across sources
/// (the dedup runs before the matcher, see `dedup`). Each source is isolated:
/// a failure yields an empty `Vec` for that source and never affects others or
/// blocks a recording. (Chunk A: EventKit only; Google accounts are added in
/// the OAuth chunk, where the loop also parallelizes via per-source timeouts.)
pub(crate) async fn fetch_all_candidates(
    pool: &SqlitePool,
    now: DateTime<Utc>,
) -> Vec<CalendarEventCandidate> {
    let accounts = CalendarAccountsRepository::list(pool)
        .await
        .unwrap_or_default();
    let mut all = Vec::new();
    for account in accounts.iter().filter(|a| a.enabled) {
        // Each source is time-bounded and isolated; a failure yields an empty Vec
        // for that source and never affects others. (Sequential for now; parallel
        // join across accounts is a follow-up.)
        match account.source.as_str() {
            "eventkit" => all.append(&mut fetch_eventkit(account, now).await),
            "google" => all.append(&mut fetch_google(pool, account, now).await),
            _ => {}
        }
    }
    dedup::dedupe(all)
}

/// EventKit fetch for one account, off the async reactor and time-bounded.
/// Returns empty on missing permission, timeout, or a worker panic.
async fn fetch_eventkit(
    account: &CalendarAccount,
    now: DateTime<Utc>,
) -> Vec<CalendarEventCandidate> {
    if eventkit::authorization_status() != CalendarAuthStatus::Granted {
        return Vec::new();
    }
    let excluded = excluded_set(account);
    let fut = tokio::task::spawn_blocking(move || eventkit::fetch_candidates(now, &excluded));
    match tokio::time::timeout(Duration::from_secs(3), fut).await {
        Ok(Ok(v)) => v,
        _ => Vec::new(),
    }
}

/// Google fetch for one account, time-bounded. On `invalid_grant` (dead refresh
/// token) the account is flagged `reauth_required` and an empty Vec returned;
/// any other failure (timeout, network) leaves status untouched and degrades to
/// empty so a transient blip never marks a healthy account as broken.
async fn fetch_google(
    pool: &SqlitePool,
    account: &CalendarAccount,
    now: DateTime<Utc>,
) -> Vec<CalendarEventCandidate> {
    match tokio::time::timeout(
        Duration::from_secs(3),
        google::fetch_candidates(account, now),
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(google::GoogleError::InvalidGrant)) => {
            let mut flagged = account.clone();
            flagged.status = Some("reauth_required".to_string());
            let _ = CalendarAccountsRepository::upsert(pool, &flagged).await;
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// Outcome of resolving the event at an instant: the matched candidate plus how
/// confident the match is.
pub struct ResolvedEvent {
    pub candidate: CalendarEventCandidate,
    pub confidence: MatchConfidence,
}

impl ResolvedEvent {
    /// The title to apply to a recording, only for high-confidence matches.
    pub fn title_for_high_confidence(&self) -> Option<&str> {
        if matches!(self.confidence, MatchConfidence::High) {
            self.candidate.title.as_deref()
        } else {
            None
        }
    }
}

/// Resolve the calendar event happening at `now`, honouring the enable flag and
/// read permission. Returns `None` on any failure or no match.
pub async fn resolve_event_for_instant(
    pool: &SqlitePool,
    now: DateTime<Utc>,
) -> Option<ResolvedEvent> {
    if !SettingsRepository::get_calendar_context_enabled(pool)
        .await
        .unwrap_or(false)
    {
        return None;
    }
    let candidates = fetch_all_candidates(pool, now).await;
    let m = matching::match_event(&candidates, now)?;
    Some(ResolvedEvent {
        candidate: candidates[m.index].clone(),
        confidence: m.confidence,
    })
}

/// Build a persistable snapshot from a matched candidate. Notes are
/// secret-scrubbed and length-capped here so the stored value is already safe.
pub fn build_snapshot(
    meeting_id: &str,
    c: &CalendarEventCandidate,
    confidence: MatchConfidence,
) -> CalendarEvent {
    let attendees: Vec<AttendeePayload> = c
        .attendees
        .iter()
        .map(|a| AttendeePayload {
            name: a.name.clone(),
            status: participant_status_str(a.status).to_string(),
            is_self: a.is_self,
        })
        .collect();
    let attendees_json = serde_json::to_string(&attendees).ok();
    let notes = c
        .notes
        .as_deref()
        .map(|n| context::cap_notes(&context::scrub_secrets(n), context::MAX_NOTES_CHARS));
    let source = match c.source {
        SourceKind::EventKit => "eventkit",
        SourceKind::Google => "google",
    }
    .to_string();

    CalendarEvent {
        meeting_id: meeting_id.to_string(),
        event_identifier: c.identifier.clone(),
        occurrence_start: Some(c.start.to_rfc3339()),
        title: c.title.clone(),
        start_time: Some(c.start.to_rfc3339()),
        end_time: Some(c.end.to_rfc3339()),
        organizer_name: c.organizer_name.clone(),
        attendees_json,
        location: c.location.clone(),
        conference_url: c.conference_url.clone(),
        notes,
        calendar_name: c.calendar_name.clone(),
        source,
        account_id: Some(c.account_id.clone()),
        ical_uid: c.ical_uid.clone(),
        match_confidence: confidence.as_str().to_string(),
        created_at: Utc::now(),
    }
}

/// Resolve the event for `instant` and persist its snapshot for `meeting_id`.
/// Used after a recording is saved (the meetings row now exists) and for manual
/// re-attach. Returns whether a snapshot was attached.
pub async fn attach_event_for_meeting(
    pool: &SqlitePool,
    meeting_id: &str,
    instant: DateTime<Utc>,
) -> Result<bool, String> {
    let candidates = fetch_all_candidates(pool, instant).await;
    let m = match matching::match_event(&candidates, instant) {
        Some(m) => m,
        None => return Ok(false),
    };
    let cand = &candidates[m.index];
    let snapshot = build_snapshot(meeting_id, cand, m.confidence);
    CalendarEventsRepository::upsert(pool, &snapshot)
        .await
        .map_err(|e| e.to_string())?;
    // Apply any folder the user pre-assigned to this event (or its series).
    if let Some(uid) = cand.ical_uid.as_deref() {
        apply_folder_rule(pool, meeting_id, uid, dedup::minute_bucket(cand.start)).await;
    }
    Ok(true)
}

/// Move a freshly-recorded meeting into the folder the user pre-assigned to its
/// calendar event (or the event's series), if any. Best-effort and independent of
/// the calendar-context toggle: a missing/errored rule must never block or fail a
/// recording. `ical_uid` is normalized here, so callers may pass it raw.
pub async fn apply_folder_rule(
    pool: &SqlitePool,
    meeting_id: &str,
    ical_uid: &str,
    occurrence_minute: i64,
) {
    let uid = dedup::norm_uid(ical_uid);
    match CalendarEventRulesRepository::folder_for(pool, &uid, occurrence_minute).await {
        Ok(Some(folder_id)) => {
            if let Err(e) =
                FoldersRepository::set_meeting_folder(pool, meeting_id, Some(&folder_id)).await
            {
                log::warn!("apply_folder_rule: set_meeting_folder failed: {e}");
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("apply_folder_rule: rule lookup failed: {e}"),
    }
}

/// Build the redacted `<meeting_context>` block for a meeting, honouring the
/// resolved provider's egress and the user's cloud toggles. `None` when there is
/// no snapshot or nothing to include. Never errors into summarization.
pub async fn meeting_context_block(
    pool: &SqlitePool,
    meeting_id: &str,
    provider: &LLMProvider,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
) -> Option<String> {
    let event = CalendarEventsRepository::get(pool, meeting_id)
        .await
        .ok()
        .flatten()?;
    let egress = provider.data_egress(ollama_endpoint, custom_openai_endpoint);
    let send_names = SettingsRepository::get_calendar_send_attendee_names_to_cloud(pool)
        .await
        .unwrap_or(false);
    let send_notes = SettingsRepository::get_calendar_send_notes_to_cloud(pool)
        .await
        .unwrap_or(false);
    context::render_meeting_context(&event, egress, send_names, send_notes)
}

/// A lightweight event for the settings "upcoming events" preview, so the user
/// can confirm a source is being read. Attendee names/notes are not included.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PreviewEvent {
    pub title: String,
    pub start: String,
    /// RFC3339 end, when known — bounds the home "Start" button's actionable window.
    pub end: Option<String>,
    pub source: String,
    pub calendar_name: Option<String>,
    /// Series/occurrence identity for pre-assign-to-folder and the scheduler.
    pub ical_uid: Option<String>,
    /// `minute_bucket(start)` — the stable per-occurrence key shared with the rules
    /// table and the scheduler.
    pub occurrence_minute: i64,
    /// Part of a recurring series — gates the "Auto-add future meetings?" prompt.
    pub is_recurring: bool,
    /// Parsed conference/meeting URL (Zoom/Meet/Teams/…), when present.
    pub conference_url: Option<String>,
}

/// Fetch upcoming events (roughly the next day) from all enabled sources,
/// deduped and sorted. Best-effort: a failing source contributes nothing.
pub async fn preview_upcoming(pool: &SqlitePool, now: DateTime<Utc>) -> Vec<PreviewEvent> {
    let start = now - chrono::Duration::hours(1);
    let end = now + chrono::Duration::hours(24);
    let accounts = CalendarAccountsRepository::list(pool)
        .await
        .unwrap_or_default();
    let mut all = Vec::new();
    for account in accounts.iter().filter(|a| a.enabled) {
        match account.source.as_str() {
            "eventkit" => {
                if eventkit::authorization_status() == CalendarAuthStatus::Granted {
                    let excluded = excluded_set(account);
                    let fut = tokio::task::spawn_blocking(move || {
                        eventkit::fetch_candidates_in(start, end, &excluded)
                    });
                    if let Ok(Ok(mut v)) = tokio::time::timeout(Duration::from_secs(5), fut).await {
                        all.append(&mut v);
                    }
                }
            }
            "google" => {
                if let Ok(Ok(mut v)) = tokio::time::timeout(
                    Duration::from_secs(8),
                    google::fetch_in_window(account, start, end),
                )
                .await
                {
                    all.append(&mut v);
                }
            }
            _ => {}
        }
    }
    let mut deduped = dedup::dedupe(all);
    deduped.sort_by_key(|c| c.start);
    deduped
        .into_iter()
        .map(|c| PreviewEvent {
            occurrence_minute: dedup::minute_bucket(c.start),
            title: c.title.unwrap_or_else(|| "(no title)".to_string()),
            start: c.start.to_rfc3339(),
            end: Some(c.end.to_rfc3339()),
            source: match c.source {
                SourceKind::EventKit => "eventkit",
                SourceKind::Google => "google",
            }
            .to_string(),
            calendar_name: c.calendar_name,
            ical_uid: c.ical_uid,
            is_recurring: c.is_recurring,
            conference_url: c.conference_url,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::matching::{Attendee, EventStatus};

    #[test]
    fn attendee_payload_persists_is_self_flag() {
        let payload = AttendeePayload {
            name: Some("Ana".to_string()),
            status: "accepted".to_string(),
            is_self: true,
        };
        let json = serde_json::to_string(&payload).expect("serialize");
        assert!(json.contains(r#""is_self":true"#), "got: {json}");
        assert!(!json.contains("@"), "no email is ever serialized");
    }

    #[test]
    fn build_snapshot_threads_is_self_per_attendee() {
        let now = Utc::now();
        let candidate = CalendarEventCandidate {
            identifier: None,
            title: Some("Sync".to_string()),
            start: now,
            end: now,
            is_all_day: false,
            is_recurring: false,
            event_status: EventStatus::Confirmed,
            my_participation: Some(ParticipantStatus::Accepted),
            i_am_organizer: false,
            attendee_count: 2,
            calendar_excluded: false,
            ical_uid: None,
            source: SourceKind::Google,
            account_id: "acct".to_string(),
            organizer_name: Some("Ana".to_string()),
            attendees: vec![
                Attendee {
                    name: Some("Ana".to_string()),
                    status: ParticipantStatus::Accepted,
                    is_self: true,
                },
                Attendee {
                    name: Some("Bruno".to_string()),
                    status: ParticipantStatus::Accepted,
                    is_self: false,
                },
            ],
            location: None,
            conference_url: None,
            notes: None,
            calendar_name: None,
        };

        let snapshot = build_snapshot("m1", &candidate, MatchConfidence::High);
        let parsed = context::snapshot_attendees(&snapshot);
        assert_eq!(parsed.len(), 2);
        let ana = parsed.iter().find(|a| a.name.as_deref() == Some("Ana")).unwrap();
        let bruno = parsed.iter().find(|a| a.name.as_deref() == Some("Bruno")).unwrap();
        assert!(ana.is_self, "the self attendee must round-trip as is_self");
        assert!(!bruno.is_self, "a remote attendee must not be marked self");
    }
}
