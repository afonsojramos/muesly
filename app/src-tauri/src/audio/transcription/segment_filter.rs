//! Post-decode segment quality gates, applied after the engine's own
//! thresholds (entropy / logprob / no-speech) and the confidence floor.
//!
//! Two failure modes slip through those: Whisper's classic silence
//! hallucinations (training-data artifacts like "thanks for watching" emitted
//! over near-silence) and degenerate repetition loops. Both are cheap to
//! detect on the final text.

/// Whole-segment phrases Whisper is known to hallucinate over silence, in the
/// languages the app sees most. Only dropped when the segment is EXACTLY one
/// of these (after normalization) and confidence is low; a real speaker
/// saying "thank you for watching" mid-talk decodes with high confidence.
const HALLUCINATION_PHRASES: &[&str] = &[
    "you",
    "thank you",
    "thank you for watching",
    "thanks for watching",
    "thank you so much for watching",
    "please subscribe",
    "subscribe to the channel",
    "subtitles by the amara org community",
    "obrigado",
    "obrigada",
    "obrigado por assistir",
    "e aí",
    "música",
    "aplausos",
    "risos",
    "tchau",
    "até a próxima",
    "até à próxima",
    "legendas pela comunidade amara org",
    "amara org",
    "gracias por ver",
    "merci d'avoir regarde",
    "vielen dank fürs zuschauen",
];

/// Confidence below which an exact hallucination phrase is dropped.
const HALLUCINATION_CONFIDENCE_CEILING: f32 = 0.55;

/// Repetition gate: segments with at least this many tokens...
const REPETITION_MIN_TOKENS: usize = 8;
/// ...where distinct tokens make up at most this fraction are decode loops
/// ("the the the the ..."), not speech.
const REPETITION_MAX_DISTINCT_RATIO: f64 = 0.25;

/// Why a segment was rejected, for logging.
#[derive(Debug, PartialEq)]
pub enum DropReason {
    SilenceHallucination,
    DegenerateRepetition,
}

/// Returns the reason to drop this segment, or None to keep it.
pub fn should_drop_segment(text: &str, confidence: Option<f32>) -> Option<DropReason> {
    let tokens = normalize_tokens(text);
    if tokens.is_empty() {
        return None; // empty text is already filtered upstream
    }

    if is_degenerate_repetition(&tokens) {
        return Some(DropReason::DegenerateRepetition);
    }

    let low_confidence = confidence.is_none_or(|c| c < HALLUCINATION_CONFIDENCE_CEILING);
    if low_confidence {
        let joined = tokens.join(" ");
        if HALLUCINATION_PHRASES.contains(&joined.as_str()) {
            return Some(DropReason::SilenceHallucination);
        }
    }

    // A segment that is NOTHING but a URL is a subtitle-credit artifact
    // ("www.cdc.gov.br", "amara.org"), not speech: spoken URLs decode with
    // surrounding words. Not confidence-gated; these often decode confidently.
    if is_bare_url(text) {
        return Some(DropReason::SilenceHallucination);
    }

    None
}

/// The entire (trimmed) segment is one URL-shaped token: an optional scheme or
/// `www.` prefix, a plausible dotted host, and no whitespace.
fn is_bare_url(text: &str) -> bool {
    let trimmed = text.trim().trim_end_matches(['.', '!', '?']);
    if trimmed.contains(char::is_whitespace) {
        return false;
    }
    let (has_scheme, rest) = match trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
    {
        Some(rest) => (true, rest),
        None => (false, trimmed),
    };
    let host = rest.split('/').next().unwrap_or("").to_lowercase();
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-')
    {
        return false;
    }
    let dots = host.matches('.').count();
    // With a scheme, any dotted host is a URL. Without one, require the
    // unmistakable shapes ("www.x.y" or "x.y.z"): a single dot without "www."
    // ("etc.", "Sr.") is normal text, not a URL.
    (has_scheme && dots >= 1) || (host.starts_with("www.") && dots >= 2) || dots >= 2
}

fn is_degenerate_repetition(tokens: &[String]) -> bool {
    if tokens.len() < REPETITION_MIN_TOKENS {
        return false;
    }
    let distinct: std::collections::HashSet<&str> = tokens.iter().map(|s| s.as_str()).collect();
    (distinct.len() as f64 / tokens.len() as f64) <= REPETITION_MAX_DISTINCT_RATIO
}

fn normalize_tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_confidence_hallucination_phrase_is_dropped() {
        assert_eq!(
            should_drop_segment("Thank you for watching.", Some(0.31)),
            Some(DropReason::SilenceHallucination)
        );
        assert_eq!(
            should_drop_segment("you", Some(0.4)),
            Some(DropReason::SilenceHallucination)
        );
    }

    #[test]
    fn low_confidence_portuguese_hallucinations_are_dropped() {
        // The PT phrases Whisper actually hallucinates over silence in the
        // wild: bare interjections and caption artifacts.
        for phrase in ["Obrigado.", "E aí", "[Música]", "Tchau!"] {
            assert_eq!(
                should_drop_segment(phrase, Some(0.3)),
                Some(DropReason::SilenceHallucination),
                "expected {phrase:?} to be dropped",
            );
        }
        // A confident, genuine "obrigado" reply survives.
        assert_eq!(should_drop_segment("Obrigado.", Some(0.8)), None);
    }

    #[test]
    fn confident_matching_phrase_is_kept() {
        assert_eq!(
            should_drop_segment("Thank you for watching.", Some(0.9)),
            None
        );
    }

    #[test]
    fn phrase_embedded_in_real_speech_is_kept() {
        assert_eq!(
            should_drop_segment("and thank you for watching the demo, next slide", Some(0.3)),
            None
        );
    }

    #[test]
    fn repetition_loop_is_dropped_regardless_of_confidence() {
        assert_eq!(
            should_drop_segment("the the the the the the the the the the", Some(0.9)),
            Some(DropReason::DegenerateRepetition)
        );
    }

    #[test]
    fn bare_url_segments_are_dropped_even_when_confident() {
        // The observed failure: whisper credits a Brazilian subtitle site over
        // near-silence, confidently.
        for url in [
            "www.cdc.gov.br",
            "http://www.cdc.gov.br",
            "https://amara.org/subtitles",
            "www.youtube.com/watch",
        ] {
            assert_eq!(
                should_drop_segment(url, Some(0.95)),
                Some(DropReason::SilenceHallucination),
                "expected {url:?} to be dropped",
            );
        }
    }

    #[test]
    fn urls_inside_speech_and_plain_abbreviations_are_kept() {
        assert_eq!(
            should_drop_segment("vai a www.cdc.gov.br para ver", Some(0.9)),
            None
        );
        // Ordinary dotted tokens are not URLs.
        assert_eq!(should_drop_segment("etc.", Some(0.9)), None);
        assert_eq!(should_drop_segment("Ok.", Some(0.9)), None);
    }

    #[test]
    fn normal_speech_is_kept() {
        assert_eq!(
            should_drop_segment("let's review the quarterly numbers before lunch", Some(0.4)),
            None
        );
        // Short segments never hit the repetition gate.
        assert_eq!(should_drop_segment("yes yes yes", Some(0.8)), None);
    }

    #[test]
    fn missing_confidence_counts_as_low_for_hallucinations() {
        assert_eq!(
            should_drop_segment("Thanks for watching!", None),
            Some(DropReason::SilenceHallucination)
        );
    }
}
