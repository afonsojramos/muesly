//! Optional local-AI cleanup of dictated text before injection.
//!
//! When enabled, the dictated burst is rewritten by the local built-in model
//! using the active preset's instruction. It is best-effort and bounded: if the
//! model isn't ready or the budget is exceeded, the raw transcript is injected
//! instead, so dictation never blocks on a slow/cold model or injects stale text.

use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use tokio_util::sync::CancellationToken;

use crate::database::repositories::dictation_preset::DictationCleanupPresetsRepository;
use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::summary_engine::commands::{ModelManagerState, init_model_manager};
use crate::summary::summary_engine::{ModelStatus, generate_with_builtin};

/// Cleanup must finish within this budget or the raw text is injected instead.
/// A starting point; tune against the local model on-device.
const CLEANUP_BUDGET_MS: u64 = 2500;

/// Trim whitespace and strip a single pair of wrapping quotes the model may add
/// despite being told to output only the corrected text. Pure (testable).
pub fn clean_model_output(raw: &str) -> String {
    let trimmed = raw.trim();
    let unwrapped = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    unwrapped.trim().to_string()
}

/// Resolve the best ready built-in model, mirroring the summary flow's choice.
/// Returns `None` when none is downloaded (cleanup falls back to raw text).
async fn resolve_builtin_model<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let state = app.state::<ModelManagerState>();
    {
        let guard = state.0.lock().await;
        if guard.is_none() {
            drop(guard);
            init_model_manager(app).await.ok()?;
        }
    }
    let manager = {
        let guard = state.0.lock().await;
        guard.as_ref()?.clone()
    };
    manager.scan_models().await.ok()?;
    manager
        .list_models()
        .await
        .into_iter()
        .filter(|m| matches!(m.status, ModelStatus::Available))
        .max_by_key(|m| match m.name.as_str() {
            "qwen3.5:4b" => 4,
            "qwen3.5:2b" => 3,
            "gemma3:4b" => 2,
            "gemma3:1b" => 1,
            _ => 0,
        })
        .map(|m| m.name)
}

/// If dictation cleanup is enabled and a preset is active, rewrite `text` with
/// the local built-in AI and return the cleaned result. Returns `None` (caller
/// injects the raw text) when cleanup is off, no preset/model is ready, the
/// budget is exceeded, or it errors.
pub async fn maybe_cleanup<R: Runtime>(app: &AppHandle<R>, text: &str) -> Option<String> {
    let pool = app.state::<AppState>().db_manager.pool().clone();
    if !SettingsRepository::get_dictation_cleanup_enabled(&pool)
        .await
        .unwrap_or(false)
    {
        return None;
    }
    let preset = DictationCleanupPresetsRepository::active(&pool)
        .await
        .ok()
        .flatten()?;
    let model = resolve_builtin_model(app).await?;
    let app_data_dir = app.path().app_data_dir().ok()?;

    let token = CancellationToken::new();
    let generation =
        generate_with_builtin(&app_data_dir, &model, &preset.prompt, text, Some(&token));
    match tokio::time::timeout(Duration::from_millis(CLEANUP_BUDGET_MS), generation).await {
        Ok(Ok(raw)) => {
            let cleaned = clean_model_output(&raw);
            (!cleaned.is_empty()).then_some(cleaned)
        }
        // Over budget, generation error, or join issue: fall back to raw text.
        _ => {
            token.cancel();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_model_output_trims_and_unwraps_a_single_quote_pair() {
        assert_eq!(clean_model_output("  hello world  "), "hello world");
        assert_eq!(clean_model_output("\"hello world\""), "hello world");
        // Only a fully-wrapping pair is stripped, not interior quotes.
        assert_eq!(clean_model_output("\"quoted\" mid"), "\"quoted\" mid");
    }

    #[test]
    fn clean_model_output_blank_becomes_empty() {
        assert_eq!(clean_model_output("   \n  "), "");
    }
}
