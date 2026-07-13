//! User-defined transcription vocabulary: preferred terms used to bias Whisper,
//! plus comma/newline-separated aliases applied as literal, boundary-aware
//! corrections to the final transcript text of both local engines.

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::sync::{LazyLock, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct VocabularyEntry {
    /// Comma/newline-separated forms the engine tends to produce.
    pub from: String,
    /// The preferred spelling, also supplied to Whisper as prompt context.
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

/// Trim persisted values, merge duplicate preferred terms, discard incomplete
/// rows, and de-duplicate aliases. Keeping this at the IPC boundary means old
/// saved JSON automatically benefits without a database migration.
pub fn normalize_vocabulary(entries: Vec<VocabularyEntry>) -> Vec<VocabularyEntry> {
    let mut normalized: Vec<VocabularyEntry> = Vec::new();

    for entry in entries {
        let preferred = entry.to.trim();
        if preferred.is_empty() {
            continue;
        }

        let mut aliases: Vec<String> = Vec::new();
        for alias in entry.from.split([',', '\n']).map(str::trim) {
            // Keep case-only aliases (for example `c++` → `C++`) so preferred
            // capitalization can be enforced; only exact no-op aliases are dropped.
            if !alias.is_empty()
                && alias != preferred
                && !aliases.iter().any(|current| current.eq_ignore_ascii_case(alias))
            {
                aliases.push(alias.to_string());
            }
        }

        if let Some(existing) = normalized
            .iter_mut()
            .find(|candidate| candidate.to.eq_ignore_ascii_case(preferred))
        {
            let mut existing_aliases: Vec<String> = existing
                .from
                .split(',')
                .map(str::trim)
                .filter(|alias| !alias.is_empty())
                .map(str::to_string)
                .collect();
            for alias in aliases {
                if !existing_aliases.iter().any(|current| current.eq_ignore_ascii_case(&alias)) {
                    existing_aliases.push(alias);
                }
            }
            existing.from = existing_aliases.join(", ");
        } else {
            normalized.push(VocabularyEntry {
                from: aliases.join(", "),
                to: preferred.to_string(),
            });
        }
    }

    normalized
}

pub fn set_vocabulary(entries: Vec<VocabularyEntry>) {
    if let Ok(mut guard) = VOCABULARY.write() {
        *guard = normalize_vocabulary(entries);
    }
}

pub fn get_vocabulary() -> Vec<VocabularyEntry> {
    VOCABULARY.read().map(|g| g.clone()).unwrap_or_default()
}

fn is_term_character(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// Boundary-aware, case-insensitive replacement of every alias with its
/// preferred spelling. All aliases are matched against the original text in a
/// single pass: longer phrases win and replacements cannot cascade into other
/// corrections. Unlike `\b`, the explicit boundary check handles terms such as
/// `C++` whose first or last character is punctuation.
pub fn apply_corrections(text: &str, entries: &[VocabularyEntry]) -> String {
    let normalized = normalize_vocabulary(entries.to_vec());
    let mut corrections: Vec<(String, String)> = normalized
        .into_iter()
        .flat_map(|entry| {
            entry
                .from
                .split(',')
                .map(str::trim)
                .filter(|alias| !alias.is_empty())
                .map(|alias| (alias.to_string(), entry.to.clone()))
                .collect::<Vec<_>>()
        })
        .collect();
    corrections.sort_by(|(left, _), (right, _)| right.len().cmp(&left.len()));

    if corrections.is_empty() {
        return text.to_string();
    }

    let alternatives = corrections
        .iter()
        .map(|(alias, _)| regex::escape(alias))
        .collect::<Vec<_>>()
        .join("|");
    let Ok(pattern) = RegexBuilder::new(&alternatives).case_insensitive(true).build() else {
        return text.to_string();
    };

    let mut output = String::with_capacity(text.len());
    let mut copied_until = 0;
    for matched in pattern.find_iter(text) {
        let has_left_boundary = text[..matched.start()]
            .chars()
            .next_back()
            .is_none_or(|character| !is_term_character(character));
        let has_right_boundary = text[matched.end()..]
            .chars()
            .next()
            .is_none_or(|character| !is_term_character(character));
        if !has_left_boundary || !has_right_boundary {
            continue;
        }

        let replacement = corrections
            .iter()
            .find(|(alias, _)| alias.eq_ignore_ascii_case(matched.as_str()))
            .map(|(_, preferred)| preferred.as_str())
            .unwrap_or(matched.as_str());
        output.push_str(&text[copied_until..matched.start()]);
        output.push_str(replacement);
        copied_until = matched.end();
    }
    output.push_str(&text[copied_until..]);
    output
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
    let push = |t: &str, terms: &mut Vec<String>, total: &mut usize| {
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
    fn supports_multiple_aliases_and_prefers_longest_phrase() {
        let v = vec![
            entry("slack red, red", "Slack thread"),
            entry("the fred", "the thread"),
        ];
        assert_eq!(
            apply_corrections("From the Slack red, not the red. Open the Fred.", &v),
            "From the Slack thread, not the Slack thread. Open the thread."
        );
    }

    #[test]
    fn handles_terms_that_end_in_punctuation() {
        let v = vec![entry("c plus plus", "C++"), entry("c++", "C++")];
        assert_eq!(apply_corrections("C plus plus and c++ tools", &v), "C++ and C++ tools");
    }

    #[test]
    fn corrections_do_not_cascade() {
        let v = vec![entry("cube", "Kubernetes"), entry("kubernetes", "K8s")];
        assert_eq!(apply_corrections("cube and kubernetes", &v), "Kubernetes and K8s");
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
    fn normalization_merges_preferred_terms_and_drops_incomplete_rows() {
        let entries = normalize_vocabulary(vec![
            entry(" cubernetes, kube, Cubernetes ", " Kubernetes "),
            entry("cooper netties", "kubernetes"),
            entry("ignored", ""),
            entry("", "Moodle"),
        ]);
        assert_eq!(
            entries,
            vec![entry("cubernetes, kube, cooper netties", "Kubernetes"), entry("", "Moodle")]
        );
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
