// Adaptive ("always detect, force-on-disagreement, switch-on-sustained")
// language state for Whisper auto language detection.
//
// When the transcription language preference is `auto` (keep original language),
// whisper.cpp would otherwise re-detect the spoken language on EVERY audio
// segment. For a single-language meeting that flaps: short or ambiguous
// utterances occasionally get transcribed in the wrong language. The old design
// detected the language once and hard-locked it. That is rock-solid for
// single-language audio but cannot follow a genuine mid-recording language
// switch.
//
// This adaptive version is a two-phase state machine:
//
// 1. `Deciding` — the initial phase. It runs the same voting as before to pick a
//    `stable` language from the first few seconds of real speech, and while
//    deciding it lets each segment transcribe in its own detected language.
// 2. `Locked` — once a `stable` language is chosen, every later segment is
//    re-checked against it. Disagreements force the segment back to `stable`
//    (preventing per-segment flapping), but a `challenger` language that wins
//    `SWITCH_THRESHOLD` consecutive valid (>= 2 s, non-negative) segments
//    genuinely switches `stable`. Hysteresis: a single odd detection is
//    absorbed, sustained evidence is followed.
//
// The state machine is a process-global behind a `Mutex`. The transcription
// worker runs multiple segments in parallel, so `resolve_detection` may be
// called concurrently; critical sections are tiny.

use std::sync::Mutex;

/// Minimum audio length (in 16 kHz samples) for a detection to count toward a
/// decision. Short segments are unreliable language detectors. 16_000 * 2 == 2 s.
const MIN_VOTE_SAMPLES: usize = 16_000 * 2;

/// Number of votes after which the `Deciding` phase falls back to a plurality
/// decision if no language has yet reached the fast-path threshold.
const PLURALITY_THRESHOLD: usize = 4;

/// Number of agreeing votes that immediately locks a language during `Deciding`.
const MAJORITY_VOTES: usize = 2;

/// Consecutive valid (>= 2 s, non-negative) segments that all detect the SAME
/// new language before `stable` switches to it.
///
/// This is the hysteresis knob: it trades responsiveness against robustness
/// against false positives. `3` requires roughly six seconds of sustained
/// disagreement (three >= 2 s segments) before following a switch. Lower would
/// chase momentary mis-detections (e.g. a single foreign-language quote);
/// higher would lag noticeably behind a genuine speaker/language change.
const SWITCH_THRESHOLD: u32 = 3;

/// The two phases of the adaptive language state machine.
enum LangLock {
    /// Initial phase: still picking the first `stable` language by voting.
    ///
    /// `votes` are kept in arrival order so plurality ties resolve to the
    /// earliest-seen id. Only >= 2 s, non-negative detections are pushed here.
    Deciding { votes: Vec<i32> },
    /// Locked onto `stable`. `challenger` tracks a candidate replacement language
    /// as `(candidate_id, consecutive_count)`: the number of consecutive valid
    /// disagreeing segments that all detected `candidate_id`.
    Locked {
        stable: i32,
        challenger: Option<(i32, u32)>,
    },
}

/// What the caller should do with the current segment after `resolve`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LangDecision {
    /// Emit the `set_language(None)` (auto-detected) result as-is.
    UseDetected,
    /// Re-transcribe this segment forced to the given language id, and emit that.
    ForceStable(i32),
}

impl LangLock {
    /// `const fn` so the global `Mutex` can be initialised in a `static`.
    /// `Vec::new()` does not allocate, which keeps this usable in a const context.
    const fn new() -> Self {
        Self::Deciding { votes: Vec::new() }
    }

    /// Clear all state so a new transcription session starts fresh.
    fn reset(&mut self) {
        *self = Self::Deciding { votes: Vec::new() };
    }

    /// The active stable language id, if one has been decided.
    fn stable_id(&self) -> Option<i32> {
        match self {
            Self::Deciding { .. } => None,
            Self::Locked { stable, .. } => Some(*stable),
        }
    }

    /// Advance the state machine with one per-segment auto-detection result and
    /// return what the caller should do with this segment.
    ///
    /// `detected_id` is whisper's detected language id for this segment (negative
    /// on a failed detection). `sample_count` is the segment length in 16 kHz
    /// samples; detections under `MIN_VOTE_SAMPLES` (2 s) are treated as
    /// unreliable.
    fn resolve(&mut self, detected_id: i32, sample_count: usize) -> LangDecision {
        match self {
            Self::Deciding { votes } => {
                // Same voting policy as the old lock: only >= 2 s, non-negative
                // detections vote. Anything decided here transitions to `Locked`.
                if detected_id >= 0 && sample_count >= MIN_VOTE_SAMPLES {
                    votes.push(detected_id);

                    // Fast path: any language with >= 2 agreeing votes wins.
                    let mut decided: Option<i32> = None;
                    for &candidate in votes.iter() {
                        if votes.iter().filter(|&&v| v == candidate).count() >= MAJORITY_VOTES {
                            decided = Some(candidate);
                            break;
                        }
                    }
                    // Plurality fallback after enough votes with no clear majority.
                    if decided.is_none() && votes.len() >= PLURALITY_THRESHOLD {
                        decided = Self::plurality(votes);
                    }

                    if let Some(stable) = decided {
                        *self = Self::Locked {
                            stable,
                            challenger: None,
                        };
                    }
                }
                // While deciding, transcribe each segment in its detected language.
                LangDecision::UseDetected
            }
            Self::Locked { stable, challenger } => {
                if detected_id == *stable {
                    // Agreement: any pending challenge collapses.
                    *challenger = None;
                    return LangDecision::UseDetected;
                }

                // Disagreement. A short or failed detection is too weak to either
                // advance OR reset the challenger; just force the stable language.
                if detected_id < 0 || sample_count < MIN_VOTE_SAMPLES {
                    return LangDecision::ForceStable(*stable);
                }

                // Valid (>= 2 s, non-negative) disagreement: advance hysteresis.
                match challenger {
                    Some((cand, n)) if *cand == detected_id => {
                        let next = *n + 1;
                        if next >= SWITCH_THRESHOLD {
                            // Sustained evidence: follow the switch. THIS segment's
                            // detected result is already in the new stable language.
                            *self = Self::Locked {
                                stable: detected_id,
                                challenger: None,
                            };
                            LangDecision::UseDetected
                        } else {
                            *challenger = Some((detected_id, next));
                            LangDecision::ForceStable(*stable)
                        }
                    }
                    // No challenger yet, or a different challenger id: start a new
                    // streak at 1.
                    _ => {
                        *challenger = Some((detected_id, 1));
                        LangDecision::ForceStable(*stable)
                    }
                }
            }
        }
    }

    /// The most frequent vote, breaking ties in favour of the earliest-seen id.
    ///
    /// Iterating `votes` in order and only replacing the best candidate on a
    /// strictly greater count means the first id to reach a given count wins,
    /// which gives the earliest-seen tie-break for free.
    fn plurality(votes: &[i32]) -> Option<i32> {
        let mut best: Option<(i32, usize)> = None;
        for &candidate in votes {
            let count = votes.iter().filter(|&&v| v == candidate).count();
            match best {
                Some((_, best_count)) if count <= best_count => {}
                _ => best = Some((candidate, count)),
            }
        }
        best.map(|(id, _)| id)
    }
}

/// Process-global session language state. Reset at the start of every
/// transcription session (recording, import, retranscription).
static LANG_LOCK: Mutex<LangLock> = Mutex::new(LangLock::new());

/// Reset the session language state so a stale lock never leaks across
/// recordings or into an import/retranscription run.
pub fn reset_session_detected_language() {
    // A poisoned lock here is non-fatal (the data is just a small tally), so
    // recover the guard rather than propagating a panic into the audio pipeline.
    let mut guard = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    guard.reset();
}

/// The currently stable whisper language id, or `None` if not yet decided.
/// Exposed for logging.
pub fn current_stable() -> Option<i32> {
    let guard = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    guard.stable_id()
}

/// Advance the adaptive state machine with a per-segment auto-detection result.
///
/// Returns the [`LangDecision`] the caller should act on: either emit the
/// detected result as-is, or re-transcribe forced to the stable language id.
pub fn resolve_detection(detected_id: i32, sample_count: usize) -> LangDecision {
    let mut guard = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    guard.resolve(detected_id, sample_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_SECONDS: usize = MIN_VOTE_SAMPLES;
    const ONE_SECOND: usize = 16_000;

    /// Helper: drive a fresh lock to `Locked { stable }` via the initial vote.
    fn locked_on(stable: i32) -> LangLock {
        let mut lock = LangLock::new();
        assert_eq!(lock.resolve(stable, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), None, "one vote must not lock");
        assert_eq!(lock.resolve(stable, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(stable));
        lock
    }

    #[test]
    fn locks_after_two_agreeing_long_detections() {
        // Two agreeing >= 2 s detections still lock, returning UseDetected while
        // deciding.
        let mut lock = LangLock::new();
        assert_eq!(lock.resolve(5, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), None, "one vote must not lock");
        assert_eq!(lock.resolve(5, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(5));
    }

    #[test]
    fn ignores_sub_two_second_detections_while_deciding() {
        let mut lock = LangLock::new();
        // Two agreeing detections, but both under 2 s: never lock.
        lock.resolve(5, ONE_SECOND);
        lock.resolve(5, ONE_SECOND);
        assert_eq!(lock.stable_id(), None);
    }

    #[test]
    fn ignores_negative_ids_while_deciding() {
        let mut lock = LangLock::new();
        lock.resolve(-1, TWO_SECONDS);
        lock.resolve(-1, TWO_SECONDS);
        assert_eq!(lock.stable_id(), None);
    }

    #[test]
    fn locks_plurality_after_four_votes_without_majority() {
        let mut lock = LangLock::new();
        // ids 1, 2, 3 once each, then 2 again as the 4th vote. The 2nd `2`
        // reaches the majority threshold first.
        lock.resolve(1, TWO_SECONDS);
        lock.resolve(2, TWO_SECONDS);
        lock.resolve(3, TWO_SECONDS);
        lock.resolve(2, TWO_SECONDS);
        assert_eq!(lock.stable_id(), Some(2));
    }

    #[test]
    fn locks_earliest_plurality_on_tie() {
        // Four distinct ids: majority never triggers, plurality decides at vote 4,
        // all tied at one vote so earliest (7) wins.
        let mut lock = LangLock::new();
        lock.resolve(7, TWO_SECONDS);
        lock.resolve(8, TWO_SECONDS);
        lock.resolve(9, TWO_SECONDS);
        lock.resolve(10, TWO_SECONDS);
        assert_eq!(lock.stable_id(), Some(7));
    }

    #[test]
    fn matching_detection_while_locked_uses_detected() {
        let mut lock = locked_on(5);
        assert_eq!(lock.resolve(5, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(5));
    }

    #[test]
    fn single_long_disagreement_forces_stable_without_switching() {
        let mut lock = locked_on(5);
        // One valid >= 2 s disagreement: forced back to stable, no switch.
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.stable_id(), Some(5));
    }

    #[test]
    fn matching_detection_resets_challenger() {
        let mut lock = locked_on(5);
        // Build up two of three needed challenger hits...
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        // ...then a matching detection collapses the challenge.
        assert_eq!(lock.resolve(5, TWO_SECONDS), LangDecision::UseDetected);
        // A fresh disagreement starts the streak over (still at 1, no switch).
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.stable_id(), Some(5));
    }

    #[test]
    fn sustained_disagreement_switches_stable() {
        let mut lock = locked_on(5);
        // SWITCH_THRESHOLD (3) consecutive valid >= 2 s detections of the same new
        // id. The first two force stable; the third switches and uses detected.
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(9), "stable switched to the challenger");
        // And the new stable holds: a matching detection uses detected.
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::UseDetected);
    }

    #[test]
    fn short_disagreement_forces_stable_without_advancing_challenger() {
        let mut lock = locked_on(5);
        // One valid disagreement sets challenger to (9, 1).
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        // A sub-2 s disagreement of the same id forces stable but does NOT advance
        // the challenger: it neither counts nor resets.
        assert_eq!(lock.resolve(9, ONE_SECOND), LangDecision::ForceStable(5));
        // Two more valid hits are still needed to switch (proving the short one
        // did not advance the count): the 2nd valid hit forces, the 3rd switches.
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(9));
    }

    #[test]
    fn negative_disagreement_forces_stable_without_advancing_challenger() {
        let mut lock = locked_on(5);
        // A negative-id detection while locked is a disagreement with stable, but
        // too weak to advance/reset the challenger; it just forces stable.
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(-1, TWO_SECONDS), LangDecision::ForceStable(5));
        // Challenger still at 1: two more valid hits switch.
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(9));
    }

    #[test]
    fn different_challenger_id_restarts_streak() {
        let mut lock = locked_on(5);
        // Challenger 9 reaches count 2...
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(9, TWO_SECONDS), LangDecision::ForceStable(5));
        // ...then a different id 7 resets the streak to (7, 1).
        assert_eq!(lock.resolve(7, TWO_SECONDS), LangDecision::ForceStable(5));
        // So id 7 needs two more valid hits to switch.
        assert_eq!(lock.resolve(7, TWO_SECONDS), LangDecision::ForceStable(5));
        assert_eq!(lock.resolve(7, TWO_SECONDS), LangDecision::UseDetected);
        assert_eq!(lock.stable_id(), Some(7));
    }

    #[test]
    fn reset_returns_to_deciding() {
        let mut lock = locked_on(5);
        lock.reset();
        assert_eq!(lock.stable_id(), None, "reset returns to Deciding");
        // And voting works again from scratch.
        lock.resolve(8, TWO_SECONDS);
        lock.resolve(8, TWO_SECONDS);
        assert_eq!(lock.stable_id(), Some(8));
    }
}
