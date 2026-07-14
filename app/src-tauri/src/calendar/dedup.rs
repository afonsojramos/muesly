//! Pure cross-source de-duplication. Runs BEFORE the matcher.
//!
//! Without this, a meeting present in both a Google account and its EventKit
//! mirror yields two eligible candidates, which trips matching's
//! `eligible.len() == 1` high-confidence rule and silently downgrades every
//! connected-account title to Low. Tier-1 keys on `(normalized iCalUID,
//! instance-start rounded to the minute)`; the Google copy wins over the
//! EventKit mirror; payload fields are filled from the loser but scoring fields
//! are never touched. The fuzzy tier (title+time+duration) is deferred, so
//! candidates without an iCalUID are kept distinct (biases toward two cards over
//! a false merge / lost meeting).

use crate::calendar::SourceKind;
use crate::calendar::matching::CalendarEventCandidate;
use chrono::{DateTime, Utc};
use std::collections::HashMap;

pub(crate) fn norm_uid(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Round to the minute so a Google `dateTime` (with offset) and an EventKit
/// instant (reconstructed from a float) for the same occurrence collapse. Also the
/// stable per-occurrence key used by the event→folder rules and the scheduler.
pub(crate) fn minute_bucket(dt: DateTime<Utc>) -> i64 {
    dt.timestamp().div_euclid(60)
}

fn is_google(c: &CalendarEventCandidate) -> bool {
    matches!(c.source, SourceKind::Google)
}

/// De-duplicate candidates across (and within) sources. Output is
/// deterministically ordered (by start, then account_id) so the matcher's
/// tie-breaks are reproducible.
pub fn dedupe(candidates: Vec<CalendarEventCandidate>) -> Vec<CalendarEventCandidate> {
    let mut keyed: HashMap<(String, i64), CalendarEventCandidate> = HashMap::new();
    let mut unkeyed: Vec<CalendarEventCandidate> = Vec::new();

    for c in candidates {
        let uid = c
            .ical_uid
            .as_deref()
            .map(norm_uid)
            .filter(|u| !u.is_empty());
        match uid {
            Some(uid) => {
                let key = (uid, minute_bucket(c.start));
                match keyed.remove(&key) {
                    Some(existing) => {
                        keyed.insert(key, merge(existing, c));
                    }
                    None => {
                        keyed.insert(key, c);
                    }
                }
            }
            // Tier-2 fuzzy deferred: without a UID, keep distinct.
            None => unkeyed.push(c),
        }
    }

    let mut out: Vec<CalendarEventCandidate> = keyed.into_values().chain(unkeyed).collect();
    out.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| a.account_id.cmp(&b.account_id))
    });
    out
}

/// Winner = Google over EventKit (otherwise keep `existing`); fill ONLY
/// snapshot-payload fields from the loser. Scoring fields (participation,
/// attendee_count, event_status, start/end) are never copied, so dedup cannot
/// change a match's confidence.
fn merge(
    existing: CalendarEventCandidate,
    incoming: CalendarEventCandidate,
) -> CalendarEventCandidate {
    let (mut winner, loser) = if is_google(&incoming) && !is_google(&existing) {
        (incoming, existing)
    } else {
        (existing, incoming)
    };
    fill_if_empty(&mut winner.organizer_name, loser.organizer_name);
    fill_if_empty(&mut winner.location, loser.location);
    fill_if_empty(&mut winner.conference_url, loser.conference_url);
    fill_if_empty(&mut winner.notes, loser.notes);
    fill_if_empty(&mut winner.calendar_name, loser.calendar_name);
    fill_if_empty(&mut winner.ical_uid, loser.ical_uid);
    // Recurrence from either source survives the merge (one source may omit it).
    winner.is_recurring = winner.is_recurring || loser.is_recurring;
    winner
}

fn fill_if_empty(target: &mut Option<String>, src: Option<String>) {
    let empty = target.as_deref().map(str::trim).unwrap_or("").is_empty();
    if empty {
        if let Some(v) = src {
            if !v.trim().is_empty() {
                *target = Some(v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::matching::{
        Attendee, EventStatus, MatchConfidence, ParticipantStatus, match_event,
    };
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 6, 29, h, m, 0).unwrap()
    }

    fn cand(
        uid: Option<&str>,
        start: DateTime<Utc>,
        source: SourceKind,
        account_id: &str,
        title: &str,
    ) -> CalendarEventCandidate {
        CalendarEventCandidate {
            identifier: Some(format!("{account_id}-{title}")),
            title: Some(title.to_string()),
            start,
            end: start + chrono::Duration::hours(1),
            is_all_day: false,
            is_recurring: false,
            event_status: EventStatus::Confirmed,
            my_participation: Some(ParticipantStatus::Accepted),
            i_am_organizer: false,
            attendee_count: 3,
            calendar_excluded: false,
            ical_uid: uid.map(|u| u.to_string()),
            source,
            account_id: account_id.to_string(),
            organizer_name: Some("Ana".to_string()),
            attendees: vec![Attendee {
                name: Some("Ana".to_string()),
                status: ParticipantStatus::Accepted,
                is_self: false,
            }],
            location: None,
            conference_url: None,
            notes: None,
            calendar_name: Some("Work".to_string()),
        }
    }

    #[test]
    fn duplicate_across_sources_collapses_to_one_and_keeps_high_confidence() {
        // Same meeting via Google OAuth and the EventKit mirror, same UID + start.
        let google = cand(
            Some("UID-1"),
            at(14, 0),
            SourceKind::Google,
            "sub-1",
            "Standup",
        );
        let eventkit = cand(
            Some("uid-1"),
            at(14, 0),
            SourceKind::EventKit,
            "eventkit-local",
            "Standup",
        );
        let deduped = dedupe(vec![eventkit, google]);
        assert_eq!(deduped.len(), 1, "duplicate must collapse to one");
        assert_eq!(deduped[0].source, SourceKind::Google, "Google copy wins");

        // The critical assertion: confidence is NOT downgraded by the duplicate.
        let m = match_event(&deduped, at(14, 10)).expect("match");
        assert_eq!(m.confidence, MatchConfidence::High);
    }

    #[test]
    fn eventkit_against_itself_is_deduped() {
        let a = cand(
            Some("UID-1"),
            at(14, 0),
            SourceKind::EventKit,
            "eventkit-local",
            "Standup",
        );
        let b = cand(
            Some("UID-1"),
            at(14, 0),
            SourceKind::EventKit,
            "eventkit-local",
            "Standup",
        );
        assert_eq!(dedupe(vec![a, b]).len(), 1);
    }

    #[test]
    fn back_to_back_same_uid_different_start_stay_distinct() {
        // Recurring occurrences share a UID but differ by start.
        let occ1 = cand(Some("UID-1"), at(14, 0), SourceKind::Google, "sub-1", "1:1");
        let occ2 = cand(
            Some("UID-1"),
            at(14, 30),
            SourceKind::Google,
            "sub-1",
            "1:1",
        );
        assert_eq!(dedupe(vec![occ1, occ2]).len(), 2);
    }

    #[test]
    fn missing_uid_keeps_candidates_distinct() {
        let a = cand(None, at(14, 0), SourceKind::Google, "sub-1", "A");
        let b = cand(None, at(14, 0), SourceKind::EventKit, "eventkit-local", "A");
        assert_eq!(
            dedupe(vec![a, b]).len(),
            2,
            "no UID => no merge (defer fuzzy)"
        );
    }

    #[test]
    fn merge_fills_payload_from_loser_but_preserves_winner_scoring() {
        // Google winner has empty location but attendee_count 3; EventKit loser
        // has a location and attendee_count 0. The merge must take the location
        // but keep the winner's attendee_count (a scoring field).
        let mut google = cand(
            Some("UID-1"),
            at(14, 0),
            SourceKind::Google,
            "sub-1",
            "Sync",
        );
        google.location = None;
        let mut eventkit = cand(
            Some("UID-1"),
            at(14, 0),
            SourceKind::EventKit,
            "eventkit-local",
            "Sync",
        );
        eventkit.location = Some("Room 4".to_string());
        eventkit.attendee_count = 0;

        let deduped = dedupe(vec![google, eventkit]);
        assert_eq!(deduped.len(), 1);
        let w = &deduped[0];
        assert_eq!(w.source, SourceKind::Google);
        assert_eq!(
            w.location.as_deref(),
            Some("Room 4"),
            "payload filled from loser"
        );
        assert_eq!(w.attendee_count, 3, "winner scoring field preserved");
    }

    #[test]
    fn output_is_deterministically_ordered_by_start() {
        let later = cand(Some("U2"), at(15, 0), SourceKind::Google, "sub-1", "B");
        let earlier = cand(Some("U1"), at(14, 0), SourceKind::Google, "sub-1", "A");
        let out = dedupe(vec![later, earlier]);
        assert_eq!(out[0].start, at(14, 0));
        assert_eq!(out[1].start, at(15, 0));
    }
}
