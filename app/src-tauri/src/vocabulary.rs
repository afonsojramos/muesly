//! User-defined transcription vocabulary: exact, whole-word, case-insensitive
//! corrections applied to the final transcript text of both engines, plus a
//! Whisper initial_prompt bias built from the correct spellings.

use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

/// Build a Whisper initial_prompt from the distinct, non-empty `to` terms
/// (the correct spellings), or None when there is nothing to bias toward.
pub fn whisper_initial_prompt() -> Option<String> {
    let entries = get_vocabulary();
    let mut terms: Vec<String> = Vec::new();
    for e in &entries {
        let t = e.to.trim();
        if !t.is_empty() && !terms.iter().any(|x| x == t) {
            terms.push(t.to_string());
        }
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

    #[test]
    fn replacement_text_is_literal_not_a_regex_template() {
        // A `to` containing `$` must be inserted verbatim, not treated as a
        // capture-group reference.
        let v = vec![entry("price", "$5")];
        assert_eq!(apply_corrections("the price today", &v), "the $5 today");
    }
}
