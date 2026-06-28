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
    "passcode", "password", "pwd=", "pin:", "dial-in", "dial in", "one tap",
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

/// Drop lines that look like they carry a conferencing secret, strip any
/// `?pwd=`/`&pwd=` query fragment, and redact email addresses. Google event
/// descriptions (and auto-generated Meet blurbs) frequently embed organizer/
/// attendee emails, which must never reach a cloud LLM.
pub fn scrub_secrets(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let lower = line.to_lowercase();
            !SECRET_MARKERS.iter().any(|m| lower.contains(m))
        })
        .map(strip_pwd_query)
        .map(|line| redact_emails(&line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replace email-shaped whitespace tokens with `[email]`. Conservative: a token
/// counts as an email if it has a non-empty local part, an `@`, and a dotted
/// domain. URLs (no `@`) and plain words are left untouched.
fn redact_emails(line: &str) -> String {
    line.split(' ')
        .map(|tok| {
            if looks_like_email(tok) {
                "[email]"
            } else {
                tok
            }
            .to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn looks_like_email(tok: &str) -> bool {
    let t = tok
        .trim_matches(|c: char| !c.is_alphanumeric() && !matches!(c, '@' | '.' | '-' | '_' | '+'));
    match t.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        }
        None => false,
    }
}

fn strip_pwd_query(line: &str) -> String {
    // Remove "?pwd=..."/"&pwd=..." up to the next whitespace. The markers are
    // ASCII, so search the ORIGINAL bytes case-insensitively: lowercasing the
    // whole line first would yield byte offsets that drift for non-ASCII text
    // (e.g. 'İ'), leaking the secret and risking a non-char-boundary panic.
    let mut out = line.to_string();
    for sep in ["?pwd=", "&pwd=", "?pin=", "&pin="] {
        if let Some(idx) = out
            .as_bytes()
            .windows(sep.len())
            .position(|w| w.eq_ignore_ascii_case(sep.as_bytes()))
        {
            let end = out[idx..]
                .find(char::is_whitespace)
                .unwrap_or(out.len() - idx);
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

/// Conferencing hosts whose links carry personal meeting IDs / passcodes and so
/// must be withheld from remote prompts even when they appear in `location`.
const CONF_HOSTS: [&str; 5] = [
    "zoom.us",
    "meet.google.com",
    "teams.microsoft.com",
    "webex.com",
    "whereby.com",
];

fn looks_like_conference(s: &str) -> bool {
    let lower = s.to_lowercase();
    CONF_HOSTS.iter().any(|h| lower.contains(h))
}

/// Make a `location` value safe for remote egress: drop it entirely if it
/// carries a conference link (same treatment as the conference URL), else strip
/// any secret markers / pwd query. Returns None when nothing safe remains.
fn safe_location_for_remote(loc: &str) -> Option<String> {
    if looks_like_conference(loc) {
        return None;
    }
    let cleaned = strip_pwd_query(&scrub_secrets(loc));
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
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
            // For remote egress, a location that is/holds a conference link is
            // withheld (like the conference URL) and any secrets are scrubbed.
            let rendered = if remote {
                safe_location_for_remote(loc)
            } else {
                Some(loc.to_string())
            };
            if let Some(loc) = rendered {
                lines.push(format!("Location: {loc}"));
            }
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
            account_id: Some("eventkit-local".into()),
            ical_uid: Some("UID-1".into()),
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
    fn remote_strips_conference_link_and_secrets_in_location() {
        // A join link with a passcode in the Location field must not reach a
        // remote provider, even with both toggles off.
        let mut e = event();
        e.location = Some("https://zoom.us/j/812345?pwd=secret".into());
        let block = render_meeting_context(&e, Egress::Remote, true, true).unwrap();
        assert!(!block.contains("zoom.us"));
        assert!(!block.contains("812345"));
        assert!(!block.contains("pwd=secret"));

        // A plain physical location is still fine and a passcode line is dropped.
        let mut e2 = event();
        e2.location = Some("Room 4, Passcode 9988".into());
        let block2 = render_meeting_context(&e2, Egress::Remote, false, false).unwrap();
        assert!(!block2.to_lowercase().contains("passcode"));

        // Local egress keeps the full location.
        let block3 = render_meeting_context(&e, Egress::Local, false, false).unwrap();
        assert!(block3.contains("zoom.us"));
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
    fn scrub_redacts_email_addresses() {
        let raw = "Agenda discussion. Contact organizer@work.com, also bruno@x.io for details.";
        let scrubbed = scrub_secrets(raw);
        assert!(
            !scrubbed.contains('@'),
            "emails must be redacted: {scrubbed}"
        );
        assert!(!scrubbed.contains("work.com"));
        assert!(scrubbed.contains("[email]"));
        assert!(scrubbed.contains("Agenda discussion"));
    }

    #[test]
    fn scrub_leaves_non_email_at_and_urls_alone() {
        // A URL without an '@' is untouched; the word stays readable.
        let raw = "Join https://meet.google.com/abc for the sync";
        let scrubbed = scrub_secrets(raw);
        assert!(scrubbed.contains("https://meet.google.com/abc"));
    }

    #[test]
    fn strip_pwd_query_handles_non_ascii_prefix_without_panic_or_leak() {
        // A non-ASCII char before the marker whose lowercase has a different byte
        // length must not break byte offsets (would leak the secret or panic).
        let line = "İ meeting https://zoom.us/j/1?pwd=secret end";
        let out = strip_pwd_query(line);
        assert!(!out.contains("pwd=secret"));
        assert!(!out.contains("secret"));
        assert!(out.contains("İ meeting"));
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
