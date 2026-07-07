//! Pure, platform-free event-to-now matching.
//!
//! `eventkit.rs` converts each `EKEvent` into a [`CalendarEventCandidate`]; this
//! module never touches Objective-C types, so the whole algorithm is unit-testable
//! on any platform (including CI Linux). All fields the matcher needs that can
//! only be resolved inside EventKit (the current user's participation status,
//! whether the user is the organizer, whether the owning calendar is excluded)
//! are pre-computed and carried on the candidate.

use chrono::{DateTime, Duration, Utc};
use std::cmp::Ordering;

/// How long before an event's start it is still considered "now" (handles
/// joining a meeting early). Joining late is already inside the window.
const EARLY_JOIN_GRACE_MINUTES: i64 = 15;

/// Per-attendee participation status, as reported by EventKit (`EKParticipantStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ParticipantStatus {
    Accepted,
    Tentative,
    Pending,
    Declined,
    Unknown,
}

/// Organizer-set event status (`EKEventStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStatus {
    None,
    Confirmed,
    Tentative,
    Canceled,
}

/// A single attendee, names only - emails never reach this layer.
#[derive(Debug, Clone)]
pub struct Attendee {
    pub name: Option<String>,
    pub status: ParticipantStatus,
}

/// A platform-free candidate event. Carries both the fields needed to match and
/// the payload needed to build the persisted snapshot, so there is one
/// representation rather than two.
#[derive(Debug, Clone)]
pub struct CalendarEventCandidate {
    pub identifier: Option<String>,
    pub title: Option<String>,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub is_all_day: bool,
    /// Part of a recurring series (any occurrence). Drives the "Auto-add future
    /// meetings?" prompt. Carried through, not used for scoring.
    pub is_recurring: bool,
    pub event_status: EventStatus,
    /// The current user's participation status, or None when the event has no
    /// attendees (a solo block) - resolvable only inside EventKit.
    pub my_participation: Option<ParticipantStatus>,
    /// Whether the current user is the organizer (organizers are often absent
    /// from the attendees array, so this must be tracked separately).
    pub i_am_organizer: bool,
    pub attendee_count: usize,
    /// Whether the owning calendar is on the user's exclusion list.
    pub calendar_excluded: bool,
    // ---- dedup / attribution (carried through, NOT used for scoring) ----
    /// Cross-system UID (EventKit external id / Google iCalUID).
    pub ical_uid: Option<String>,
    /// Which source produced this candidate.
    pub source: crate::calendar::SourceKind,
    /// The owning account id ("eventkit-local" or a Google sub).
    pub account_id: String,
    // ---- snapshot payload (carried through, not used for scoring) ----
    pub organizer_name: Option<String>,
    pub attendees: Vec<Attendee>,
    pub location: Option<String>,
    pub conference_url: Option<String>,
    pub notes: Option<String>,
    pub calendar_name: Option<String>,
}

/// Confidence in the chosen event. High auto-applies the title; Low keeps the
/// timestamp title and only suggests the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchConfidence {
    High,
    Low,
}

impl MatchConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchConfidence::High => "high",
            MatchConfidence::Low => "low",
        }
    }
}

/// The matcher's result: which candidate, and how confident.
#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub index: usize,
    pub confidence: MatchConfidence,
}

/// Whether the user actively declined the event. Organizers never count as
/// declined; an event with no attendees cannot be declined.
fn is_declined(c: &CalendarEventCandidate) -> bool {
    if c.i_am_organizer {
        return false;
    }
    matches!(c.my_participation, Some(ParticipantStatus::Declined))
}

fn is_multi_day(c: &CalendarEventCandidate) -> bool {
    (c.end - c.start) > Duration::hours(24)
}

/// Whether a candidate could be "the meeting happening now".
fn is_eligible(c: &CalendarEventCandidate, now: DateTime<Utc>) -> bool {
    if c.is_all_day || c.calendar_excluded || is_multi_day(c) {
        return false;
    }
    if matches!(c.event_status, EventStatus::Canceled) || is_declined(c) {
        return false;
    }
    let grace = Duration::minutes(EARLY_JOIN_GRACE_MINUTES);
    now >= c.start - grace && now <= c.end
}

fn participation_rank(c: &CalendarEventCandidate) -> u8 {
    if c.i_am_organizer {
        return 3;
    }
    match c.my_participation {
        Some(ParticipantStatus::Accepted) => 3,
        Some(ParticipantStatus::Tentative) => 2,
        _ => 1,
    }
}

/// Time component of the score. Any already-started event outranks any
/// not-yet-started one; among started events the most recently started wins
/// (the current meeting in a back-to-back pair); among not-started events the
/// soonest to begin wins.
fn time_score(c: &CalendarEventCandidate, now: DateTime<Utc>) -> f64 {
    if c.start <= now {
        1_000_000_000.0 + c.start.timestamp() as f64
    } else {
        -((c.start - now).num_seconds() as f64)
    }
}

/// Lexicographic score key: participation, then has-attendees, then time, then
/// attendee count as the final tie-break.
fn score_key(c: &CalendarEventCandidate, now: DateTime<Utc>) -> (u8, u8, f64, usize) {
    (
        participation_rank(c),
        u8::from(c.attendee_count > 0),
        time_score(c, now),
        c.attendee_count,
    )
}

fn cmp_keys(a: (u8, u8, f64, usize), b: (u8, u8, f64, usize)) -> Ordering {
    a.0.cmp(&b.0)
        .then(a.1.cmp(&b.1))
        .then(a.2.partial_cmp(&b.2).unwrap_or(Ordering::Equal))
        .then(a.3.cmp(&b.3))
}

/// Pick the calendar event happening at `now`, if any. Returns the index into
/// `candidates` of the chosen event plus a confidence level.
pub fn match_event(candidates: &[CalendarEventCandidate], now: DateTime<Utc>) -> Option<Match> {
    let eligible: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| is_eligible(c, now))
        .map(|(i, _)| i)
        .collect();

    if eligible.is_empty() {
        return None;
    }

    let best = *eligible.iter().max_by(|&&a, &&b| {
        cmp_keys(
            score_key(&candidates[a], now),
            score_key(&candidates[b], now),
        )
    })?;

    let c = &candidates[best];
    let accepted =
        c.i_am_organizer || matches!(c.my_participation, Some(ParticipantStatus::Accepted));
    let overlaps_now = c.start <= now && now <= c.end;
    let confidence = if eligible.len() == 1 && accepted && c.attendee_count > 0 && overlaps_now {
        MatchConfidence::High
    } else {
        MatchConfidence::Low
    };

    Some(Match {
        index: best,
        confidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 6, 28, h, m, 0).unwrap()
    }

    /// A confirmed, accepted, multi-attendee meeting from `start` to `end`.
    fn meeting(start: DateTime<Utc>, end: DateTime<Utc>, title: &str) -> CalendarEventCandidate {
        CalendarEventCandidate {
            identifier: Some(format!("id-{title}")),
            title: Some(title.to_string()),
            start,
            end,
            is_all_day: false,
            is_recurring: false,
            event_status: EventStatus::Confirmed,
            my_participation: Some(ParticipantStatus::Accepted),
            i_am_organizer: false,
            attendee_count: 3,
            calendar_excluded: false,
            ical_uid: Some(format!("uid-{title}")),
            source: crate::calendar::SourceKind::EventKit,
            account_id: "eventkit-local".to_string(),
            organizer_name: Some("Ana".to_string()),
            attendees: vec![Attendee {
                name: Some("Ana".to_string()),
                status: ParticipantStatus::Accepted,
            }],
            location: None,
            conference_url: None,
            notes: None,
            calendar_name: Some("Work".to_string()),
        }
    }

    #[test]
    fn no_candidates_returns_none() {
        assert!(match_event(&[], at(14, 0)).is_none());
    }

    #[test]
    fn single_confirmed_overlapping_is_high_confidence() {
        let c = vec![meeting(at(14, 0), at(15, 0), "Standup")];
        let m = match_event(&c, at(14, 10)).expect("match");
        assert_eq!(m.index, 0);
        assert_eq!(m.confidence, MatchConfidence::High);
    }

    #[test]
    fn all_day_is_excluded() {
        let mut c = meeting(at(0, 0), at(23, 59), "OOO");
        c.is_all_day = true;
        assert!(match_event(&[c], at(14, 0)).is_none());
    }

    #[test]
    fn multi_day_is_excluded() {
        let c = vec![CalendarEventCandidate {
            end: at(14, 0) + Duration::hours(48),
            ..meeting(at(14, 0), at(15, 0), "Conf week")
        }];
        assert!(match_event(&c, at(14, 30)).is_none());
    }

    #[test]
    fn canceled_is_excluded() {
        let mut c = meeting(at(14, 0), at(15, 0), "Canceled");
        c.event_status = EventStatus::Canceled;
        assert!(match_event(&[c], at(14, 10)).is_none());
    }

    #[test]
    fn declined_is_excluded_but_organizer_is_not() {
        let mut declined = meeting(at(14, 0), at(15, 0), "Declined");
        declined.my_participation = Some(ParticipantStatus::Declined);
        declined.i_am_organizer = false;
        assert!(match_event(&[declined], at(14, 10)).is_none());

        // Same status but I'm the organizer → not declined, still matches.
        let mut organizer = meeting(at(14, 0), at(15, 0), "My meeting");
        organizer.my_participation = Some(ParticipantStatus::Declined);
        organizer.i_am_organizer = true;
        assert!(match_event(&[organizer], at(14, 10)).is_some());
    }

    #[test]
    fn excluded_calendar_is_ignored() {
        let mut c = meeting(at(14, 0), at(15, 0), "Holiday");
        c.calendar_excluded = true;
        assert!(match_event(&[c], at(14, 10)).is_none());
    }

    #[test]
    fn solo_block_matches_but_is_low_confidence() {
        let mut c = meeting(at(14, 0), at(15, 0), "Focus time");
        c.attendee_count = 0;
        c.attendees.clear();
        c.my_participation = None;
        let m = match_event(&[c], at(14, 10)).expect("match");
        assert_eq!(m.confidence, MatchConfidence::Low);
    }

    #[test]
    fn back_to_back_prefers_current_before_boundary() {
        // A: 13:00-14:00, B: 14:00-15:00. At 13:58 prefer A (in progress).
        let c = vec![
            meeting(at(13, 0), at(14, 0), "A"),
            meeting(at(14, 0), at(15, 0), "B"),
        ];
        let m = match_event(&c, at(13, 58)).expect("match");
        assert_eq!(c[m.index].title.as_deref(), Some("A"));
        // Ambiguous (B is eligible within grace) → low confidence.
        assert_eq!(m.confidence, MatchConfidence::Low);
    }

    #[test]
    fn back_to_back_prefers_next_after_boundary() {
        // At 14:01 A has ended (out of window), B is current.
        let c = vec![
            meeting(at(13, 0), at(14, 0), "A"),
            meeting(at(14, 0), at(15, 0), "B"),
        ];
        let m = match_event(&c, at(14, 1)).expect("match");
        assert_eq!(c[m.index].title.as_deref(), Some("B"));
        assert_eq!(m.confidence, MatchConfidence::High);
    }

    #[test]
    fn early_join_within_grace_matches_but_low_confidence() {
        // Recording 10 min before a meeting that hasn't started: eligible, but
        // not overlapping now → low confidence.
        let c = vec![meeting(at(14, 0), at(15, 0), "Soon")];
        let m = match_event(&c, at(13, 50)).expect("match");
        assert_eq!(m.confidence, MatchConfidence::Low);
    }

    #[test]
    fn outside_grace_window_does_not_match() {
        let c = vec![meeting(at(14, 0), at(15, 0), "Later")];
        // 20 min before start, grace is 15 min.
        assert!(match_event(&c, at(13, 40)).is_none());
    }

    #[test]
    fn accepted_outranks_tentative() {
        let accepted = meeting(at(13, 30), at(15, 0), "Accepted");
        let mut tentative = meeting(at(13, 30), at(15, 0), "Tentative");
        tentative.my_participation = Some(ParticipantStatus::Tentative);
        let c = vec![tentative, accepted];
        let m = match_event(&c, at(14, 0)).expect("match");
        assert_eq!(c[m.index].title.as_deref(), Some("Accepted"));
    }
}
