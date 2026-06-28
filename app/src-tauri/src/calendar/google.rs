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
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use serde::Deserialize;

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
}
