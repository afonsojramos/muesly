use crate::database::repositories::{
    meeting::MeetingsRepository, setting::SettingsRepository, summary::SummaryProcessesRepository,
};
use crate::providers::ollama::metadata::SHARED_METADATA_CACHE;
use crate::summary::language_detection::detect_summary_language;
use crate::summary::llm_client::{LLMProvider, generate_summary};
use crate::summary::metadata::{
    read_detected_summary_language_from_metadata, read_summary_language_from_metadata,
    write_detected_summary_language_to_metadata,
};
use crate::summary::processor::{
    clean_llm_markdown_output, extract_meeting_name_from_markdown, generate_meeting_summary,
};
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

// Global registry for cancellation tokens (thread-safe).
// Each entry carries a generation counter so an older job's cleanup cannot
// remove a newer regenerate's token (CancellationToken is not PartialEq).
static CANCELLATION_REGISTRY: Lazy<Arc<Mutex<HashMap<String, (u64, CancellationToken)>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));
static CANCELLATION_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Resolved LLM provider/auth/endpoint configuration for a generation call.
pub(crate) struct LlmCallSettings {
    pub(crate) provider: LLMProvider,
    pub(crate) api_key: String,
    pub(crate) ollama_endpoint: Option<String>,
    pub(crate) custom_openai_endpoint: Option<String>,
    pub(crate) custom_openai_max_tokens: Option<u32>,
    pub(crate) custom_openai_temperature: Option<f32>,
    pub(crate) custom_openai_top_p: Option<f32>,
}

/// Summary service - handles all summary generation logic
pub struct SummaryService;

impl SummaryService {
    /// Resolves the LLM provider, API key, and endpoint configuration for a
    /// generation call. Side-effect free so both summary and title generation
    /// can share it; the caller decides how to surface any error.
    pub(crate) async fn resolve_llm_call_settings(
        pool: &SqlitePool,
        model_provider: &str,
    ) -> Result<LlmCallSettings, String> {
        let provider = LLMProvider::from_str(model_provider)?;

        // Ollama / BuiltInAI / CustomOpenAI don't use the standard API key column.
        let api_key = if provider == LLMProvider::Ollama
            || provider == LLMProvider::BuiltInAI
            || provider == LLMProvider::CustomOpenAI
        {
            String::new()
        } else {
            match SettingsRepository::get_api_key(
                pool,
                model_provider,
                crate::keychain::keyring_store(),
            )
            .await
            {
                Ok(Some(key)) if !key.is_empty() => key,
                Ok(None) | Ok(Some(_)) => {
                    return Err(format!("API key not found for {}", model_provider));
                }
                Err(e) => {
                    return Err(format!(
                        "Failed to retrieve API key for {}: {}",
                        model_provider, e
                    ));
                }
            }
        };

        let ollama_endpoint = if provider == LLMProvider::Ollama {
            match SettingsRepository::get_model_config(pool).await {
                Ok(Some(config)) => config.ollama_endpoint,
                Ok(None) => None,
                Err(e) => {
                    info!("Failed to retrieve Ollama endpoint: {}, using default", e);
                    None
                }
            }
        } else {
            None
        };

        let (
            custom_openai_endpoint,
            custom_openai_api_key,
            custom_openai_max_tokens,
            custom_openai_temperature,
            custom_openai_top_p,
        ) = if provider == LLMProvider::CustomOpenAI {
            match SettingsRepository::get_custom_openai_config(
                pool,
                crate::keychain::keyring_store(),
            )
            .await
            {
                Ok(Some(config)) => {
                    info!("✓ Using custom OpenAI endpoint: {}", config.endpoint);
                    (
                        Some(config.endpoint),
                        config.api_key,
                        config.max_tokens.map(|t| t as u32),
                        config.temperature,
                        config.top_p,
                    )
                }
                Ok(None) => {
                    return Err(
                        "Custom OpenAI provider selected but no configuration found".to_string()
                    );
                }
                Err(e) => {
                    return Err(format!("Failed to retrieve custom OpenAI config: {}", e));
                }
            }
        } else {
            (None, None, None, None, None)
        };

        // CustomOpenAI carries its key in its own config, not the standard column.
        let api_key = if provider == LLMProvider::CustomOpenAI {
            custom_openai_api_key.unwrap_or_default()
        } else {
            api_key
        };

        Ok(LlmCallSettings {
            provider,
            api_key,
            ollama_endpoint,
            custom_openai_endpoint,
            custom_openai_max_tokens,
            custom_openai_temperature,
            custom_openai_top_p,
        })
    }

    /// Normalizes a model's raw title output into a clean single-line title:
    /// strips think blocks / code fences, takes the first non-empty line, drops
    /// a leading heading marker and surrounding quotes, removes a leading label
    /// such as "Meeting Summary:" or "Title:" the model sometimes prepends, and
    /// clamps the length.
    fn clean_generated_title(raw: &str) -> String {
        let cleaned = clean_llm_markdown_output(raw);
        let line = cleaned
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("");
        let line = line.trim_start_matches('#').trim();
        let mut line = line.trim_matches('"').trim_matches('\'').trim();

        // Models sometimes prepend a generic label ("Meeting Summary:", "Meeting
        // Report:", "Title:", ...) despite being told to output only the title.
        // Strip one such leading label and re-trim any quotes it wrapped.
        if let Some(rest) = Self::strip_leading_label(line) {
            line = rest.trim_matches('"').trim_matches('\'').trim();
        }

        if Self::is_title_placeholder(line) {
            return String::new();
        }

        line.chars()
            .take(120)
            .collect::<String>()
            .trim()
            .to_string()
    }

    /// Template scaffolding occasionally survives a small model's generation.
    /// It is an instruction leak, never a meaningful meeting title.
    fn is_title_placeholder(line: &str) -> bool {
        let normalized = line
            .trim()
            .trim_matches(|character| {
                matches!(
                    character,
                    '<' | '>' | '[' | ']' | '{' | '}' | '.' | ',' | ':' | ';' | '!' | '?'
                )
            })
            .trim()
            .to_ascii_lowercase()
            .replace('-', " ");
        let normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
        matches!(
            normalized.as_str(),
            "add title"
                | "add title here"
                | "ai generated title"
                | "meeting title"
                | "title"
                | "untitled"
        )
    }

    fn strip_summary_title(markdown: &str) -> String {
        let lines = markdown.lines();
        let Some(title_index) = lines.clone().position(|line| line.starts_with("# ")) else {
            return String::new();
        };
        lines
            .enumerate()
            .filter_map(|(index, line)| (index != title_index).then_some(line))
            .collect::<Vec<_>>()
            .join("\n")
            .trim_start()
            .to_string()
    }

    fn is_replaceable_title(title: &str) -> bool {
        let normalized = title.trim();
        if normalized.eq_ignore_ascii_case("new meeting") || Self::is_title_placeholder(normalized)
        {
            return true;
        }
        let Some(suffix) = normalized.strip_prefix("Meeting ") else {
            return false;
        };
        suffix.len() >= 10
            && suffix.chars().all(|character| {
                character.is_ascii_digit()
                    || matches!(character, '-' | '_' | ':' | ' ' | 'T' | 'Z' | '+')
            })
    }

    /// Generic label words a model may prepend before the real title.
    const TITLE_LABEL_WORDS: &[&str] = &[
        "meeting",
        "summary",
        "report",
        "title",
        "notes",
        "recap",
        "minutes",
        "overview",
        "transcript",
    ];
    /// Connector words allowed inside a label segment (e.g. "Summary of the").
    const TITLE_LABEL_CONNECTORS: &[&str] = &["of", "the", "and", "for", "a", "an", "on"];

    /// If `line` begins with a generic label segment followed by a `:` or spaced
    /// dash separator, returns the trimmed remainder. A leading segment counts as
    /// a label only when every word in it is a label word or a connector (and at
    /// least one is a label word), so real titles that contain a colon, such as
    /// "Project Phoenix: Kickoff", are left untouched.
    fn strip_leading_label(line: &str) -> Option<&str> {
        let (prefix_end, rest_start) = Self::find_label_separator(line)?;
        let rest = line[rest_start..].trim();
        if rest.is_empty() {
            return None;
        }
        let mut saw_label = false;
        for raw in line[..prefix_end].split_whitespace() {
            let word = raw
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_ascii_lowercase();
            if word.is_empty() {
                continue;
            }
            if Self::TITLE_LABEL_WORDS.contains(&word.as_str()) {
                saw_label = true;
            } else if !Self::TITLE_LABEL_CONNECTORS.contains(&word.as_str()) {
                return None;
            }
        }
        saw_label.then_some(rest)
    }

    /// Finds the earliest label separator (`:` or a spaced dash) in `line`,
    /// returning `(end_of_prefix, start_of_remainder)` byte offsets.
    fn find_label_separator(line: &str) -> Option<(usize, usize)> {
        let mut best: Option<(usize, usize)> = None;
        if let Some(i) = line.find(':') {
            best = Some((i, i + 1));
        }
        for pat in [" - ", " – ", " — "] {
            if let Some(i) = line.find(pat) {
                if best.map_or(true, |(b, _)| i < b) {
                    best = Some((i, i + pat.len()));
                }
            }
        }
        best
    }

    /// Generates a short, human-friendly meeting title from the transcript and
    /// persists it. Runs a single lightweight LLM call (independent of, and far
    /// cheaper than, the full summary) so every finished meeting gets a real
    /// title even when auto-summary is off. Best-effort: on failure the existing
    /// title is left untouched.
    pub async fn generate_meeting_title<R: tauri::Runtime>(
        app: AppHandle<R>,
        pool: SqlitePool,
        meeting_id: String,
        text: String,
        model_provider: String,
        model_name: String,
    ) -> Result<String, String> {
        if text.trim().is_empty() {
            return Err("Cannot generate a title from an empty transcript".to_string());
        }

        let meeting = MeetingsRepository::get_meeting_metadata(&pool, &meeting_id)
            .await
            .map_err(|e| format!("Failed to load meeting title: {e}"))?
            .ok_or_else(|| format!("Meeting not found: {meeting_id}"))?;
        let expected_title = meeting.title;
        if !Self::is_replaceable_title(&expected_title) {
            return Ok(expected_title);
        }

        let settings = Self::resolve_llm_call_settings(&pool, &model_provider).await?;
        let app_data_dir = app.path().app_data_dir().ok();

        // A title only needs the opening of the conversation; capping the input
        // keeps the call cheap and fast for every provider.
        let transcript_excerpt: String = text.chars().take(6000).collect();

        let system_prompt = "You write concise meeting titles. Given a transcript, reply with a single descriptive title of 3 to 7 words that names what the meeting was about. Output only the title text. Never prefix it with a label or category such as 'Meeting', 'Summary', 'Report', 'Notes', 'Recap', or 'Title' followed by a colon; for example, write 'Travel Plans and Logistics', not 'Meeting Report: Travel Plans and Logistics'. Transcript lines may be prefixed with 'Me:' or 'Them:'; never copy those prefixes. No quotes, no markdown, no trailing punctuation, no commentary.";
        let user_prompt = format!("Transcript:\n\n{}\n\nTitle:", transcript_excerpt);

        let client = crate::providers::common::http_client();
        let raw = generate_summary(
            &client,
            &settings.provider,
            &model_name,
            &settings.api_key,
            system_prompt,
            &user_prompt,
            settings.ollama_endpoint.as_deref(),
            settings.custom_openai_endpoint.as_deref(),
            Some(32),
            settings.custom_openai_temperature,
            settings.custom_openai_top_p,
            app_data_dir.as_ref(),
            None,
        )
        .await?;

        let title = Self::clean_generated_title(&raw);
        if title.is_empty() {
            return Err("Model returned an empty title".to_string());
        }

        let updated = MeetingsRepository::update_meeting_title_if_current(
            &pool,
            &meeting_id,
            &expected_title,
            &title,
        )
        .await
        .map_err(|e| format!("Failed to update meeting title: {}", e))?;
        if !updated {
            return Err("Meeting title changed while a title was being generated".to_string());
        }

        // Let the UI update the title live (the user may have already navigated
        // to the meeting while generation was in flight).
        let _ = app.emit(
            "meeting-title-updated",
            serde_json::json!({ "meeting_id": meeting_id, "title": title }),
        );

        info!(
            "✓ Auto-generated title for meeting {}: {}",
            meeting_id, title
        );
        Ok(title)
    }

    /// Resolves the on-disk folder for a meeting, if one is recorded.
    async fn meeting_folder(pool: &SqlitePool, meeting_id: &str) -> Option<PathBuf> {
        let meeting = MeetingsRepository::get_meeting_metadata(pool, meeting_id)
            .await
            .ok()??;
        meeting
            .folder_path
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from)
    }

    /// Detects the dominant supported summary language from the transcript text.
    fn detect_summary_language_from_text(text: &str) -> Option<String> {
        let transcript_texts = [text.to_string()];
        let detection = detect_summary_language(&transcript_texts);
        match &detection.language {
            Some(language) => {
                info!("Detected transcript summary language: {}", language);
            }
            None => {
                info!(
                    "Transcript summary language unknown: {:?}",
                    detection.reason
                );
            }
        }
        detection.language
    }

    /// Registers a new cancellation token for a meeting. If a prior generation
    /// is still registered for the same meeting, its token is cancelled first
    /// (single-flight: regenerate cancels the previous run).
    /// Returns `(generation, token)` so cleanup is generation-scoped.
    fn register_cancellation_token(meeting_id: &str) -> (u64, CancellationToken) {
        let token = CancellationToken::new();
        let r#gen = CANCELLATION_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut registry) = CANCELLATION_REGISTRY.lock() {
            match registry.insert(meeting_id.to_string(), (r#gen, token.clone())) {
                Some((_prev_gen, previous)) => {
                    info!(
                        "Cancelling previous summary generation for meeting: {}",
                        meeting_id
                    );
                    previous.cancel();
                }
                _ => {
                    info!("Registered cancellation token for meeting: {}", meeting_id);
                }
            }
        }
        (r#gen, token)
    }

    /// Cancels the summary generation for a meeting
    pub fn cancel_summary(meeting_id: &str) -> bool {
        if let Ok(registry) = CANCELLATION_REGISTRY.lock() {
            if let Some((_gen, token)) = registry.get(meeting_id) {
                info!("Cancelling summary generation for meeting: {}", meeting_id);
                token.cancel();
                return true;
            }
        }
        warn!(
            "No active summary generation found for meeting: {}",
            meeting_id
        );
        false
    }

    /// True while `gen` is still the registered generation for `meeting_id`. A
    /// newer regenerate replaces the registry entry with a higher gen, so an older
    /// job sees `false` and must not write its terminal status (completed / failed /
    /// cancelled) over the newer run's — the bug that let a stale job clobber a
    /// live one's result.
    fn is_current_generation(meeting_id: &str, r#gen: u64) -> bool {
        CANCELLATION_REGISTRY
            .lock()
            .ok()
            .and_then(|r| r.get(meeting_id).map(|(g, _)| *g == r#gen))
            .unwrap_or(false)
    }

    /// Cleans up the cancellation token after processing completes.
    /// Only removes the entry when the generation still matches so a newer
    /// regenerate's token is never wiped by a finishing older job.
    fn cleanup_cancellation_token(meeting_id: &str, r#gen: u64) {
        if let Ok(mut registry) = CANCELLATION_REGISTRY.lock() {
            let still_ours = registry
                .get(meeting_id)
                .map(|(g, _)| *g == r#gen)
                .unwrap_or(false);
            if still_ours {
                registry.remove(meeting_id);
                info!("Cleaned up cancellation token for meeting: {}", meeting_id);
            }
        }
    }
}

/// RAII guard: removes the meeting's cancellation token on drop when it still
/// matches the registered generation (early failure / success / cancel paths).
struct SummaryCancelGuard {
    meeting_id: String,
    r#gen: u64,
}

impl SummaryCancelGuard {
    fn new(meeting_id: &str, r#gen: u64) -> Self {
        Self {
            meeting_id: meeting_id.to_string(),
            r#gen,
        }
    }
}

impl Drop for SummaryCancelGuard {
    fn drop(&mut self) {
        SummaryService::cleanup_cancellation_token(&self.meeting_id, self.r#gen);
    }
}

// Re-open SummaryService impl for process methods (guard lives above).
impl SummaryService {
    /// Test-only: how many meetings currently have a registered cancel token.
    #[cfg(test)]
    fn registry_len() -> usize {
        CANCELLATION_REGISTRY.lock().map(|r| r.len()).unwrap_or(0)
    }

    /// Test-only: whether a meeting has a registered cancel token.
    #[cfg(test)]
    fn registry_has(meeting_id: &str) -> bool {
        CANCELLATION_REGISTRY
            .lock()
            .map(|r| r.contains_key(meeting_id))
            .unwrap_or(false)
    }

    /// Processes transcript in the background and generates summary
    ///
    /// This function is designed to be spawned as an async task and does not block
    /// the main thread. It updates the database with progress and results.
    ///
    /// # Arguments
    /// * `app` - Tauri app handle (data dir + phase event emits)
    /// * `pool` - SQLx connection pool
    /// * `meeting_id` - Unique identifier for the meeting
    /// * `text` - Full transcript text
    /// * `model_provider` - LLM provider name (e.g., "ollama", "openai")
    /// * `model_name` - Specific model (e.g., "gpt-4", "llama3.2:latest")
    /// * `custom_prompt` - Optional user-provided context
    /// * `template_id` - Template identifier (e.g., "daily_standup", "standard_meeting")
    pub async fn process_transcript_background<R: tauri::Runtime>(
        app: AppHandle<R>,
        pool: SqlitePool,
        meeting_id: String,
        text: String,
        model_provider: String,
        model_name: String,
        custom_prompt: String,
        template_id: String,
        summary_language: Option<String>,
    ) {
        let start_time = Instant::now();
        info!(
            "Starting background processing for meeting_id: {}",
            meeting_id
        );

        // Register cancellation token for this meeting (cancels any prior run).
        // RAII guard clears the registry entry on every exit path, including
        // early resolve failures that used to leak a dead token.
        let (cancel_gen, cancellation_token) = Self::register_cancellation_token(&meeting_id);
        let _cancel_guard = SummaryCancelGuard::new(&meeting_id, cancel_gen);

        // Resolve provider, API key, and endpoint configuration.
        let LlmCallSettings {
            provider,
            api_key: final_api_key,
            ollama_endpoint,
            custom_openai_endpoint,
            custom_openai_max_tokens,
            custom_openai_temperature,
            custom_openai_top_p,
        } = match Self::resolve_llm_call_settings(&pool, &model_provider).await {
            Ok(settings) => settings,
            Err(e) => {
                Self::update_process_failed(&pool, &meeting_id, &e).await;
                return;
            }
        };

        // Dynamically fetch context size based on provider and model
        // Reserve room in the context window for the generated summary plus
        // prompt overhead, otherwise near-limit transcripts overflow n_ctx
        // (llama-helper) or get silently truncated (Ollama).
        let generation_reserve =
            crate::summary::summary_engine::models::DEFAULT_MAX_TOKENS as usize + 300;

        let token_threshold = if provider == LLMProvider::Ollama {
            match SHARED_METADATA_CACHE
                .get_or_fetch(&model_name, ollama_endpoint.as_deref())
                .await
            {
                Ok(metadata) => {
                    let optimal = metadata.context_size.saturating_sub(generation_reserve);
                    info!(
                        "✓ Using dynamic context for {}: {} tokens (chunk size: {})",
                        model_name, metadata.context_size, optimal
                    );
                    optimal
                }
                Err(e) => {
                    warn!(
                        "Failed to fetch context for {}: {}. Using default 4000",
                        model_name, e
                    );
                    4000 // Fallback to safe default
                }
            }
        } else if provider == LLMProvider::BuiltInAI {
            // Get model's context size from registry
            use crate::summary::summary_engine::models;
            let model = models::get_model_by_name(&model_name)
                .ok_or_else(|| format!("Unknown model: {}", model_name));

            match model {
                Ok(model_def) => {
                    let optimal =
                        (model_def.context_size as usize).saturating_sub(generation_reserve);
                    info!(
                        "✓ Using BuiltInAI context size: {} tokens (chunk size: {})",
                        model_def.context_size, optimal
                    );
                    optimal
                }
                Err(e) => {
                    warn!("{}, using conservative single-pass floor", e);
                    512 // Safe floor: cannot overflow even a tiny context window
                }
            }
        } else {
            // Cloud providers (OpenAI, Claude, Groq, CustomOpenAI) handle large contexts automatically
            100000 // Effectively unlimited for single-pass processing
        };

        // Get app data directory for BuiltInAI provider
        let app_data_dir = app.path().app_data_dir().ok();

        // Optional pre-summary cleanup (disfluencies/casing). Controlled by the
        // `transcript_cleanup_enabled` setting (default off — extra LLM call).
        // Env `MUESLY_TRANSCRIPT_CLEANUP=1` still forces on for CI/dev overrides.
        let mut text = text;
        let cleanup_setting = SettingsRepository::get_transcript_cleanup_enabled(&pool)
            .await
            .unwrap_or(false);
        let cleanup_env = std::env::var("MUESLY_TRANSCRIPT_CLEANUP")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        if (cleanup_setting || cleanup_env) && crate::summary::cleanup::should_cleanup(&text, 200) {
            info!("Running transcript cleanup before summary");
            // Surface phase so the UI can show "Cleaning transcript…" while this runs.
            let _ = app.emit(
                "summary-phase",
                serde_json::json!({
                    "meeting_id": meeting_id,
                    "phase": "cleanup",
                }),
            );
            let sys = crate::summary::cleanup::cleanup_system_prompt().to_string();
            let user = crate::summary::cleanup::cleanup_user_prompt(&text);
            // Cleanup must return ~full transcript; use a size-aware budget, not
            // the summary default (4096), which truncates long meetings.
            let cleanup_tokens = Some(crate::summary::cleanup::cleanup_max_tokens(&text));
            match crate::summary::llm_client::generate_summary(
                &crate::providers::common::http_client(),
                &provider,
                &model_name,
                &final_api_key,
                &sys,
                &user,
                ollama_endpoint.as_deref(),
                custom_openai_endpoint.as_deref(),
                cleanup_tokens.or(custom_openai_max_tokens),
                custom_openai_temperature,
                custom_openai_top_p,
                app_data_dir.as_ref(),
                Some(&cancellation_token),
            )
            .await
            {
                Ok(cleaned)
                    if crate::summary::cleanup::accept_cleaned_transcript(&text, &cleaned, 0.7) =>
                {
                    text = cleaned;
                    info!("Transcript cleanup applied ({} chars)", text.len());
                }
                Ok(cleaned) if cleaned.trim().is_empty() => {
                    warn!("Transcript cleanup returned empty; using original")
                }
                Ok(cleaned) => warn!(
                    "Transcript cleanup looked truncated ({} -> {} chars); using original",
                    text.chars().count(),
                    cleaned.chars().count()
                ),
                Err(e) => warn!("Transcript cleanup failed (using original): {}", e),
            }
            let _ = app.emit(
                "summary-phase",
                serde_json::json!({
                    "meeting_id": meeting_id,
                    "phase": "summarizing",
                }),
            );
        }

        // Resolve output and transcript languages for the two-pass summary
        // pipeline. The explicit request wins; otherwise fall back to any saved
        // per-meeting override. The transcript language is auto-detected (and
        // cached in metadata) so non-English meetings still normalize to clean
        // English.
        let folder = Self::meeting_folder(&pool, &meeting_id).await;

        let summary_language = summary_language.or_else(|| {
            folder
                .as_deref()
                .and_then(|f| read_summary_language_from_metadata(f).ok().flatten())
        });
        if let Some(code) = &summary_language {
            info!("📝 Summary language preference: {}", code);
        }

        let detected_summary_language = folder
            .as_deref()
            .and_then(|f| {
                read_detected_summary_language_from_metadata(f)
                    .ok()
                    .flatten()
            })
            .or_else(|| Self::detect_summary_language_from_text(&text));
        if let Some(code) = &detected_summary_language {
            if let Some(f) = folder.as_deref() {
                if let Err(e) = write_detected_summary_language_to_metadata(f, Some(code)) {
                    warn!("Failed to persist detected summary language: {}", e);
                }
            }
        }

        // Calendar meeting context, redacted for this provider's egress. Any
        // failure collapses to None - it must never block summarization.
        let meeting_context_block = crate::calendar::service::meeting_context_block(
            &pool,
            &meeting_id,
            &provider,
            ollama_endpoint.as_deref(),
            custom_openai_endpoint.as_deref(),
        )
        .await;

        // Generate summary
        let client = crate::providers::common::http_client();
        let result = generate_meeting_summary(
            &client,
            &provider,
            &model_name,
            &final_api_key,
            &text,
            &custom_prompt,
            &template_id,
            token_threshold,
            ollama_endpoint.as_deref(),
            custom_openai_endpoint.as_deref(),
            custom_openai_max_tokens,
            custom_openai_temperature,
            custom_openai_top_p,
            app_data_dir.as_ref(),
            Some(&cancellation_token),
            summary_language.as_deref(),
            detected_summary_language.as_deref(),
            None,
            meeting_context_block.as_deref(),
        )
        .await;

        let duration = start_time.elapsed().as_secs_f64();

        // Cancellation token is cleaned up by `_cancel_guard` on drop.

        // If a newer regenerate has superseded this run, it now owns the meeting's
        // summary row. Writing our terminal status here would clobber the newer
        // run's state (e.g. stamp `cancelled`/`failed` over a live generation), so
        // bail before any DB write once we're no longer the current generation.
        if !Self::is_current_generation(&meeting_id, cancel_gen) {
            info!(
                "Summary generation for meeting {} was superseded; skipping terminal DB write",
                meeting_id
            );
            return;
        }

        match result {
            Ok((mut final_markdown, _english_markdown, num_chunks)) => {
                if num_chunks == 0 && final_markdown.is_empty() {
                    Self::update_process_failed(
                        &pool,
                        &meeting_id,
                        "Summary generation failed: No content was processed.",
                    )
                    .await;
                    return;
                }

                info!(
                    "✓ Successfully processed {} chunks for meeting_id: {}. Duration: {:.2}s",
                    num_chunks, meeting_id, duration
                );
                // Debug-only: the full summary is meeting content (potential PII),
                // so keep it out of info-level logs.
                debug!("final markdown ({} chars)", final_markdown.len());

                // Extract the meeting name from the summary's H1 heading and run it
                // through the same cleaner as standalone title generation, so a
                // model-added label like "Meeting Report:" is stripped here too.
                if let Some(raw_name) = extract_meeting_name_from_markdown(&final_markdown) {
                    let name = Self::clean_generated_title(&raw_name);
                    if !name.is_empty() {
                        info!(
                            "Updating meeting name to '{}' for meeting_id: {}",
                            name, meeting_id
                        );
                        match MeetingsRepository::get_meeting_metadata(&pool, &meeting_id).await {
                            Ok(Some(meeting)) if Self::is_replaceable_title(&meeting.title) => {
                                if let Err(e) = MeetingsRepository::update_meeting_title_if_current(
                                    &pool,
                                    &meeting_id,
                                    &meeting.title,
                                    &name,
                                )
                                .await
                                {
                                    error!(
                                        "Failed to update meeting name for {}: {}",
                                        meeting_id, e
                                    );
                                }
                            }
                            Ok(_) => info!("Meeting title changed; preserving the current title"),
                            Err(e) => {
                                error!("Failed to load meeting name for {}: {}", meeting_id, e)
                            }
                        }
                    }

                    // The first H1 is summary metadata, not body content. Remove it
                    // even when its value is rejected as template scaffolding.
                    info!("Stripping title from final_markdown");
                    final_markdown = Self::strip_summary_title(&final_markdown);
                }

                // Create result JSON with markdown only (summary_json will be added on first edit)
                let result_json = serde_json::json!({
                    "markdown": final_markdown,
                });

                // Update database with completed status
                match SummaryProcessesRepository::update_process_completed(
                    &pool,
                    &meeting_id,
                    result_json,
                    num_chunks,
                    duration,
                )
                .await
                {
                    Err(e) => {
                        error!("Failed to save completed process for {}: {}", meeting_id, e);
                    }
                    _ => {
                        info!("Summary saved successfully for meeting_id: {}", meeting_id);
                    }
                }
            }
            Err(e) => {
                // Check if error is due to cancellation
                if e.contains("cancelled") {
                    info!(
                        "Summary generation was cancelled for meeting_id: {}",
                        meeting_id
                    );
                    if let Err(db_err) =
                        SummaryProcessesRepository::update_process_cancelled(&pool, &meeting_id)
                            .await
                    {
                        error!(
                            "Failed to update DB status to cancelled for {}: {}",
                            meeting_id, db_err
                        );
                    }
                } else {
                    Self::update_process_failed(&pool, &meeting_id, &e).await;
                }
            }
        }
    }

    /// Updates the summary process status to failed with error message
    ///
    /// # Arguments
    /// * `pool` - SQLx connection pool
    /// * `meeting_id` - Meeting identifier
    /// * `error_msg` - Error message to store
    async fn update_process_failed(pool: &SqlitePool, meeting_id: &str, error_msg: &str) {
        error!(
            "Processing failed for meeting_id {}: {}",
            meeting_id, error_msg
        );
        if let Err(e) =
            SummaryProcessesRepository::update_process_failed(pool, meeting_id, error_msg).await
        {
            error!(
                "Failed to update DB status to failed for {}: {}",
                meeting_id, e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SummaryService;
    use super::*;

    #[test]
    fn register_cancels_previous_token_for_same_meeting() {
        let (_g1, t1) = SummaryService::register_cancellation_token("m-reg");
        assert!(!t1.is_cancelled());
        assert!(SummaryService::registry_has("m-reg"));
        let (g2, t2) = SummaryService::register_cancellation_token("m-reg");
        assert!(
            t1.is_cancelled(),
            "prior token must be cancelled on re-register"
        );
        assert!(!t2.is_cancelled());
        SummaryService::cleanup_cancellation_token("m-reg", g2);
        assert!(!SummaryService::registry_has("m-reg"));
    }

    #[test]
    fn cancel_guard_clears_registry_on_drop() {
        let (r#gen, _token) = SummaryService::register_cancellation_token("m-guard");
        {
            let _g = SummaryCancelGuard::new("m-guard", r#gen);
            assert!(SummaryService::registry_has("m-guard"));
        }
        assert!(
            !SummaryService::registry_has("m-guard"),
            "RAII guard must clear the registry entry"
        );
    }

    #[test]
    fn cleanup_does_not_remove_newer_token() {
        let (g1, _t1) = SummaryService::register_cancellation_token("m-race");
        let (g2, _t2) = SummaryService::register_cancellation_token("m-race");
        // Older job finishes and tries to clean up with its own generation.
        SummaryService::cleanup_cancellation_token("m-race", g1);
        assert!(
            SummaryService::registry_has("m-race"),
            "newer token must survive older cleanup"
        );
        SummaryService::cleanup_cancellation_token("m-race", g2);
        assert!(!SummaryService::registry_has("m-race"));
    }

    #[test]
    fn clean_generated_title_strips_quotes_and_clamps() {
        assert_eq!(
            SummaryService::clean_generated_title("\"Quarterly Planning Sync\""),
            "Quarterly Planning Sync"
        );
        assert_eq!(
            SummaryService::clean_generated_title("# Roadmap Review"),
            "Roadmap Review"
        );
    }

    #[test]
    fn clean_generated_title_takes_first_line_and_drops_think_block() {
        let raw = "<think>let me decide</think>\n\nDesign Review Kickoff\nextra commentary";
        assert_eq!(
            SummaryService::clean_generated_title(raw),
            "Design Review Kickoff"
        );
    }

    #[test]
    fn clean_generated_title_handles_empty() {
        assert_eq!(SummaryService::clean_generated_title("   \n  "), "");
    }

    #[test]
    fn clean_generated_title_rejects_template_placeholders() {
        for placeholder in [
            "<Add Title here>",
            "<Add Title here>.",
            "Add Title Here:",
            "[AI-Generated Title]",
            "# {{meeting title}}",
            "Title:",
            "Untitled",
            "Untitled.",
        ] {
            assert_eq!(
                SummaryService::clean_generated_title(placeholder),
                "",
                "placeholder should not become a persisted meeting title: {placeholder}"
            );
        }
    }

    #[test]
    fn strip_summary_title_removes_rejected_placeholder_heading() {
        let markdown = "## Preamble\n# <Add Title here>\n\n## Summary\nUseful content";
        assert_eq!(
            SummaryService::strip_summary_title(markdown),
            "## Preamble\n\n## Summary\nUseful content"
        );
    }

    #[test]
    fn replaceable_titles_are_limited_to_generated_defaults() {
        for title in [
            "New Meeting",
            "Meeting 2026-07-13",
            "Meeting 2026-07-13_23-17-39",
            "<Add Title here>",
        ] {
            assert!(SummaryService::is_replaceable_title(title), "{title}");
        }
        for title in [
            "Project Roadmap",
            "Meeting Room Booking",
            "Meeting 2026 roadmap",
        ] {
            assert!(!SummaryService::is_replaceable_title(title), "{title}");
        }
    }

    #[test]
    fn clean_generated_title_strips_label_prefixes() {
        assert_eq!(
            SummaryService::clean_generated_title("Meeting Summary: Travel Plans and Logistics"),
            "Travel Plans and Logistics"
        );
        assert_eq!(
            SummaryService::clean_generated_title("Title - Q3 Roadmap"),
            "Q3 Roadmap"
        );
        assert_eq!(
            SummaryService::clean_generated_title("Title: \"Budget Review\""),
            "Budget Review"
        );
    }

    #[test]
    fn clean_generated_title_keeps_titles_that_merely_start_with_a_label_word() {
        // No separator after the leading word: it is a real title, not a label.
        assert_eq!(
            SummaryService::clean_generated_title("Meeting Room Booking"),
            "Meeting Room Booking"
        );
        assert_eq!(
            SummaryService::clean_generated_title("Summary of Q3 Planning"),
            "Summary of Q3 Planning"
        );
    }

    #[test]
    fn clean_generated_title_strips_varied_label_prefixes() {
        assert_eq!(
            SummaryService::clean_generated_title("Meeting Report: Travel Logistics and Farewell"),
            "Travel Logistics and Farewell"
        );
        assert_eq!(
            SummaryService::clean_generated_title("Meeting Notes: Budget Review"),
            "Budget Review"
        );
    }

    #[test]
    fn summary_heading_path_strips_label_prefix() {
        // The summary path takes the markdown H1 and cleans it as the title; a
        // label the model put in the heading must not survive.
        let markdown =
            "# Meeting Report: Spanish Travel Planning Discussion\n\n## Summary\n- point";
        let raw = crate::summary::processor::extract_meeting_name_from_markdown(markdown)
            .expect("h1 present");
        assert_eq!(
            SummaryService::clean_generated_title(&raw),
            "Spanish Travel Planning Discussion"
        );
    }

    #[test]
    fn clean_generated_title_keeps_real_titles_with_a_colon() {
        // The pre-colon segment has a non-label word, so it is a real title.
        assert_eq!(
            SummaryService::clean_generated_title("Project Phoenix: Kickoff"),
            "Project Phoenix: Kickoff"
        );
        assert_eq!(
            SummaryService::clean_generated_title("Q3 Planning: Budget and Roadmap"),
            "Q3 Planning: Budget and Roadmap"
        );
    }
}
