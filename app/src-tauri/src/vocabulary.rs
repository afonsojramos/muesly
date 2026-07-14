//! User-defined transcription vocabulary: preferred terms used to bias Whisper,
//! optional manual aliases, and conservative aliases learned locally from
//! prompt-assisted low-confidence re-decodes.

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, RwLock};

pub const MIN_LEARNED_OBSERVATIONS: u32 = 2;
const MAX_LEARNED_ALIASES_PER_TERM: usize = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct LearnedAlias {
    /// The phrase Whisper produced without preferred-term context.
    pub from: String,
    /// Independent confidence-improving observations. Two activate correction.
    pub observations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct VocabularyEntry {
    /// Comma/newline-separated forms the engine tends to produce.
    pub from: String,
    /// The preferred spelling, also supplied to Whisper as prompt context.
    pub to: String,
    /// Locally observed aliases. Kept separate from manual overrides so the UI
    /// can explain and remove learned behavior without exposing it by default.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub learned_aliases: Vec<LearnedAlias>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LearningObservation {
    pub preferred: String,
    pub alias: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VocabularyLearningUpdate {
    pub preferred: String,
    pub alias: LearnedAlias,
}

// Mirrors LANGUAGE_PREFERENCE in lib.rs: the durable source of truth is the
// settings DB; the frontend pushes this on boot via `set_custom_vocabulary`.
// Defaults to empty (no corrections), which is harmless before the push.
static VOCABULARY: LazyLock<RwLock<Vec<VocabularyEntry>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));
static VOCABULARY_UPDATE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));
static OBSERVED_SESSIONS: LazyLock<Mutex<HashSet<(String, String, String)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

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

/// Scope meeting-specific Whisper prompt terms to one recording/import/batch
/// job. Clearing on drop prevents proper nouns from leaking into the next job
/// even when the current job fails or is cancelled.
pub struct MeetingPromptGuard;

impl Drop for MeetingPromptGuard {
    fn drop(&mut self) {
        clear_meeting_prompt_terms();
    }
}

pub fn scoped_meeting_prompt_terms(terms: Vec<String>) -> MeetingPromptGuard {
    set_meeting_prompt_terms(terms);
    MeetingPromptGuard
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
                && !aliases
                    .iter()
                    .any(|current| current.eq_ignore_ascii_case(alias))
            {
                aliases.push(alias.to_string());
            }
        }

        let mut learned_aliases: Vec<LearnedAlias> = Vec::new();
        for learned in entry.learned_aliases {
            let alias = learned.from.trim();
            if alias.is_empty()
                || alias.eq_ignore_ascii_case(preferred)
                || aliases
                    .iter()
                    .any(|manual| manual.eq_ignore_ascii_case(alias))
            {
                continue;
            }
            if let Some(existing) = learned_aliases
                .iter_mut()
                .find(|candidate| candidate.from.eq_ignore_ascii_case(alias))
            {
                existing.observations = existing.observations.max(learned.observations.max(1));
            } else if learned_aliases.len() < MAX_LEARNED_ALIASES_PER_TERM {
                learned_aliases.push(LearnedAlias {
                    from: alias.to_string(),
                    observations: learned.observations.max(1),
                });
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
                if !existing_aliases
                    .iter()
                    .any(|current| current.eq_ignore_ascii_case(&alias))
                {
                    existing_aliases.push(alias);
                }
            }
            existing.from = existing_aliases.join(", ");
            for learned in learned_aliases {
                if existing_aliases
                    .iter()
                    .any(|manual| manual.eq_ignore_ascii_case(&learned.from))
                {
                    continue;
                }
                if let Some(current) = existing
                    .learned_aliases
                    .iter_mut()
                    .find(|candidate| candidate.from.eq_ignore_ascii_case(&learned.from))
                {
                    current.observations = current.observations.max(learned.observations);
                } else if existing.learned_aliases.len() < MAX_LEARNED_ALIASES_PER_TERM {
                    existing.learned_aliases.push(learned);
                }
            }
        } else {
            normalized.push(VocabularyEntry {
                from: aliases.join(", "),
                to: preferred.to_string(),
                learned_aliases,
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

/// Remove a preferred term from an immutable Whisper prompt snapshot. Returns
/// `None` when the term was not present, so learning cannot attribute a result
/// to vocabulary context the primary decode never received.
pub fn remove_term_from_initial_prompt(prompt: &str, term: &str) -> Option<String> {
    let term = term.trim();
    if prompt.trim().is_empty() || term.is_empty() {
        return None;
    }
    let regex = RegexBuilder::new(&regex::escape(term))
        .case_insensitive(true)
        .build()
        .ok()?;
    let mut output = String::with_capacity(prompt.len());
    let mut last = 0;
    let mut removed = false;
    for matched in regex.find_iter(prompt) {
        let before = prompt[..matched.start()].chars().next_back();
        let after = prompt[matched.end()..].chars().next();
        if before.is_some_and(is_term_character) || after.is_some_and(is_term_character) {
            continue;
        }
        output.push_str(&prompt[last..matched.start()]);
        last = matched.end();
        removed = true;
    }
    if !removed {
        return None;
    }
    output.push_str(&prompt[last..]);
    let cleaned = output
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches([',', ';', ' '])
        .to_string();
    Some(cleaned)
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
            let manual = entry
                .from
                .split(',')
                .map(str::trim)
                .filter(|alias| !alias.is_empty())
                .map(|alias| (alias.to_string(), entry.to.clone()))
                .collect::<Vec<_>>();
            let learned = entry
                .learned_aliases
                .into_iter()
                .filter(|alias| alias.observations >= MIN_LEARNED_OBSERVATIONS)
                .map(|alias| (alias.from, entry.to.clone()));
            manual.into_iter().chain(learned).collect::<Vec<_>>()
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
    let Ok(pattern) = RegexBuilder::new(&alternatives)
        .case_insensitive(true)
        .build()
    else {
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

pub fn has_learnable_entries() -> bool {
    get_vocabulary().iter().any(|entry| {
        is_learnable_preferred(&entry.to)
            && entry.from.trim().is_empty()
            && !entry
                .learned_aliases
                .iter()
                .any(|alias| alias.observations >= MIN_LEARNED_OBSERVATIONS)
    })
}

fn is_learnable_preferred(term: &str) -> bool {
    let alphanumeric_count = term
        .chars()
        .filter(|character| character.is_alphanumeric())
        .count();
    let is_acronym = (2..=6).contains(&alphanumeric_count)
        && term.chars().any(|character| character.is_alphabetic())
        && term
            .chars()
            .filter(|character| character.is_alphabetic())
            .all(|character| character.is_uppercase());
    alphanumeric_count >= 4 || is_acronym
}

pub fn learnable_preferred_terms() -> Vec<String> {
    get_vocabulary()
        .into_iter()
        .filter(|entry| {
            entry.from.trim().is_empty()
                && is_learnable_preferred(&entry.to)
                && !entry
                    .learned_aliases
                    .iter()
                    .any(|alias| alias.observations >= MIN_LEARNED_OBSERVATIONS)
        })
        .map(|entry| entry.to)
        .collect()
}

pub fn learnable_preferred_in_text_from(text: &str, preferred_terms: &[String]) -> Option<String> {
    let text_tokens = tokens(text);
    preferred_terms.iter().find_map(|term| {
        let preferred = tokens(term);
        let present = !preferred.is_empty()
            && text_tokens.windows(preferred.len()).any(|window| {
                window
                    .iter()
                    .map(|(_, normalized)| normalized)
                    .eq(preferred.iter().map(|(_, normalized)| normalized))
            });
        present.then(|| term.clone())
    })
}

pub fn learnable_preferred_in_text(text: &str) -> Option<String> {
    learnable_preferred_in_text_from(text, &learnable_preferred_terms())
}

fn normalized_token(token: &str) -> String {
    token
        .trim_matches(|character: char| {
            !character.is_alphanumeric() && character != '+' && character != '#'
        })
        .to_lowercase()
}

fn tokens(text: &str) -> Vec<(String, String)> {
    text.split_whitespace()
        .filter_map(|raw| {
            let normalized = normalized_token(raw);
            (!normalized.is_empty()).then(|| (raw.to_string(), normalized))
        })
        .collect()
}

fn phonetic_key(text: &str) -> String {
    let mut value = text.to_lowercase();
    for (from, to) in [
        ("ph", "f"),
        ("ck", "k"),
        ("qu", "k"),
        ("tion", "shn"),
        ("x", "ks"),
        ("c", "k"),
        ("q", "k"),
        ("z", "s"),
    ] {
        value = value.replace(from, to);
    }
    let mut output = String::new();
    for character in value
        .chars()
        .filter(|character| character.is_alphanumeric())
    {
        let is_vowel = matches!(character, 'a' | 'e' | 'i' | 'o' | 'u' | 'y');
        if is_vowel && !output.is_empty() {
            continue;
        }
        if output.chars().next_back() != Some(character) {
            output.push(character);
        }
    }
    output
}

/// Compare a normal prompted decode with an unprompted decode and return one
/// conservative alias observation. The preferred spelling must appear only in
/// the prompted result, confidence must improve materially, and the changed
/// phrase must be phonetically close. This deliberately prefers missing a
/// learning opportunity over creating a destructive correction.
pub fn infer_learning_observation(
    prompted: &str,
    prompted_confidence: f32,
    unprompted: &str,
    unprompted_confidence: f32,
) -> Option<LearningObservation> {
    learnable_preferred_terms()
        .into_iter()
        .find_map(|preferred| {
            infer_learning_observation_for(
                &preferred,
                prompted,
                prompted_confidence,
                unprompted,
                unprompted_confidence,
            )
        })
}

pub fn infer_learning_observation_for(
    preferred: &str,
    prompted: &str,
    prompted_confidence: f32,
    unprompted: &str,
    unprompted_confidence: f32,
) -> Option<LearningObservation> {
    if prompted_confidence < 0.45
        || prompted_confidence > 0.85
        || prompted_confidence < unprompted_confidence + 0.05
    {
        return None;
    }

    let prompted_tokens = tokens(prompted);
    let unprompted_tokens = tokens(unprompted);
    if prompted_tokens.is_empty() || unprompted_tokens.is_empty() {
        return None;
    }

    let mut best: Option<(f64, LearningObservation)> = None;
    let preferred_tokens = tokens(preferred);
    if preferred_tokens.is_empty() || !is_learnable_preferred(preferred) {
        return None;
    }
    let preferred_normalized: Vec<&str> = preferred_tokens
        .iter()
        .map(|(_, normalized)| normalized.as_str())
        .collect();
    let Some(prompted_index) = prompted_tokens
        .windows(preferred_normalized.len())
        .position(|window| {
            window
                .iter()
                .map(|(_, normalized)| normalized.as_str())
                .eq(preferred_normalized.iter().copied())
        })
    else {
        return None;
    };
    if unprompted_tokens
        .windows(preferred_normalized.len())
        .any(|window| {
            window
                .iter()
                .map(|(_, normalized)| normalized.as_str())
                .eq(preferred_normalized.iter().copied())
        })
    {
        return None;
    }

    let min_start = prompted_index.saturating_sub(3);
    let max_start = (prompted_index + 3).min(unprompted_tokens.len().saturating_sub(1));
    let min_length = preferred_normalized.len().saturating_sub(1).max(1);
    let max_length = (preferred_normalized.len() + 2).min(4);
    for start in min_start..=max_start {
        for length in min_length..=max_length {
            let Some(window) = unprompted_tokens.get(start..start + length) else {
                continue;
            };
            let alias = window
                .iter()
                .map(|(original, _)| original.as_str())
                .collect::<Vec<_>>()
                .join(" ")
                .trim_matches(|character: char| !character.is_alphanumeric())
                .to_string();
            if alias.is_empty() || alias.len() > 64 || alias.eq_ignore_ascii_case(preferred.trim())
            {
                continue;
            }
            let phonetic_similarity =
                strsim::jaro_winkler(&phonetic_key(&alias), &phonetic_key(preferred));
            let spelling_similarity =
                strsim::normalized_levenshtein(&alias.to_lowercase(), &preferred.to_lowercase());
            let score = phonetic_similarity * 0.75 + spelling_similarity * 0.25;
            if phonetic_similarity < 0.78 || score < 0.70 {
                continue;
            }
            let observation = LearningObservation {
                preferred: preferred.to_string(),
                alias,
            };
            if best.as_ref().is_none_or(|(current, _)| score > *current) {
                best = Some((score, observation));
            }
        }
    }
    best.map(|(_, observation)| observation)
}

async fn persist_vocabulary<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entries: &[VocabularyEntry],
) -> Result<(), String> {
    use tauri::Manager;

    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| "application state is not ready".to_string())?;
    let json = serde_json::to_string(entries)
        .map_err(|error| format!("serialize custom dictionary: {error}"))?;
    crate::database::repositories::setting::SettingsRepository::set_custom_vocabulary(
        state.db_manager.pool(),
        &json,
    )
    .await
    .map_err(|error| format!("persist custom dictionary: {error}"))
}

/// Read persisted vocabulary and hydrate the active cache as one serialized
/// operation so an older database snapshot cannot overwrite newer learning.
pub async fn load_vocabulary<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<VocabularyEntry>, String> {
    use tauri::Manager;

    let _update_guard = VOCABULARY_UPDATE_LOCK.lock().await;
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return Ok(get_vocabulary());
    };
    let json = crate::database::repositories::setting::SettingsRepository::get_custom_vocabulary(
        state.db_manager.pool(),
    )
    .await
    .map_err(|error| format!("read custom dictionary: {error}"))?;
    let entries = match json {
        Some(json) => normalize_vocabulary(
            serde_json::from_str(&json)
                .map_err(|error| format!("invalid custom dictionary JSON: {error}"))?,
        ),
        None => Vec::new(),
    };
    set_vocabulary(entries.clone());
    Ok(entries)
}

/// Save user-authored terms/manual overrides without allowing a stale UI
/// snapshot to erase aliases learned concurrently by the backend.
pub async fn save_user_vocabulary<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entries: Vec<VocabularyEntry>,
) -> Result<Vec<VocabularyEntry>, String> {
    let _update_guard = VOCABULARY_UPDATE_LOCK.lock().await;
    let current = get_vocabulary();
    let mut proposed = normalize_vocabulary(entries);
    for entry in &mut proposed {
        entry.learned_aliases = current
            .iter()
            .find(|saved| saved.to.eq_ignore_ascii_case(&entry.to))
            .map(|saved| saved.learned_aliases.clone())
            .unwrap_or_default();
    }
    proposed = normalize_vocabulary(proposed);
    persist_vocabulary(app, &proposed).await?;
    set_vocabulary(proposed.clone());
    Ok(proposed)
}

pub async fn remove_learned_alias<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    preferred: &str,
    alias: &str,
) -> Result<Vec<VocabularyEntry>, String> {
    let _update_guard = VOCABULARY_UPDATE_LOCK.lock().await;
    let mut proposed = get_vocabulary();
    if let Some(entry) = proposed
        .iter_mut()
        .find(|entry| entry.to.eq_ignore_ascii_case(preferred))
    {
        entry
            .learned_aliases
            .retain(|learned| !learned.from.eq_ignore_ascii_case(alias));
    }
    persist_vocabulary(app, &proposed).await?;
    set_vocabulary(proposed.clone());
    Ok(proposed)
}

/// Record one local observation and persist before swapping the active cache.
/// A given alias can contribute at most once per recording session.
pub async fn record_learning_observation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    session_id: &str,
    observation: LearningObservation,
) -> Result<bool, String> {
    use tauri::Emitter;

    let evidence_key = (
        session_id.to_string(),
        observation.preferred.to_lowercase(),
        observation.alias.to_lowercase(),
    );
    let _update_guard = VOCABULARY_UPDATE_LOCK.lock().await;
    if OBSERVED_SESSIONS
        .lock()
        .map_err(|_| "vocabulary evidence lock poisoned".to_string())?
        .contains(&evidence_key)
    {
        return Ok(false);
    }
    let mut proposed = get_vocabulary();
    let Some(entry_index) = proposed
        .iter()
        .position(|entry| entry.to.eq_ignore_ascii_case(&observation.preferred))
    else {
        return Ok(false);
    };
    if !proposed[entry_index].from.trim().is_empty() {
        return Ok(false);
    }
    let conflict = proposed.iter().enumerate().any(|(index, entry)| {
        index != entry_index
            && (entry.to.eq_ignore_ascii_case(&observation.alias)
                || entry
                    .from
                    .split(',')
                    .map(str::trim)
                    .any(|alias| alias.eq_ignore_ascii_case(&observation.alias))
                || entry
                    .learned_aliases
                    .iter()
                    .any(|alias| alias.from.eq_ignore_ascii_case(&observation.alias)))
    });
    if conflict {
        return Ok(false);
    }

    let observations = {
        let entry = &mut proposed[entry_index];
        if let Some(alias) = entry
            .learned_aliases
            .iter_mut()
            .find(|alias| alias.from.eq_ignore_ascii_case(&observation.alias))
        {
            alias.observations = alias.observations.saturating_add(1);
            alias.observations
        } else {
            if entry.learned_aliases.len() >= MAX_LEARNED_ALIASES_PER_TERM {
                return Ok(false);
            }
            entry.learned_aliases.push(LearnedAlias {
                from: observation.alias.clone(),
                observations: 1,
            });
            1
        }
    };
    persist_vocabulary(app, &proposed).await?;
    set_vocabulary(proposed.clone());
    {
        let mut observed = OBSERVED_SESSIONS
            .lock()
            .map_err(|_| "vocabulary evidence lock poisoned".to_string())?;
        if observed.len() >= 512 {
            observed.clear();
        }
        observed.insert(evidence_key);
    }
    let alias = proposed[entry_index]
        .learned_aliases
        .iter()
        .find(|alias| alias.from.eq_ignore_ascii_case(&observation.alias))
        .cloned()
        .ok_or_else(|| "learned alias disappeared before event emission".to_string())?;
    let _ = app.emit(
        "vocabulary-learning-updated",
        VocabularyLearningUpdate {
            preferred: proposed[entry_index].to.clone(),
            alias,
        },
    );
    Ok(observations >= MIN_LEARNED_OBSERVATIONS)
}

/// Build a Whisper initial_prompt from the distinct, non-empty vocabulary `to`
/// terms (the correct spellings) plus the current meeting's context terms
/// (title, attendee names), or None when there is nothing to bias toward.
/// Capped so it can't crowd the prior-segment text out of the prompt budget.
pub fn whisper_initial_prompt_excluding(excluded: Option<&str>) -> Option<String> {
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
    // The current meeting is the strongest relevance signal. Reserve the
    // limited prompt budget for its title/attendees before global vocabulary.
    for t in meeting_prompt_terms() {
        push(&t, &mut terms, &mut total_chars);
    }
    for e in &entries {
        if excluded.is_some_and(|term| e.to.eq_ignore_ascii_case(term)) {
            continue;
        }
        push(&e.to, &mut terms, &mut total_chars);
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(", "))
    }
}

pub fn whisper_initial_prompt() -> Option<String> {
    whisper_initial_prompt_excluding(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vocabulary and meeting prompt terms are process-global; every test that
    // reads or mutates either shares one lock so parallel test execution is safe.
    static GLOBAL_PROMPT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_prompt_state() -> std::sync::MutexGuard<'static, ()> {
        GLOBAL_PROMPT_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn entry(from: &str, to: &str) -> VocabularyEntry {
        VocabularyEntry {
            from: from.into(),
            to: to.into(),
            learned_aliases: Vec::new(),
        }
    }

    #[test]
    fn replaces_case_insensitively_whole_word() {
        let v = vec![entry("cubernetes", "Kubernetes")];
        assert_eq!(
            apply_corrections("we deployed Cubernetes today", &v),
            "we deployed Kubernetes today"
        );
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
        assert_eq!(
            apply_corrections("C plus plus and c++ tools", &v),
            "C++ and C++ tools"
        );
    }

    #[test]
    fn corrections_do_not_cascade() {
        let v = vec![entry("cube", "Kubernetes"), entry("kubernetes", "K8s")];
        assert_eq!(
            apply_corrections("cube and kubernetes", &v),
            "Kubernetes and K8s"
        );
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
            vec![
                entry("cubernetes, kube, cooper netties", "Kubernetes"),
                entry("", "Moodle")
            ]
        );
    }

    #[test]
    fn deserializes_legacy_entries_without_learned_aliases() {
        let entries: Vec<VocabularyEntry> =
            serde_json::from_str(r#"[{"from":"cubernetes","to":"Kubernetes"}]"#).unwrap();
        assert_eq!(entries, vec![entry("cubernetes", "Kubernetes")]);
    }

    #[test]
    fn learned_alias_requires_repeated_evidence_before_correction() {
        let mut vocabulary = vec![entry("", "Kubernetes")];
        vocabulary[0].learned_aliases.push(LearnedAlias {
            from: "cooper netties".into(),
            observations: 1,
        });
        assert_eq!(
            apply_corrections("deploy cooper netties", &vocabulary),
            "deploy cooper netties"
        );
        vocabulary[0].learned_aliases[0].observations = MIN_LEARNED_OBSERVATIONS;
        assert_eq!(
            apply_corrections("deploy cooper netties", &vocabulary),
            "deploy Kubernetes"
        );
    }

    #[test]
    fn infers_phonetically_similar_alias_from_better_prompted_decode() {
        let _guard = lock_prompt_state();
        set_vocabulary(vec![entry("", "Kubernetes")]);
        let phonetic_similarity =
            strsim::jaro_winkler(&phonetic_key("cooper netties"), &phonetic_key("Kubernetes"));
        assert!(
            phonetic_similarity >= 0.78,
            "phonetic similarity was {phonetic_similarity}"
        );
        let observation = infer_learning_observation(
            "We deployed Kubernetes yesterday",
            0.74,
            "We deployed cooper netties yesterday",
            0.63,
        )
        .expect("expected a conservative phonetic match");
        assert_eq!(observation.preferred, "Kubernetes");
        assert_eq!(observation.alias, "cooper netties");
        set_vocabulary(Vec::new());
    }

    #[test]
    fn rejects_alias_when_prompt_does_not_improve_confidence() {
        let _guard = lock_prompt_state();
        set_vocabulary(vec![entry("", "Kubernetes")]);
        assert!(
            infer_learning_observation(
                "We deployed Kubernetes yesterday",
                0.70,
                "We deployed cooper netties yesterday",
                0.68,
            )
            .is_none()
        );
        set_vocabulary(Vec::new());
    }

    #[test]
    fn uppercase_acronyms_are_eligible_for_learning() {
        let _guard = lock_prompt_state();
        set_vocabulary(vec![entry("", "LXP")]);
        assert!(has_learnable_entries());
        let observation = infer_learning_observation(
            "The LXP refinement is ready",
            0.72,
            "The el ex pee refinement is ready",
            0.61,
        )
        .expect("spoken acronym should be learnable");
        assert_eq!(observation.alias, "el ex pee");
        set_vocabulary(Vec::new());
    }

    #[test]
    fn initial_prompt_dedupes_to_terms() {
        let _guard = lock_prompt_state();
        set_vocabulary(vec![
            entry("a", "Kubernetes"),
            entry("b", "Kubernetes"),
            entry("c", "muesly"),
        ]);
        let p = whisper_initial_prompt().unwrap();
        assert!(p.contains("Kubernetes") && p.contains("muesly"));
        assert_eq!(p.matches("Kubernetes").count(), 1);
        set_vocabulary(Vec::new()); // reset shared state for other tests
    }

    #[test]
    fn initial_prompt_includes_meeting_terms_until_cleared() {
        let _guard = lock_prompt_state();
        set_meeting_prompt_terms(vec![
            "Q3 Budget Sync".into(),
            "Afonso Ramos".into(),
            "  ".into(),           // blank terms are dropped
            "afonso ramos".into(), // case-insensitive duplicate is dropped
        ]);
        let p = whisper_initial_prompt().unwrap();
        assert!(p.contains("Q3 Budget Sync"), "prompt missing title: {p}");
        assert_eq!(p.matches("Afonso Ramos").count(), 1);

        clear_meeting_prompt_terms();
        let after = whisper_initial_prompt().unwrap_or_default();
        assert!(
            !after.contains("Q3 Budget Sync"),
            "terms must clear on stop: {after}"
        );
    }

    #[test]
    fn scoped_meeting_terms_clear_on_drop() {
        let _lock = lock_prompt_state();
        {
            let _scope = scoped_meeting_prompt_terms(vec!["LXP Refinement".into()]);
            assert!(whisper_initial_prompt().unwrap().contains("LXP Refinement"));
        }
        assert!(
            !whisper_initial_prompt()
                .unwrap_or_default()
                .contains("LXP Refinement")
        );
    }

    #[test]
    fn initial_prompt_terms_are_capped() {
        let _guard = lock_prompt_state();
        let long: Vec<String> = (0..100)
            .map(|i| format!("Attendee Number {i:03}"))
            .collect();
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
    fn excluding_one_term_preserves_meeting_context_and_other_vocabulary() {
        let _guard = lock_prompt_state();
        set_vocabulary(vec![entry("", "Kubernetes"), entry("", "Muesly")]);
        set_meeting_prompt_terms(vec!["LXP Refinement".into()]);

        let prompt = whisper_initial_prompt_excluding(Some("Kubernetes")).unwrap();
        assert!(!prompt.contains("Kubernetes"));
        assert!(prompt.contains("Muesly"));
        assert!(prompt.contains("LXP Refinement"));

        set_vocabulary(Vec::new());
        clear_meeting_prompt_terms();
    }

    #[test]
    fn prompt_snapshot_removes_target_from_every_context_without_adding_terms() {
        let prompt = "LXP, Muesly LXP Refinement We discussed LXP yesterday, TrailingTerm";
        let baseline = remove_term_from_initial_prompt(prompt, "LXP").unwrap();
        assert!(!baseline.to_lowercase().contains("lxp"));
        assert!(baseline.contains("Muesly"));
        assert!(baseline.contains("Refinement"));
        assert!(baseline.contains("TrailingTerm"));
        assert_eq!(remove_term_from_initial_prompt(prompt, "MissingTerm"), None);
    }

    #[test]
    fn targeted_inference_survives_dictionary_edits_after_prompt_snapshot() {
        let _guard = lock_prompt_state();
        set_vocabulary(vec![entry("", "LXP")]);
        let snapshot = learnable_preferred_terms();
        set_vocabulary(vec![entry("", "DifferentTerm")]);

        let preferred = learnable_preferred_in_text_from("The LXP refinement", &snapshot).unwrap();
        let observation = infer_learning_observation_for(
            &preferred,
            "The LXP refinement is ready",
            0.72,
            "The el ex pee refinement is ready",
            0.61,
        )
        .expect("snapshot target should remain inferable");
        assert_eq!(observation.preferred, "LXP");
        set_vocabulary(Vec::new());
    }

    #[test]
    fn replacement_text_is_literal_not_a_regex_template() {
        // A `to` containing `$` must be inserted verbatim, not treated as a
        // capture-group reference.
        let v = vec![entry("price", "$5")];
        assert_eq!(apply_corrections("the price today", &v), "the $5 today");
    }
}
