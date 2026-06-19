//! Reconcile speaker turns from the diarization sidecar onto transcript segments.
//!
//! The sidecar returns speaker-labeled time turns over the whole recording. Each
//! transcript segment is assigned the speaker whose turn overlaps it the most.

/// A speaker active over `[start, end]` seconds of the recording.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpeakerTurn {
    pub start: f64,
    pub end: f64,
    pub speaker: i32,
}

/// Assign the best-overlapping speaker to a transcript segment spanning
/// `[seg_start, seg_end]` seconds. Returns `None` when no turn overlaps the
/// segment (e.g. silence the diarizer dropped), leaving the caller to fall back.
pub fn speaker_for_segment(seg_start: f64, seg_end: f64, turns: &[SpeakerTurn]) -> Option<i32> {
    let mut best: Option<(f64, i32)> = None;
    for turn in turns {
        let overlap = (seg_end.min(turn.end) - seg_start.max(turn.start)).max(0.0);
        if overlap <= 0.0 {
            continue;
        }
        // Strictly-greater keeps the earliest turn on ties, which is stable.
        if best.is_none_or(|(best_overlap, _)| overlap > best_overlap) {
            best = Some((overlap, turn.speaker));
        }
    }
    best.map(|(_, speaker)| speaker)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(start: f64, end: f64, speaker: i32) -> SpeakerTurn {
        SpeakerTurn { start, end, speaker }
    }

    #[test]
    fn picks_the_speaker_with_the_most_overlap() {
        let turns = [turn(0.0, 1.0, 0), turn(1.0, 5.0, 1)];
        // Segment [0.8, 3.0] overlaps speaker 0 by 0.2s and speaker 1 by 2.0s.
        assert_eq!(speaker_for_segment(0.8, 3.0, &turns), Some(1));
    }

    #[test]
    fn returns_none_when_no_turn_overlaps() {
        let turns = [turn(0.0, 1.0, 0)];
        assert_eq!(speaker_for_segment(2.0, 3.0, &turns), None);
    }

    #[test]
    fn empty_turns_yield_none() {
        assert_eq!(speaker_for_segment(0.0, 1.0, &[]), None);
    }

    #[test]
    fn earliest_speaker_wins_on_equal_overlap() {
        let turns = [turn(0.0, 2.0, 0), turn(2.0, 4.0, 1)];
        // Segment [1.0, 3.0] overlaps each speaker by exactly 1.0s.
        assert_eq!(speaker_for_segment(1.0, 3.0, &turns), Some(0));
    }

    #[test]
    fn fully_contained_segment_takes_its_enclosing_speaker() {
        let turns = [turn(0.0, 10.0, 3)];
        assert_eq!(speaker_for_segment(4.0, 5.0, &turns), Some(3));
    }
}
