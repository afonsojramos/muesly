//! Push-to-talk dictation commands.
//!
//! `start_dictation` opens a mic-only capture (gated so it never runs alongside a
//! meeting recording); `stop_dictation` ends the capture, resamples to 16 kHz,
//! transcribes the burst with whichever engine is warm, and returns the text
//! (also emitted as `dictation-text`). It deliberately skips the meeting
//! save/teardown path.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime};

use crate::audio::audio_processing::resample;
use crate::audio::recording_commands::{
    release_dictation_claim, try_claim_dictation,
};
use crate::database::repositories::dictation_preset::{
    DictationCleanupPreset, DictationCleanupPresetsRepository,
};
use crate::database::repositories::setting::SettingsRepository;
use crate::dictation::capture::DictationCapture;
use crate::state::AppState;

/// Sample rate the transcription engines expect for a burst.
const DICTATION_SAMPLE_RATE: u32 = 16_000;

/// The in-flight dictation capture, if any. `DictationCapture` is `Send`, so the
/// `!Send` cpal stream it owns never crosses this boundary.
static DICTATION_CAPTURE: Mutex<Option<DictationCapture>> = Mutex::new(None);

/// Releases the dictation single-flight claim on drop, so the claim is held for
/// the entire stop → transcribe → inject burst. Releasing eagerly (before
/// injection finished) let a fresh burst be claimed mid-injection.
struct DictationClaimGuard;
impl Drop for DictationClaimGuard {
    fn drop(&mut self) {
        release_dictation_claim();
    }
}

/// Start a push-to-talk dictation burst (mic-only). Rejected while a meeting is
/// recording or a dictation burst is already active.
#[tauri::command]
#[specta::specta]
pub async fn start_dictation() -> Result<(), String> {
    try_claim_dictation()?;
    let capture = match DictationCapture::start() {
        Ok(c) => c,
        Err(e) => {
            release_dictation_claim();
            return Err(format!("start dictation capture: {e}"));
        }
    };
    *DICTATION_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(capture);
    Ok(())
}

/// Stop the dictation burst, transcribe it, and return (and emit) the text.
#[tauri::command]
#[specta::specta]
pub async fn stop_dictation<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let capture = DICTATION_CAPTURE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    // Hold the claim until the whole burst finishes: this guard drops at function
    // exit (including every early return below). Releasing here — before transcribe
    // and inject — let a new burst start while this one was still injecting.
    let _claim = DictationClaimGuard;
    let capture = capture.ok_or_else(|| "no dictation in progress".to_string())?;

    let (samples, sample_rate) = capture
        .stop()
        .map_err(|e| format!("stop dictation capture: {e}"))?;
    if samples.is_empty() {
        return Ok(String::new());
    }

    let samples_16k = if sample_rate == DICTATION_SAMPLE_RATE {
        samples
    } else {
        resample(&samples, sample_rate, DICTATION_SAMPLE_RATE)
            .map_err(|e| format!("resample dictation audio: {e}"))?
    };

    let mut text = transcribe_burst(samples_16k).await?;

    // Optional local-AI cleanup before injection (best-effort, budget-bounded).
    if let Some(cleaned) = crate::dictation::cleanup::maybe_cleanup(&app, &text).await {
        text = cleaned;
    }

    // Best-effort insertion into the focused app (clipboard + synthesized paste,
    // on a blocking thread). The text is also emitted so the UI can surface it or
    // a permission prompt when injection isn't possible.
    // Track whether the text actually landed in the focused app. A failure here
    // (e.g. Accessibility not granted) previously vanished into a log line; report
    // it on the event so the UI can tell the user and let them copy the text.
    let mut injected = true;
    let mut inject_error: Option<String> = None;
    if !text.is_empty() {
        let app_for_inject = app.clone();
        let text_for_inject = text.clone();
        match tokio::task::spawn_blocking(move || {
            crate::dictation::inject::inject_text(&app_for_inject, &text_for_inject)
        })
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                log::warn!("Dictation injection failed: {e}");
                injected = false;
                inject_error = Some(e.to_string());
            }
            Err(e) => {
                log::warn!("Dictation injection task error: {e}");
                injected = false;
                inject_error = Some(e.to_string());
            }
        }
    }

    let _ = app.emit(
        "dictation-text",
        serde_json::json!({ "text": text, "injected": injected, "error": inject_error }),
    );
    Ok(text)
}

/// Whether the OS will accept synthesized text injection (Accessibility on macOS).
/// The frontend uses this to prompt the user to grant permission.
#[tauri::command]
#[specta::specta]
pub async fn dictation_accessibility_trusted() -> Result<bool, String> {
    Ok(crate::dictation::inject::accessibility_trusted())
}

/// Transcribe a 16 kHz mono burst with whichever engine is loaded. Dictation
/// keeps an engine warm, so this prefers a loaded Parakeet engine and otherwise
/// falls back to Whisper.
async fn transcribe_burst(samples_16k: Vec<f32>) -> Result<String, String> {
    let parakeet = {
        let guard = crate::parakeet_engine::commands::PARAKEET_ENGINE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    if let Some(engine) = parakeet {
        if engine.is_model_loaded().await {
            return crate::parakeet_engine::commands::parakeet_transcribe_audio(samples_16k).await;
        }
    }
    crate::whisper_engine::commands::whisper_transcribe_audio(samples_16k).await
}

// ============================================================================
// Cleanup settings + presets
// ============================================================================

/// Whether local-AI cleanup of dictated text is enabled.
#[tauri::command]
#[specta::specta]
pub async fn get_dictation_cleanup_enabled(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_dictation_cleanup_enabled(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

/// Enable or disable local-AI cleanup of dictated text.
#[tauri::command]
#[specta::specta]
pub async fn set_dictation_cleanup_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_dictation_cleanup_enabled(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())
}

/// List all dictation cleanup presets, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn list_dictation_cleanup_presets(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<DictationCleanupPreset>, String> {
    DictationCleanupPresetsRepository::list(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

/// Create a new (inactive) cleanup preset and return it.
#[tauri::command]
#[specta::specta]
pub async fn create_dictation_cleanup_preset(
    state: tauri::State<'_, AppState>,
    name: String,
    prompt: String,
) -> Result<DictationCleanupPreset, String> {
    DictationCleanupPresetsRepository::create(state.db_manager.pool(), &name, &prompt)
        .await
        .map_err(|e| e.to_string())
}

/// Update a cleanup preset's name and prompt.
#[tauri::command]
#[specta::specta]
pub async fn update_dictation_cleanup_preset(
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
    prompt: String,
) -> Result<(), String> {
    DictationCleanupPresetsRepository::update(state.db_manager.pool(), &id, &name, &prompt)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a cleanup preset.
#[tauri::command]
#[specta::specta]
pub async fn delete_dictation_cleanup_preset(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    DictationCleanupPresetsRepository::delete(state.db_manager.pool(), &id)
        .await
        .map_err(|e| e.to_string())
}

/// Make a cleanup preset the active one (clears the others).
#[tauri::command]
#[specta::specta]
pub async fn set_active_dictation_cleanup_preset(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    DictationCleanupPresetsRepository::set_active(state.db_manager.pool(), &id)
        .await
        .map_err(|e| e.to_string())
}
