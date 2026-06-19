//! Tauri commands for speaker diarization.
//!
//! Diarization runs once after a recording is saved: the meeting's audio is
//! decoded, downmixed to mono and resampled to 16 kHz, run through the
//! `diarization-helper` sidecar, and the resulting speaker turns are reconciled
//! onto the stored transcript segments (persisted as `speaker_id`).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::audio::audio_processing::{audio_to_mono, resample};
use crate::audio::decoder::decode_audio_file;
use crate::database::repositories::transcript::TranscriptsRepository;
use crate::diarization::{client, model, reconcile};
use crate::state::AppState;

/// Sample rate the diarization segmentation model expects.
const DIARIZATION_SAMPLE_RATE: u32 = 16_000;

/// Candidate recording file names inside a meeting folder, mirroring the
/// retranscription lookup.
const AUDIO_FILE_CANDIDATES: &[&str] = &[
    "audio.mp4",
    "audio.m4a",
    "audio.wav",
    "audio.mp3",
    "audio.flac",
    "audio.ogg",
    "recording.mp4",
    "audio.mkv",
    "audio.webm",
    "audio.wma",
];

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp4", "m4a", "wav", "mp3", "flac", "ogg", "mkv", "webm", "wma",
];

/// Find the recording file inside a meeting folder.
fn find_audio_file(folder: &Path) -> Result<PathBuf, String> {
    for name in AUDIO_FILE_CANDIDATES {
        let candidate = folder.join(name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()) {
                    return Ok(path);
                }
            }
        }
    }
    Err(format!("no audio file found in {}", folder.display()))
}

/// Whether both diarization models are present on disk.
#[tauri::command]
#[specta::specta]
pub async fn diarization_models_ready<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(model::models_ready(&app_data_dir))
}

/// Diarize a saved meeting: decode its audio, run the sidecar, reconcile speaker
/// turns onto the transcript segments, and persist `speaker_id`. Returns the
/// number of segments that received a speaker label.
#[tauri::command]
#[specta::specta]
pub async fn diarize_meeting<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    meeting_folder_path: String,
) -> Result<u32, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    if !model::models_ready(&app_data_dir) {
        return Err("diarization models are not downloaded".to_string());
    }
    let segmentation_model = model::segmentation_model_path(&app_data_dir);
    let embedding_model = model::embedding_model_path(&app_data_dir);

    let audio_path = find_audio_file(&PathBuf::from(&meeting_folder_path))?;
    let decoded = decode_audio_file(&audio_path).map_err(|e| format!("decode audio: {e}"))?;
    let mono = audio_to_mono(&decoded.samples, decoded.channels);
    let samples_16k = if decoded.sample_rate == DIARIZATION_SAMPLE_RATE {
        mono
    } else {
        resample(&mono, decoded.sample_rate, DIARIZATION_SAMPLE_RATE)
            .map_err(|e| format!("resample to 16kHz: {e}"))?
    };

    // The sidecar call is blocking (spawns a process and waits); keep it off the
    // async runtime's worker threads.
    let turns = tokio::task::spawn_blocking(move || {
        client::diarize(&samples_16k, &segmentation_model, &embedding_model, 0, 0.5)
    })
    .await
    .map_err(|e| format!("diarization task join error: {e}"))?
    .map_err(|e| format!("diarization failed: {e}"))?;

    let pool = state.db_manager.pool();
    let segments = TranscriptsRepository::segments_for_diarization(pool, &meeting_id)
        .await
        .map_err(|e| format!("load transcript segments: {e}"))?;

    let mut labeled = 0u32;
    for (id, start, end) in segments {
        if let Some(speaker) = reconcile::speaker_for_segment(start, end, &turns) {
            TranscriptsRepository::set_segment_speaker_id(pool, &id, Some(speaker as i64))
                .await
                .map_err(|e| format!("persist speaker_id: {e}"))?;
            labeled += 1;
        }
    }
    Ok(labeled)
}

/// Download the diarization models on demand, emitting
/// `diarization-model-download-progress`/`-complete`/`-error` events (mirroring
/// the Parakeet model-download flow).
#[tauri::command]
#[specta::specta]
pub async fn download_diarization_models<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

    let emitter = app.clone();
    let result = model::download_models(&app_data_dir, move |phase, downloaded, total| {
        let percent = if total > 0 {
            (downloaded as f64 / total as f64 * 100.0).round() as u32
        } else {
            0
        };
        let _ = emitter.emit(
            "diarization-model-download-progress",
            serde_json::json!({
                "phase": phase,
                "downloaded_bytes": downloaded,
                "total_bytes": total,
                "progress": percent,
            }),
        );
    })
    .await;

    match result {
        Ok(()) => {
            let _ = app.emit("diarization-model-download-complete", serde_json::json!({}));
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "diarization-model-download-error",
                serde_json::json!({ "error": e.to_string() }),
            );
            Err(format!("failed to download diarization models: {e}"))
        }
    }
}
