//! Text-level cross-talk dedup between the microphone and system lanes.
//!
//! When system audio plays through speakers, the microphone picks it up and
//! both lanes transcribe the same words, duplicating text in the transcript.
//! Echo cancellation reduces this but cannot eliminate it; this filter is the
//! text-level backstop: a mic segment whose text near-duplicates a recent,
//! time-overlapping system segment is dropped before emit.
//!
//! Only mic segments are ever dropped (system is the cleaner lane). A system
//! segment arriving after its mic echo cannot retract the already-emitted mic
//! text, so that direction is accepted; decode order is chronological, and the
//! system lane usually finishes first because its VAD segment starts earlier.

use std::collections::VecDeque;

/// How long a segment stays eligible as a dedup reference.
const RETENTION_SECS: f64 = 30.0;
/// Lane clocks and VAD boundaries drift; treat segments within this slack of
/// each other as overlapping.
const OVERLAP_SLACK_SECS: f64 = 1.0;
/// Never drop very short utterances ("yeah", "okay"): both sides legitimately
/// say them, and losing a real one is worse than keeping an echoed one.
const MIN_TOKENS: usize = 3;
/// Fraction of the shorter segment's tokens that must appear in the other
/// segment for the pair to count as a duplicate.
const SIMILARITY_THRESHOLD: f64 = 0.8;

struct Seg {
    is_system: bool,
    tokens: Vec<String>,
    start: f64,
    end: f64,
}

#[derive(Default)]
pub struct CrosstalkFilter {
    recent: VecDeque<Seg>,
}

impl CrosstalkFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a segment and report whether it should be kept. Returns false
    /// only for a mic segment that near-duplicates a recent, time-overlapping
    /// system segment; dropped segments are not recorded as references.
    pub fn admit(&mut self, is_mic: bool, text: &str, start: f64, end: f64) -> bool {
        self.prune(start);
        let tokens = normalize_tokens(text);
        if is_mic && tokens.len() >= MIN_TOKENS {
            let is_echo = self.recent.iter().any(|seg| {
                seg.is_system
                    && overlaps(seg.start, seg.end, start, end)
                    && containment(&tokens, &seg.tokens) >= SIMILARITY_THRESHOLD
            });
            if is_echo {
                return false;
            }
        }
        self.recent.push_back(Seg { is_system: !is_mic, tokens, start, end });
        true
    }

    fn prune(&mut self, now: f64) {
        while let Some(front) = self.recent.front() {
            if front.end + RETENTION_SECS < now {
                self.recent.pop_front();
            } else {
                break;
            }
        }
    }
}

fn overlaps(a_start: f64, a_end: f64, b_start: f64, b_end: f64) -> bool {
    a_start - OVERLAP_SLACK_SECS < b_end && b_start - OVERLAP_SLACK_SECS < a_end
}

fn normalize_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Fraction of the shorter token list found in the longer one (multiset).
fn containment(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    for t in long {
        *counts.entry(t.as_str()).or_default() += 1;
    }
    let mut hits = 0usize;
    for t in short {
        if let Some(c) = counts.get_mut(t.as_str()) {
            if *c > 0 {
                *c -= 1;
                hits += 1;
            }
        }
    }
    hits as f64 / short.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_echo_of_system_segment_is_dropped() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(false, "let's finalize the budget for the launch", 10.0, 14.0));
        // Same words picked up by the mic a moment later, slightly offset.
        assert!(!f.admit(true, "let's finalize the budget for the launch", 10.5, 14.5));
    }

    #[test]
    fn near_duplicate_with_asr_noise_is_dropped() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(false, "We will ship the beta on March tenth, right?", 5.0, 9.0));
        assert!(!f.admit(true, "we will ship the beta on march tenth", 5.2, 8.8));
    }

    #[test]
    fn different_text_in_same_window_is_kept() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(false, "the deployment finished ahead of schedule", 10.0, 14.0));
        assert!(f.admit(true, "great, then let's move to the next topic", 10.5, 14.5));
    }

    #[test]
    fn same_text_far_apart_in_time_is_kept() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(false, "can you hear me now everyone", 10.0, 12.0));
        assert!(f.admit(true, "can you hear me now everyone", 20.0, 22.0));
    }

    #[test]
    fn short_utterances_are_never_dropped() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(false, "yeah okay", 10.0, 11.0));
        assert!(f.admit(true, "yeah okay", 10.2, 11.2));
    }

    #[test]
    fn mic_first_then_system_keeps_both() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(true, "let's finalize the budget for the launch", 10.0, 14.0));
        assert!(f.admit(false, "let's finalize the budget for the launch", 10.2, 14.2));
    }

    #[test]
    fn references_expire_after_retention() {
        let mut f = CrosstalkFilter::new();
        assert!(f.admit(false, "this reference should expire eventually", 10.0, 12.0));
        // A mic duplicate far outside retention is kept (reference pruned).
        assert!(f.admit(true, "this reference should expire eventually", 50.0, 52.0));
    }
}
