// "Detect once and lock" language state for Whisper auto language detection.
//
// When the transcription language preference is `auto` / `auto-translate`,
// whisper.cpp would otherwise re-detect the spoken language on EVERY audio
// segment. For a single-language meeting that flaps: short or ambiguous
// utterances occasionally get transcribed in the wrong language. To avoid that
// we detect the language from the first few seconds of real speech, lock it,
// and reuse that locked language for the rest of the session.
//
// The lock is a process-global behind a `Mutex`. The transcription worker runs
// multiple segments in parallel, so `record_detection` may be called
// concurrently. Critical sections are tiny and we only ever transition `locked`
// from `None` to `Some(..)` (lock-once); a benign race where two first segments
// both detect the same language is harmless.

use std::sync::Mutex;

/// Minimum audio length (in 16 kHz samples) for a detection to count as a vote.
/// Short segments are unreliable language detectors, so they still transcribe in
/// detect mode but never influence the lock. 16_000 * 2 == 2 seconds.
const MIN_VOTE_SAMPLES: usize = 16_000 * 2;

/// Number of votes after which we fall back to a plurality decision if no
/// language has yet reached the fast-path threshold.
const PLURALITY_THRESHOLD: usize = 4;

/// Number of agreeing votes that immediately locks a language (fast path).
const MAJORITY_VOTES: usize = 2;

/// Session-scoped auto-detection lock state.
///
/// Holds the locked language id once decided, plus the running tally of
/// per-segment detections used to reach that decision.
struct LangLock {
    /// The locked whisper language id, or `None` while still deciding.
    locked: Option<i32>,
    /// Detected language ids accumulated while `locked` is `None`. Kept in
    /// arrival order so plurality ties resolve to the earliest-seen id.
    votes: Vec<i32>,
}

impl LangLock {
    /// `const fn` so the global `Mutex` can be initialised in a `static`.
    /// `Vec::new()` does not allocate, which keeps this usable in a const context.
    const fn new() -> Self {
        Self {
            locked: None,
            votes: Vec::new(),
        }
    }

    /// Clear all state so a new transcription session starts fresh.
    fn reset(&mut self) {
        self.locked = None;
        self.votes.clear();
    }

    /// The locked language id, if one has been decided.
    fn locked_id(&self) -> Option<i32> {
        self.locked
    }

    /// Record a per-segment auto-detection result and, if enough evidence has
    /// accumulated, lock the session language.
    ///
    /// Voting policy (only applied while `locked` is `None`):
    /// - Ignore ids `< 0` (whisper returns negatives when detection failed).
    /// - Only count a vote when `sample_count >= MIN_VOTE_SAMPLES` (>= 2 s).
    /// - As soon as any id reaches `MAJORITY_VOTES` (2) votes, lock it.
    /// - Otherwise, once `votes.len() >= PLURALITY_THRESHOLD` (4), lock the most
    ///   frequent id; ties resolve to the earliest-seen id.
    fn record_detection(&mut self, id: i32, sample_count: usize) {
        // Lock-once: ignore everything after a decision is made.
        if self.locked.is_some() {
            return;
        }
        // Negative ids signal a failed detection; ignore them entirely.
        if id < 0 {
            return;
        }
        // Sub-2 s detections are unreliable and must not influence the lock.
        if sample_count < MIN_VOTE_SAMPLES {
            return;
        }

        self.votes.push(id);

        // Fast path: any language with >= 2 agreeing votes wins immediately.
        for &candidate in &self.votes {
            if self.votes.iter().filter(|&&v| v == candidate).count() >= MAJORITY_VOTES {
                self.locked = Some(candidate);
                return;
            }
        }

        // Plurality fallback after enough votes with no clear majority.
        if self.votes.len() >= PLURALITY_THRESHOLD {
            self.locked = self.plurality();
        }
    }

    /// The most frequent vote, breaking ties in favour of the earliest-seen id.
    ///
    /// Iterating `votes` in order and only replacing the best candidate on a
    /// strictly greater count means the first id to reach a given count wins,
    /// which gives the earliest-seen tie-break for free.
    fn plurality(&self) -> Option<i32> {
        let mut best: Option<(i32, usize)> = None;
        for &candidate in &self.votes {
            let count = self.votes.iter().filter(|&&v| v == candidate).count();
            match best {
                Some((_, best_count)) if count <= best_count => {}
                _ => best = Some((candidate, count)),
            }
        }
        best.map(|(id, _)| id)
    }
}

/// Process-global session language lock. Reset at the start of every
/// transcription session (recording, import, retranscription).
static LANG_LOCK: Mutex<LangLock> = Mutex::new(LangLock::new());

/// Reset the session language lock so a stale lock never leaks across
/// recordings or into an import/retranscription run.
pub fn reset_session_detected_language() {
    // A poisoned lock here is non-fatal (the data is just a tally), so recover
    // the guard rather than propagating a panic into the audio pipeline.
    let mut guard = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    guard.reset();
}

/// The currently locked whisper language id, or `None` if not yet decided.
pub fn locked_language_id() -> Option<i32> {
    let guard = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    guard.locked_id()
}

/// Record a per-segment auto-detection result.
///
/// Returns the newly locked language id if THIS call caused the lock to be set,
/// so the caller can emit a single `info!` when a language actually gets locked.
pub fn record_detection(id: i32, sample_count: usize) -> Option<i32> {
    let mut guard = LANG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let was_locked = guard.locked_id().is_some();
    guard.record_detection(id, sample_count);
    match guard.locked_id() {
        Some(locked) if !was_locked => Some(locked),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_SECONDS: usize = MIN_VOTE_SAMPLES;
    const ONE_SECOND: usize = 16_000;

    #[test]
    fn locks_after_two_agreeing_long_detections() {
        // Arrange
        let mut lock = LangLock::new();

        // Act
        lock.record_detection(5, TWO_SECONDS);
        assert_eq!(lock.locked_id(), None, "one vote must not lock");
        lock.record_detection(5, TWO_SECONDS);

        // Assert
        assert_eq!(lock.locked_id(), Some(5));
    }

    #[test]
    fn ignores_sub_two_second_detections() {
        // Arrange
        let mut lock = LangLock::new();

        // Act: two agreeing detections, but both under 2 s.
        lock.record_detection(5, ONE_SECOND);
        lock.record_detection(5, ONE_SECOND);

        // Assert: short segments never influence the lock.
        assert_eq!(lock.locked_id(), None);
    }

    #[test]
    fn locks_plurality_after_four_votes_without_majority() {
        // Arrange
        let mut lock = LangLock::new();

        // Act: ids 1, 2, 3 appear once each, then 2 appears again as the 4th
        // vote. The 2nd occurrence of `2` reaches the majority threshold first.
        lock.record_detection(1, TWO_SECONDS);
        lock.record_detection(2, TWO_SECONDS);
        lock.record_detection(3, TWO_SECONDS);
        lock.record_detection(2, TWO_SECONDS);

        // Assert
        assert_eq!(lock.locked_id(), Some(2));
    }

    #[test]
    fn locks_earliest_plurality_on_tie() {
        // Arrange: four distinct ids, no id repeats, so the majority fast path
        // never triggers and the plurality fallback decides at vote 4. With an
        // all-ones tally the earliest-seen id wins.
        let mut lock = LangLock::new();

        // Act
        lock.record_detection(7, TWO_SECONDS);
        lock.record_detection(8, TWO_SECONDS);
        lock.record_detection(9, TWO_SECONDS);
        lock.record_detection(10, TWO_SECONDS);

        // Assert: all tied at one vote, earliest (7) wins.
        assert_eq!(lock.locked_id(), Some(7));
    }

    #[test]
    fn ignores_negative_ids() {
        // Arrange
        let mut lock = LangLock::new();

        // Act
        lock.record_detection(-1, TWO_SECONDS);
        lock.record_detection(-1, TWO_SECONDS);

        // Assert
        assert_eq!(lock.locked_id(), None);
    }

    #[test]
    fn reset_clears_state() {
        // Arrange
        let mut lock = LangLock::new();
        lock.record_detection(5, TWO_SECONDS);
        lock.record_detection(5, TWO_SECONDS);
        assert_eq!(lock.locked_id(), Some(5));

        // Act
        lock.reset();

        // Assert
        assert_eq!(lock.locked_id(), None);
    }

    #[test]
    fn locked_id_is_stable_once_set() {
        // Arrange: lock onto id 5.
        let mut lock = LangLock::new();
        lock.record_detection(5, TWO_SECONDS);
        lock.record_detection(5, TWO_SECONDS);
        assert_eq!(lock.locked_id(), Some(5));

        // Act: a flurry of later, different detections.
        lock.record_detection(9, TWO_SECONDS);
        lock.record_detection(9, TWO_SECONDS);
        lock.record_detection(9, TWO_SECONDS);

        // Assert: the lock never moves once set.
        assert_eq!(lock.locked_id(), Some(5));
    }
}
