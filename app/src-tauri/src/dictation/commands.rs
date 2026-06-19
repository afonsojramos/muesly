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
    can_start, is_dictation_active, is_recording_active, set_dictation_active,
};
use crate::dictation::capture::DictationCapture;

/// Sample rate the transcription engines expect for a burst.
const DICTATION_SAMPLE_RATE: u32 = 16_000;

/// The in-flight dictation capture, if any. `DictationCapture` is `Send`, so the
/// `!Send` cpal stream it owns never crosses this boundary.
static DICTATION_CAPTURE: Mutex<Option<DictationCapture>> = Mutex::new(None);

/// Start a push-to-talk dictation burst (mic-only). Rejected while a meeting is
/// recording or a dictation burst is already active.
#[tauri::command]
#[specta::specta]
pub async fn start_dictation() -> Result<(), String> {
    if !can_start(is_dictation_active(), is_recording_active()) {
        return Err("Cannot start dictation while recording or already dictating".to_string());
    }
    let capture = DictationCapture::start().map_err(|e| format!("start dictation capture: {e}"))?;
    *DICTATION_CAPTURE.lock().unwrap_or_else(|e| e.into_inner()) = Some(capture);
    set_dictation_active(true);
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
    set_dictation_active(false);
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

    let text = transcribe_burst(samples_16k).await?;
    let _ = app.emit("dictation-text", serde_json::json!({ "text": text }));
    Ok(text)
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
