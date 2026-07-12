//! User-defined transcription vocabulary: exact, whole-word, case-insensitive
//! corrections applied to the final transcript text of both engines, plus a
//! Whisper initial_prompt bias built from the correct spellings.

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct VocabularyEntry {
    /// The text the engine tends to produce (matched case-insensitively).
    pub from: String,
    /// The correct replacement (inserted verbatim).
    pub to: String,
}

// Mirrors LANGUAGE_PREFERENCE in lib.rs: the durable source of truth is the
// settings DB; the frontend pushes this on boot via `set_custom_vocabulary`.
// Defaults to empty (no corrections), which is harmless before the push.
static VOCABULARY: LazyLock<RwLock<Vec<VocabularyEntry>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));

/// Per-recording prompt-bias terms (meeting title + attendee names), set at
/// recording start from the matched calendar event and cleared at stop. Only
/// ever fed to the local Whisper initial_prompt; never leaves the device.
static MEETING_TERMS: LazyLock<RwLock<Vec<String>>> = LazyLock::new(|| RwLock::new(Vec::new()));

/// Keep the terms portion of the initial prompt well under Whisper's prompt
/// budget (~224 tokens shared with the prior-segment text).
const MAX_PROMPT_TERM_CHARS: usize = 400;

pub fn set_meeting_prompt_terms(terms: Vec<String>) {
    let cleaned: Vec<String> = terms
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if let Ok(mut guard) = MEETING_TERMS.write() {
        *guard = cleaned;
    }
}

pub fn clear_meeting_prompt_terms() {
    if let Ok(mut guard) = MEETING_TERMS.write() {
        guard.clear();
    }
}

fn meeting_prompt_terms() -> Vec<String> {
    MEETING_TERMS.read().map(|g| g.clone()).unwrap_or_default()
}

pub fn set_vocabulary(entries: Vec<VocabularyEntry>) {
    if let Ok(mut guard) = VOCABULARY.write() {
        *guard = entries;
    }
}

pub fn get_vocabulary() -> Vec<VocabularyEntry> {
    VOCABULARY.read().map(|g| g.clone()).unwrap_or_default()
}

/// Whole-word, case-insensitive replacement of each `from` with its `to`.
/// Pure and engine-agnostic. Entries with an empty `from` are skipped.
pub fn apply_corrections(text: &str, entries: &[VocabularyEntry]) -> String {
    let mut out = text.to_string();
    for entry in entries {
        let from = entry.from.trim();
        if from.is_empty() {
            continue;
        }
        let pattern = format!(r"(?i)\b{}\b", regex::escape(from));
        if let Ok(re) = regex::Regex::new(&pattern) {
            out = re.replace_all(&out, regex::NoExpand(entry.to.as_str())).into_owned();
        }
    }
    out
}

/// Apply the cached vocabulary to `text`. Fast no-op when empty.
pub fn apply_cached_corrections(text: &str) -> String {
    let entries = get_vocabulary();
    if entries.is_empty() {
        return text.to_string();
    }
    apply_corrections(text, &entries)
}

/// Build a Whisper initial_prompt from the distinct, non-empty vocabulary `to`
/// terms (the correct spellings) plus the current meeting's context terms
/// (title, attendee names), or None when there is nothing to bias toward.
/// Capped so it can't crowd the prior-segment text out of the prompt budget.
pub fn whisper_initial_prompt() -> Option<String> {
    let entries = get_vocabulary();
    let mut terms: Vec<String> = Vec::new();
    let mut total_chars = 0usize;
    let mut push = |t: &str, terms: &mut Vec<String>, total: &mut usize| {
        let t = t.trim();
        if t.is_empty() || terms.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            return;
        }
        if *total + t.len() > MAX_PROMPT_TERM_CHARS {
            return;
        }
        *total += t.len();
        terms.push(t.to_string());
    };
    for e in &entries {
        push(&e.to, &mut terms, &mut total_chars);
    }
    for t in meeting_prompt_terms() {
        push(&t, &mut terms, &mut total_chars);
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(from: &str, to: &str) -> VocabularyEntry {
        VocabularyEntry { from: from.into(), to: to.into() }
    }

    #[test]
    fn replaces_case_insensitively_whole_word() {
        let v = vec![entry("cubernetes", "Kubernetes")];
        assert_eq!(apply_corrections("we deployed Cubernetes today", &v), "we deployed Kubernetes today");
    }

    #[test]
    fn does_not_replace_substrings() {
        let v = vec![entry("ml", "ML")];
        // "html" must not become "htML".
        assert_eq!(apply_corrections("the html page", &v), "the html page");
    }

    #[test]
    fn empty_from_is_skipped() {
        let v = vec![entry("", "X")];
        assert_eq!(apply_corrections("unchanged", &v), "unchanged");
    }

    #[test]
    fn initial_prompt_dedupes_to_terms() {
        set_vocabulary(vec![entry("a", "Kubernetes"), entry("b", "Kubernetes"), entry("c", "muesly")]);
        let p = whisper_initial_prompt().unwrap();
        assert!(p.contains("Kubernetes") && p.contains("muesly"));
        assert_eq!(p.matches("Kubernetes").count(), 1);
        set_vocabulary(Vec::new()); // reset shared state for other tests
    }

    // MEETING_TERMS is process-global; serialize the tests that mutate it.
    static MEETING_TERMS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn initial_prompt_includes_meeting_terms_until_cleared() {
        let _guard = MEETING_TERMS_TEST_LOCK.lock().unwrap();
        set_meeting_prompt_terms(vec![
            "Q3 Budget Sync".into(),
            "Afonso Ramos".into(),
            "  ".into(), // blank terms are dropped
            "afonso ramos".into(), // case-insensitive duplicate is dropped
        ]);
        let p = whisper_initial_prompt().unwrap();
        assert!(p.contains("Q3 Budget Sync"), "prompt missing title: {p}");
        assert_eq!(p.matches("Afonso Ramos").count(), 1);

        clear_meeting_prompt_terms();
        let after = whisper_initial_prompt().unwrap_or_default();
        assert!(!after.contains("Q3 Budget Sync"), "terms must clear on stop: {after}");
    }

    #[test]
    fn initial_prompt_terms_are_capped() {
        let _guard = MEETING_TERMS_TEST_LOCK.lock().unwrap();
        let long: Vec<String> = (0..100).map(|i| format!("Attendee Number {i:03}")).collect();
        set_meeting_prompt_terms(long);
        let p = whisper_initial_prompt().unwrap();
        assert!(
            p.len() <= MAX_PROMPT_TERM_CHARS + 2 * 100, // joined separators
            "prompt should stay near the cap, got {} chars",
            p.len()
        );
        clear_meeting_prompt_terms();
    }

    #[test]
    fn replacement_text_is_literal_not_a_regex_template() {
        // A `to` containing `$` must be inserted verbatim, not treated as a
        // capture-group reference.
        let v = vec![entry("price", "$5")];
        assert_eq!(apply_corrections("the price today", &v), "the $5 today");
    }
}
