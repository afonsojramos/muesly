//! Pure decode policy for Whisper: prior-segment prompts and temperature ladders.

/// Temperatures to try when a decode returns empty or low-confidence text.
/// Starts at the preferred quality setting, then falls back to higher exploration.
pub const TEMPERATURE_LADDER: &[f32] = &[0.0, 0.2, 0.4, 0.6, 0.8];

/// Build the initial_prompt for the next chunk from prior transcript text.
/// Keeps the tail so vocabulary/names stay in context without overflowing.
pub fn prior_segment_prompt(previous: &str, max_chars: usize) -> Option<String> {
    let trimmed = previous.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= max_chars {
        return Some(trimmed.to_string());
    }
    // Keep the tail on a char boundary.
    let start = trimmed
        .char_indices()
        .rev()
        .nth(max_chars.saturating_sub(1))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let tail = trimmed[start..].trim();
    if tail.is_empty() {
        None
    } else {
        Some(tail.to_string())
    }
}

/// Merge vocabulary prompt with prior segment text for whisper initial_prompt.
pub fn merge_initial_prompt(vocab: Option<&str>, prior: Option<&str>) -> Option<String> {
    match (
        vocab.map(str::trim).filter(|s| !s.is_empty()),
        prior.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (Some(v), Some(p)) => Some(format!("{v} {p}")),
        (Some(v), None) => Some(v.to_string()),
        (None, Some(p)) => Some(p.to_string()),
        (None, None) => None,
    }
}

/// Whether a decode result should trigger the next temperature in the ladder.
pub fn should_retry_decode(text: &str, min_chars: usize) -> bool {
    text.trim().chars().count() < min_chars
}

/// Minimum normalized length for an echo verdict. Short interjections ("Sim.",
/// "Ok.") legitimately repeat across consecutive segments; a 12+ character
/// verbatim reappearance of prior-prompt text is the conditioning failure.
const ECHO_MIN_CHARS: usize = 12;

/// Whether a decode merely parroted the prior-segment prompt instead of
/// transcribing the audio.
///
/// This is Whisper's classic conditioning collapse: a hallucinated phrase (a
/// subtitle-credit URL, a stray sentence) gets carried into the next chunk's
/// `initial_prompt`, and the decoder emits the prompt again regardless of the
/// audio, looping until something breaks the chain. Callers re-decode the
/// chunk WITHOUT the prior prompt when this returns true, which yields the
/// real content when there is any and confines a hallucination to the one
/// segment that produced it.
pub fn is_prompt_echo(text: &str, prior_prompt: &str) -> bool {
    let normalized_text = normalize_for_echo(text);
    if normalized_text.chars().count() < ECHO_MIN_CHARS {
        return false;
    }
    normalize_for_echo(prior_prompt).contains(&normalized_text)
}

/// Lowercased alphanumeric words joined by single spaces, so punctuation or
/// spacing drift between the prompt and the decode doesn't hide an echo.
fn normalize_for_echo(text: &str) -> String {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Next temperature after `current` in the ladder, if any.
pub fn next_temperature(current: f32) -> Option<f32> {
    let mut found = false;
    for &t in TEMPERATURE_LADDER {
        if found {
            return Some(t);
        }
        if (t - current).abs() < f32::EPSILON {
            found = true;
        }
    }
    // If current isn't in the ladder, start from the first step after 0.0.
    if !found {
        TEMPERATURE_LADDER.get(1).copied()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prior_prompt_keeps_tail() {
        let long = "a".repeat(100);
        let p = prior_segment_prompt(&long, 10).unwrap();
        assert_eq!(p.chars().count(), 10);
    }

    #[test]
    fn merge_joins_vocab_and_prior() {
        assert_eq!(
            merge_initial_prompt(Some("Acme"), Some("hello world")).as_deref(),
            Some("Acme hello world")
        );
    }

    #[test]
    fn retry_on_empty() {
        assert!(should_retry_decode("  ", 1));
        assert!(!should_retry_decode("hello", 1));
    }

    #[test]
    fn ladder_advances() {
        assert_eq!(next_temperature(0.0), Some(0.2));
        assert_eq!(next_temperature(0.8), None);
    }

    #[test]
    fn url_echo_of_prior_prompt_is_detected() {
        // The observed failure: a hallucinated subtitle-credit URL loops
        // through the prompt across punctuation/case drift.
        assert!(is_prompt_echo("www.cdc.gov.br", "www.cdc.gov.br"));
        assert!(is_prompt_echo(
            "WWW. CDC. GOV. BR",
            "…legendas www.cdc.gov.br"
        ));
    }

    #[test]
    fn echo_requires_the_whole_decode_to_reappear() {
        // Overlapping vocabulary with the previous segment is normal speech.
        assert!(!is_prompt_echo(
            "o PR do mobile app ficou pronto",
            "ele queria testar o mobile app por causa da autenticação"
        ));
    }

    #[test]
    fn short_repeats_are_not_echoes() {
        // Consecutive "Sim." answers are genuine, not conditioning collapse.
        assert!(!is_prompt_echo("Sim.", "Sim."));
        assert!(!is_prompt_echo("Obrigado.", "Obrigado."));
    }

    #[test]
    fn long_verbatim_repeat_is_an_echo() {
        assert!(is_prompt_echo(
            "estou a tentar organizar melhor o meu estudo",
            "mas sim, estou a tentar organizar melhor o meu estudo fora do trabalho"
        ));
    }
}
