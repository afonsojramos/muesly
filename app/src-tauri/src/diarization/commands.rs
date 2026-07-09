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
use crate::database::repositories::meeting::MeetingsRepository;
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

    // Resolve the recording folder from the database by meeting_id; never trust a
    // renderer-supplied path, so this command cannot be pointed at arbitrary files.
    let pool = state.db_manager.pool();
    let meeting = MeetingsRepository::get_meeting_metadata(pool, &meeting_id)
        .await
        .map_err(|e| format!("load meeting: {e}"))?
        .ok_or_else(|| format!("meeting {meeting_id} not found"))?;
    let folder_path = meeting
        .folder_path
        .ok_or_else(|| "meeting has no recording folder".to_string())?;

    let audio_path = find_audio_file(&PathBuf::from(&folder_path))?;
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

    let segments = TranscriptsRepository::segments_for_diarization(pool, &meeting_id)
        .await
        .map_err(|e| format!("load transcript segments: {e}"))?;

    // Only the `system` (remote) side is clustered; the mic side is always the
    // local user and is cleared so it can never be shown as a remote "Speaker N".
    let assignments = assign_speaker_ids(&segments, &turns);
    let mut labeled = 0u32;
    for (id, speaker_id) in assignments {
        TranscriptsRepository::set_segment_speaker_id(pool, &id, speaker_id)
            .await
            .map_err(|e| format!("persist speaker_id: {e}"))?;
        if speaker_id.is_some() {
            labeled += 1;
        }
    }
    Ok(labeled)
}

/// Decide the `speaker_id` to persist for each segment. Only `system` segments
/// (remote participants) receive a diarized cluster; every other segment (the
/// user's `mic`, or an unknown source) is cleared to `None`. This keeps the local
/// user off the cluster axis entirely, so they are never mislabeled as a remote
/// speaker, and clears any stale cluster left by an earlier run.
fn assign_speaker_ids(
    segments: &[(String, f64, f64, Option<String>)],
    turns: &[reconcile::SpeakerTurn],
) -> Vec<(String, Option<i64>)> {
    segments
        .iter()
        .map(|(id, start, end, speaker)| {
            let speaker_id = if speaker.as_deref() == Some("system") {
                reconcile::speaker_for_segment(*start, *end, turns).map(|s| s as i64)
            } else {
                None
            };
            (id.clone(), speaker_id)
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diarization::reconcile::SpeakerTurn;

    fn seg(id: &str, start: f64, end: f64, speaker: Option<&str>) -> (String, f64, f64, Option<String>) {
        (id.to_string(), start, end, speaker.map(|s| s.to_string()))
    }

    fn turn(start: f64, end: f64, speaker: i32) -> SpeakerTurn {
        SpeakerTurn { start, end, speaker }
    }

    #[test]
    fn only_system_segments_receive_a_cluster() {
        let segments = vec![
            seg("mic-1", 0.0, 1.0, Some("mic")),
            seg("sys-1", 1.0, 2.0, Some("system")),
        ];
        let turns = [turn(0.0, 2.0, 4)];
        let out = assign_speaker_ids(&segments, &turns);
        assert_eq!(out[0], ("mic-1".to_string(), None));
        assert_eq!(out[1], ("sys-1".to_string(), Some(4)));
    }

    #[test]
    fn mic_segment_is_cleared_even_when_a_turn_overlaps_it() {
        // A mic segment overlapping a diarizer turn must still be left None so the
        // user is never shown as a remote speaker.
        let segments = vec![seg("mic-1", 0.0, 5.0, Some("mic"))];
        let turns = [turn(0.0, 5.0, 2)];
        let out = assign_speaker_ids(&segments, &turns);
        assert_eq!(out[0], ("mic-1".to_string(), None));
    }

    #[test]
    fn unknown_source_segments_are_left_unlabeled() {
        let segments = vec![seg("x-1", 0.0, 1.0, None)];
        let turns = [turn(0.0, 1.0, 0)];
        let out = assign_speaker_ids(&segments, &turns);
        assert_eq!(out[0], ("x-1".to_string(), None));
    }

    #[test]
    fn system_segment_without_overlap_is_cleared() {
        // Clears a stale cluster from an earlier run when no turn overlaps now.
        let segments = vec![seg("sys-1", 10.0, 11.0, Some("system"))];
        let turns = [turn(0.0, 1.0, 0)];
        let out = assign_speaker_ids(&segments, &turns);
        assert_eq!(out[0], ("sys-1".to_string(), None));
    }
}
