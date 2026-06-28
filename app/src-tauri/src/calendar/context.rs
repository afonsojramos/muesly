//! Rendering the `<meeting_context>` prompt block from a stored snapshot, with
//! egress-aware redaction. Pure and unit-testable.
//!
//! The redaction rules are the privacy boundary:
//! - Emails are never present (they are never stored).
//! - For `Remote` egress: attendee/organizer names are off unless `send_names`,
//!   notes are off unless `send_notes`, and the conference URL is always stripped
//!   (it can embed personal meeting IDs / passcodes).
//! - For `Local` egress: everything stored is included.

use crate::database::models::CalendarEvent;
use crate::summary::llm_client::Egress;

/// Cap applied to notes so a multi-KB legal footer cannot dominate the prompt.
pub const MAX_NOTES_CHARS: usize = 1500;

/// Case-insensitive markers that flag a notes line as carrying a secret
/// (conferencing passcode, dial-in PIN, etc.) - such lines are dropped.
const SECRET_MARKERS: [&str; 7] = [
    "passcode",
    "password",
    "pwd=",
    "pin:",
    "dial-in",
    "dial in",
    "one tap",
];

#[derive(serde::Serialize, serde::Deserialize)]
struct AttendeeEntry {
    name: Option<String>,
    #[allow(dead_code)]
    status: Option<String>,
}

fn attendee_names(event: &CalendarEvent) -> Option<String> {
    let json = event.attendees_json.as_deref()?;
    let entries: Vec<AttendeeEntry> = serde_json::from_str(json).ok()?;
    let names: Vec<String> = entries
        .into_iter()
        .filter_map(|e| e.name)
        .filter(|n| !n.trim().is_empty())
        .collect();
    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

/// Drop lines that look like they carry a conferencing secret. Also strips any
/// `?pwd=`/`&pwd=` query fragment from surviving lines.
pub fn scrub_secrets(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let lower = line.to_lowercase();
            !SECRET_MARKERS.iter().any(|m| lower.contains(m))
        })
        .map(strip_pwd_query)
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_pwd_query(line: &str) -> String {
    // Remove "?pwd=..."/"&pwd=..." up to the next whitespace.
    let mut out = line.to_string();
    for sep in ["?pwd=", "&pwd=", "?pin=", "&pin="] {
        if let Some(idx) = out.to_lowercase().find(sep) {
            let tail = &out[idx..];
            let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
            out.replace_range(idx..idx + end, "");
        }
    }
    out
}

/// Truncate to at most `max` characters on a char boundary, appending an
/// ellipsis when truncated.
pub fn cap_notes(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max).collect();
    format!("{truncated}…")
}

/// Build the `<meeting_context>` block, or `None` when there's nothing to add.
pub fn render_meeting_context(
    event: &CalendarEvent,
    egress: Egress,
    send_names: bool,
    send_notes: bool,
) -> Option<String> {
    let remote = matches!(egress, Egress::Remote);
    let mut lines: Vec<String> = Vec::new();

    if let Some(t) = event.title.as_deref() {
        if !t.is_empty() {
            lines.push(format!("Title: {t}"));
        }
    }
    match (event.start_time.as_deref(), event.end_time.as_deref()) {
        (Some(s), Some(e)) => lines.push(format!("Time: {s} to {e}")),
        (Some(s), None) => lines.push(format!("Time: {s}")),
        _ => {}
    }
    if let Some(loc) = event.location.as_deref() {
        if !loc.is_empty() {
            lines.push(format!("Location: {loc}"));
        }
    }

    // Conference URL: local only - it can embed personal meeting IDs/passcodes.
    if !remote {
        if let Some(url) = event.conference_url.as_deref() {
            if !url.is_empty() {
                lines.push(format!("Call link: {url}"));
            }
        }
    }

    // Names: local always; remote only when explicitly opted in.
    if !remote || send_names {
        if let Some(org) = event.organizer_name.as_deref() {
            if !org.is_empty() {
                lines.push(format!("Organizer: {org}"));
            }
        }
        if let Some(names) = attendee_names(event) {
            lines.push(format!("Attendees: {names}"));
        }
    }

    // Notes: local always; remote only when explicitly opted in. Stored notes are
    // already scrubbed/capped; re-cap defensively.
    if !remote || send_notes {
        if let Some(raw) = event.notes.as_deref() {
            let cleaned = cap_notes(raw, MAX_NOTES_CHARS);
            if !cleaned.trim().is_empty() {
                lines.push(format!("Agenda/Notes: {cleaned}"));
            }
        }
    }

    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "<meeting_context>\n{}\n</meeting_context>",
        lines.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn event() -> CalendarEvent {
        CalendarEvent {
            meeting_id: "m1".into(),
            event_identifier: None,
            occurrence_start: None,
            title: Some("Q3 Roadmap".into()),
            start_time: Some("2026-06-28T15:00:00Z".into()),
            end_time: Some("2026-06-28T16:00:00Z".into()),
            organizer_name: Some("Ana".into()),
            attendees_json: Some(
                r#"[{"name":"Ana","status":"accepted"},{"name":"Bruno","status":"accepted"}]"#
                    .into(),
            ),
            location: Some("Room 4".into()),
            conference_url: Some("https://zoom.us/j/123?pwd=secret".into()),
            notes: Some("Discuss roadmap".into()),
            calendar_name: Some("Work".into()),
            source: "eventkit".into(),
            match_confidence: "high".into(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn local_includes_names_notes_and_url() {
        let block = render_meeting_context(&event(), Egress::Local, false, false).unwrap();
        assert!(block.contains("Title: Q3 Roadmap"));
        assert!(block.contains("Organizer: Ana"));
        assert!(block.contains("Attendees: Ana, Bruno"));
        assert!(block.contains("Agenda/Notes: Discuss roadmap"));
        assert!(block.contains("Call link: https://zoom.us"));
    }

    #[test]
    fn remote_default_excludes_names_notes_and_url() {
        let block = render_meeting_context(&event(), Egress::Remote, false, false).unwrap();
        assert!(block.contains("Title: Q3 Roadmap"));
        assert!(block.contains("Location: Room 4"));
        // Names, notes, and the call link must be absent by default for remote.
        assert!(!block.contains("Ana"));
        assert!(!block.contains("Bruno"));
        assert!(!block.contains("Discuss roadmap"));
        assert!(!block.to_lowercase().contains("call link"));
        assert!(!block.contains("zoom.us"));
    }

    #[test]
    fn remote_includes_names_when_opted_in() {
        let block = render_meeting_context(&event(), Egress::Remote, true, false).unwrap();
        assert!(block.contains("Attendees: Ana, Bruno"));
        // Notes still excluded (separate toggle).
        assert!(!block.contains("Discuss roadmap"));
        // URL still stripped for remote regardless of name/note toggles.
        assert!(!block.contains("zoom.us"));
    }

    #[test]
    fn remote_includes_notes_when_opted_in() {
        let block = render_meeting_context(&event(), Egress::Remote, false, true).unwrap();
        assert!(block.contains("Agenda/Notes: Discuss roadmap"));
        assert!(!block.contains("Ana"));
    }

    #[test]
    fn scrub_drops_secret_lines_and_pwd_query() {
        let raw = "Join the call\nPasscode: 998877\nAgenda item one\nLink https://zoom.us/j/1?pwd=abc tail";
        let scrubbed = scrub_secrets(raw);
        assert!(!scrubbed.to_lowercase().contains("passcode"));
        assert!(scrubbed.contains("Agenda item one"));
        assert!(!scrubbed.contains("pwd=abc"));
        assert!(scrubbed.contains("Join the call"));
    }

    #[test]
    fn cap_notes_truncates_on_char_boundary() {
        let long = "a".repeat(5000);
        let capped = cap_notes(&long, MAX_NOTES_CHARS);
        assert!(capped.chars().count() <= MAX_NOTES_CHARS + 1);
        assert!(capped.ends_with('…'));
    }

    #[test]
    fn empty_event_renders_none() {
        let mut e = event();
        e.title = None;
        e.start_time = None;
        e.end_time = None;
        e.location = None;
        e.conference_url = None;
        e.organizer_name = None;
        e.attendees_json = None;
        e.notes = None;
        assert!(render_meeting_context(&e, Egress::Local, true, true).is_none());
    }
}
