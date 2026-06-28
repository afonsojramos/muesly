//! High-level calendar coordination: resolve the meeting happening at an
//! instant, build/persist snapshots, and render the redacted summary block.
//! Every public entry point degrades to `None`/`false` on failure - calendar
//! work must never block a recording or a summary.

use crate::calendar::matching::{self, CalendarEventCandidate, MatchConfidence, ParticipantStatus};
use crate::calendar::{context, eventkit, CalendarAuthStatus};
use crate::database::models::CalendarEvent;
use crate::database::repositories::calendar::CalendarEventsRepository;
use crate::database::repositories::setting::SettingsRepository;
use crate::summary::llm_client::LLMProvider;
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use std::collections::HashSet;

#[derive(serde::Serialize)]
struct AttendeePayload {
    name: Option<String>,
    status: String,
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

/// The user's excluded-calendar id set (best-effort).
async fn excluded_ids(pool: &SqlitePool) -> HashSet<String> {
    SettingsRepository::get_calendar_excluded_ids(pool)
        .await
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
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
    if eventkit::authorization_status() != CalendarAuthStatus::Granted {
        return None;
    }
    let excluded = excluded_ids(pool).await;
    let candidates = eventkit::fetch_candidates(now, &excluded);
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
        })
        .collect();
    let attendees_json = serde_json::to_string(&attendees).ok();
    let notes = c
        .notes
        .as_deref()
        .map(|n| context::cap_notes(&context::scrub_secrets(n), context::MAX_NOTES_CHARS));

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
        source: "eventkit".to_string(),
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
    let excluded = excluded_ids(pool).await;
    let candidates = eventkit::fetch_candidates(instant, &excluded);
    let m = match matching::match_event(&candidates, instant) {
        Some(m) => m,
        None => return Ok(false),
    };
    let snapshot = build_snapshot(meeting_id, &candidates[m.index], m.confidence);
    CalendarEventsRepository::upsert(pool, &snapshot)
        .await
        .map_err(|e| e.to_string())
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
