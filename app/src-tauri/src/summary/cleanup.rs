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
}
