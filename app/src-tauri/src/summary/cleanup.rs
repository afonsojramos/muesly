//! Optional pre-summary transcript cleanup via the local LLM.
//! Builds prompts only; the service wires generation when enabled.

/// System prompt for disfluency/casing cleanup without changing meaning.
pub fn cleanup_system_prompt() -> &'static str {
    "You clean speech transcripts for readability. Fix casing and punctuation, \
remove filler words (um, uh, like as filler), and keep meaning identical. \
Preserve speaker labels like 'Me:' or 'Them:' or named prefixes. \
Output only the cleaned transcript, no commentary."
}

/// User prompt wrapping the raw transcript.
pub fn cleanup_user_prompt(transcript: &str) -> String {
    format!("Clean this transcript:\n\n{}", transcript.trim())
}

/// Whether cleanup should run for a given transcript length (skip trivial).
pub fn should_cleanup(transcript: &str, min_chars: usize) -> bool {
    transcript.trim().chars().count() >= min_chars
}

/// Whether a cleaned transcript is long enough to replace the original.
/// Rejects truncated LLM output (e.g. max_tokens cut off mid-meeting).
pub fn accept_cleaned_transcript(original: &str, cleaned: &str, min_ratio: f64) -> bool {
    let orig = original.trim().chars().count();
    let clean = cleaned.trim().chars().count();
    if clean == 0 || orig == 0 {
        return false;
    }
    (clean as f64) >= (orig as f64) * min_ratio
}

/// Token budget for cleanup generation: roughly input size + headroom, capped.
pub fn cleanup_max_tokens(transcript: &str) -> u32 {
    let chars = transcript.chars().count();
    // ~0.35 tokens/char (same rough factor as summary processor), +20% headroom.
    let estimate = ((chars as f64) * 0.35 * 1.2).ceil() as u32;
    estimate.clamp(512, 32_768)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_wraps_transcript() {
        let u = cleanup_user_prompt("Me: uh hello");
        assert!(u.contains("Me: uh hello"));
        assert!(cleanup_system_prompt().contains("filler"));
    }

    #[test]
    fn skip_short() {
        assert!(!should_cleanup("hi", 20));
        assert!(should_cleanup(&"x".repeat(50), 20));
    }

    #[test]
    fn reject_truncated_cleanup() {
        let orig = "word ".repeat(100);
        let short = "word ".repeat(20);
        assert!(!accept_cleaned_transcript(&orig, &short, 0.7));
        assert!(accept_cleaned_transcript(&orig, &orig, 0.7));
    }

    #[test]
    fn cleanup_max_tokens_scales() {
        assert!(cleanup_max_tokens("hi") >= 512);
        let long = "a".repeat(50_000);
        assert!(cleanup_max_tokens(&long) <= 32_768);
        assert!(cleanup_max_tokens(&long) > 512);
    }
}
