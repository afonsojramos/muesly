//! Tauri commands for speaker diarization.
//!
//! Diarization runs once after a recording is saved: the meeting's audio is
//! decoded, downmixed to mono and resampled to 16 kHz, run through the
//! `diarization-helper` sidecar, and the resulting speaker turns are reconciled
//! onto the stored transcript segments (persisted as `speaker_id`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::audio::audio_processing::{audio_to_mono, resample};
use crate::audio::decoder::decode_audio_file;
use crate::calendar::context;
use crate::database::repositories::calendar::CalendarEventsRepository;
use crate::database::repositories::meeting::MeetingsRepository;
use crate::database::repositories::speaker_names::SpeakerNamesRepository;
use crate::database::repositories::transcript::TranscriptsRepository;
use crate::diarization::{client, model, reconcile};
use crate::state::AppState;
use sqlx::SqlitePool;

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

/// Meetings currently being diarized, so two concurrent runs on the same meeting
/// can't interleave cluster/name writes (auto-run on stop + a manual re-run).
static DIARIZE_IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// RAII guard: marks a meeting as in-flight and clears the mark on drop.
struct DiarizeGuard(String);

impl Drop for DiarizeGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = DIARIZE_IN_FLIGHT.lock() {
            set.remove(&self.0);
        }
    }
}

/// Reserve a meeting for diarization, or `None` if a run is already in progress.
fn try_acquire_diarize(meeting_id: &str) -> Option<DiarizeGuard> {
    let mut set = DIARIZE_IN_FLIGHT.lock().ok()?;
    if set.contains(meeting_id) {
        return None;
    }
    set.insert(meeting_id.to_string());
    Some(DiarizeGuard(meeting_id.to_string()))
}

/// Diarize a saved meeting: decode its audio, run the sidecar, reconcile speaker
/// turns onto the transcript segments, and persist `speaker_id`. Returns the
/// number of segments that received a speaker label -- these are `system`
/// (remote) segments only; the mic side is always the local user and is never
/// cluster-labeled.
#[tauri::command]
#[specta::specta]
pub async fn diarize_meeting<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<u32, String> {
    // Serialize per meeting: held until this function returns.
    let _guard = try_acquire_diarize(&meeting_id)
        .ok_or_else(|| "diarization is already in progress for this meeting".to_string())?;

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
    // Decode + downmix + resample of a full meeting is heavy sync CPU/IO; keep it
    // off the async runtime's worker threads (only the sidecar call below was).
    let samples_16k = tokio::task::spawn_blocking(move || -> Result<Vec<f32>, String> {
        let decoded = decode_audio_file(&audio_path).map_err(|e| format!("decode audio: {e}"))?;
        let mono = audio_to_mono(&decoded.samples, decoded.channels);
        if decoded.sample_rate == DIARIZATION_SAMPLE_RATE {
            Ok(mono)
        } else {
            resample(&mono, decoded.sample_rate, DIARIZATION_SAMPLE_RATE)
                .map_err(|e| format!("resample to 16kHz: {e}"))
        }
    })
    .await
    .map_err(|e| format!("audio decode task join error: {e}"))??;

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
    let remote_names = remote_attendee_names(pool, &meeting_id).await?;
    let labeled = apply_diarization(pool, &meeting_id, &assignments, &remote_names).await?;

    // Let any open transcript view refresh instead of waiting for a reopen.
    let _ = app.emit(
        "diarization-complete",
        serde_json::json!({ "meeting_id": meeting_id }),
    );

    Ok(labeled)
}

/// The meeting's remote (non-self) attendee display names, from the persisted
/// calendar snapshot. Empty when there is no snapshot.
async fn remote_attendee_names(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Vec<String>, String> {
    let Some(event) = CalendarEventsRepository::get(pool, meeting_id)
        .await
        .map_err(|e| format!("load calendar event: {e}"))?
    else {
        return Ok(Vec::new());
    };
    Ok(context::snapshot_attendees(&event)
        .into_iter()
        .filter(|a| !a.is_self)
        .filter_map(|a| a.name)
        .filter(|n| !n.trim().is_empty())
        .collect())
}

/// Persist a diarization run atomically: clear prior names (cluster numbering is
/// not stable across runs), write every segment's new `speaker_id`, and
/// conservatively auto-name the single unambiguous cluster. One transaction, so
/// a failure can never leave new cluster ids paired with stale names (a
/// swapped-identity display) or a half-relabeled transcript. Returns the number
/// of system segments that received a cluster.
async fn apply_diarization(
    pool: &SqlitePool,
    meeting_id: &str,
    assignments: &[(String, Option<i64>)],
    remote_names: &[String],
) -> Result<u32, String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin diarization transaction: {e}"))?;

    SpeakerNamesRepository::clear_for_meeting(&mut *tx, meeting_id)
        .await
        .map_err(|e| format!("clear speaker names: {e}"))?;

    let mut labeled = 0u32;
    for (id, speaker_id) in assignments {
        TranscriptsRepository::set_segment_speaker_id(&mut *tx, id, *speaker_id)
            .await
            .map_err(|e| format!("persist speaker_id: {e}"))?;
        if speaker_id.is_some() {
            labeled += 1;
        }
    }

    let mut cluster_ids: Vec<i64> = assignments.iter().filter_map(|(_, s)| *s).collect();
    cluster_ids.sort_unstable();
    cluster_ids.dedup();
    if let Some((cluster, name)) = auto_fill_assignment(remote_names, &cluster_ids) {
        SpeakerNamesRepository::upsert(&mut *tx, meeting_id, cluster, &name)
            .await
            .map_err(|e| format!("auto-fill speaker name: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("commit diarization transaction: {e}"))?;
    Ok(labeled)
}

/// The single auto-fill assignment, only when the case is unambiguous: exactly
/// one non-empty remote attendee and exactly one cluster. Never guesses.
fn auto_fill_assignment(remote_names: &[String], cluster_ids: &[i64]) -> Option<(i64, String)> {
    match (remote_names, cluster_ids) {
        ([name], [cluster]) if !name.trim().is_empty() => Some((*cluster, name.clone())),
        _ => None,
    }
}

/// A diarized speaker cluster present in a meeting, with any assigned name.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct MeetingSpeaker {
    pub speaker_id: i64,
    pub name: Option<String>,
}

/// The speakers of a meeting plus the material to name them: the distinct remote
/// clusters, the non-self attendee shortlist, and the local user's name.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct MeetingSpeakers {
    pub speakers: Vec<MeetingSpeaker>,
    /// Remote (non-self) attendee names offered as a one-tap naming shortlist.
    pub shortlist: Vec<String>,
    /// The local user's display name, when known (labels the mic/"You" side).
    pub self_name: Option<String>,
}

/// Read a meeting's diarized clusters (with any assigned names) plus the attendee
/// shortlist and the local user's name, for the transcript's speaker UI.
#[tauri::command]
#[specta::specta]
pub async fn get_meeting_speakers(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<MeetingSpeakers, String> {
    meeting_speakers(state.db_manager.pool(), &meeting_id).await
}

/// Assemble a meeting's speakers from the diarized clusters, stored names, and
/// calendar attendees. Pool-level so it is testable without a Tauri `State`.
async fn meeting_speakers(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<MeetingSpeakers, String> {
    let clusters = TranscriptsRepository::distinct_speaker_ids(pool, meeting_id)
        .await
        .map_err(|e| format!("load speaker clusters: {e}"))?;
    let names = SpeakerNamesRepository::get_for_meeting(pool, meeting_id)
        .await
        .map_err(|e| format!("load speaker names: {e}"))?;
    let speakers = clusters
        .into_iter()
        .map(|speaker_id| MeetingSpeaker {
            speaker_id,
            name: names
                .iter()
                .find(|n| n.speaker_id == speaker_id)
                .map(|n| n.name.clone()),
        })
        .collect();

    let attendees = CalendarEventsRepository::get(pool, meeting_id)
        .await
        .map_err(|e| format!("load calendar event: {e}"))?
        .map(|e| context::snapshot_attendees(&e))
        .unwrap_or_default();
    let self_name = attendees
        .iter()
        .find(|a| a.is_self)
        .and_then(|a| a.name.clone());
    // Dedupe: two attendees can share a display name, and a duplicate would both
    // clutter the picker and (keyed by name) break the frontend's rename list.
    let mut shortlist: Vec<String> = Vec::new();
    for name in attendees
        .iter()
        .filter(|a| !a.is_self)
        .filter_map(|a| a.name.clone())
        .filter(|n| !n.trim().is_empty())
    {
        if !shortlist.contains(&name) {
            shortlist.push(name);
        }
    }

    Ok(MeetingSpeakers {
        speakers,
        shortlist,
        self_name,
    })
}

/// One `(speaker, speaker_id)` group's total speech time within a meeting.
/// `first_start` is the group's first appearance, which drives the frontend's
/// contiguous "Speaker N" numbering (same order the transcript labels use).
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct TalkTimeGroup {
    pub speaker: Option<String>,
    pub speaker_id: Option<i64>,
    pub seconds: f64,
    pub first_start: Option<f64>,
}

/// Per-speaker-group speech totals for a meeting, aggregated over ALL segments
/// in SQL (complete regardless of transcript pagination in the UI).
#[tauri::command]
#[specta::specta]
pub async fn get_talk_time(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<TalkTimeGroup>, String> {
    let rows = TranscriptsRepository::talk_time_groups(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|e| format!("aggregate talk time: {e}"))?;
    Ok(rows
        .into_iter()
        .map(|(speaker, speaker_id, seconds, first_start)| TalkTimeGroup {
            speaker,
            speaker_id,
            seconds,
            first_start,
        })
        .collect())
}

/// Assign (or rename) the name for a diarized cluster within a meeting.
#[tauri::command]
#[specta::specta]
pub async fn set_speaker_name(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    speaker_id: i64,
    name: String,
) -> Result<(), String> {
    // Validate at the boundary: never persist a blank name (the display would
    // just fall back to "Speaker N", leaving a junk row).
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("speaker name must not be empty".to_string());
    }
    let pool = state.db_manager.pool();
    SpeakerNamesRepository::upsert(pool, &meeting_id, speaker_id, trimmed)
        .await
        .map_err(|e| format!("set speaker name: {e}"))
}

/// Decide the `speaker_id` to persist for each segment.
///
/// - `system` (remote) segments always receive a diarized cluster when turns match.
/// - `mic` (local user) segments are always cleared — the local user stays off the
///   cluster axis so they are never mislabeled as a remote "Speaker N".
/// - `None` / unknown source (retranscribed or imported mixed audio) is treated as
///   diarizable, because there is no source split and the sidecar turns are the
///   only speaker signal available.
fn assign_speaker_ids(
    segments: &[(String, f64, f64, Option<String>)],
    turns: &[reconcile::SpeakerTurn],
) -> Vec<(String, Option<i64>)> {
    segments
        .iter()
        .map(|(id, start, end, speaker)| {
            let speaker_id = match speaker.as_deref() {
                Some("mic") => None,
                Some("system") | None => {
                    reconcile::speaker_for_segment(*start, *end, turns).map(|s| s as i64)
                }
                // Unknown non-empty source: still diarizable (defensive).
                Some(_) => {
                    reconcile::speaker_for_segment(*start, *end, turns).map(|s| s as i64)
                }
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
    use chrono::Utc;
    use sqlx::sqlite::SqlitePoolOptions;

    fn seg(id: &str, start: f64, end: f64, speaker: Option<&str>) -> (String, f64, f64, Option<String>) {
        (id.to_string(), start, end, speaker.map(|s| s.to_string()))
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn insert_meeting(pool: &SqlitePool, id: &str) {
        let now = Utc::now();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind("Test meeting")
            .bind(now)
            .bind(now)
            .execute(pool)
            .await
            .expect("insert meeting");
    }

    async fn insert_segment(pool: &SqlitePool, meeting_id: &str, id: &str, speaker: &str, speaker_id: Option<i64>) {
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, speaker_id) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(meeting_id)
        .bind("hello")
        .bind("00:00:01")
        .bind(speaker)
        .bind(speaker_id)
        .execute(pool)
        .await
        .expect("insert segment");
    }

    async fn insert_event(pool: &SqlitePool, meeting_id: &str, attendees_json: &str) {
        sqlx::query("INSERT INTO calendar_events (meeting_id, attendees_json, created_at) VALUES (?, ?, ?)")
            .bind(meeting_id)
            .bind(attendees_json)
            .bind(Utc::now())
            .execute(pool)
            .await
            .expect("insert event");
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
    fn null_source_segments_are_diarizable() {
        // Retranscribed / imported mixed audio has speaker: None; those segments
        // must still receive cluster ids so Speakers can label them.
        let segments = vec![seg("x-1", 0.0, 1.0, None)];
        let turns = [turn(0.0, 1.0, 0)];
        let out = assign_speaker_ids(&segments, &turns);
        assert_eq!(out[0], ("x-1".to_string(), Some(0)));
    }

    #[test]
    fn system_segment_without_overlap_is_cleared() {
        // Clears a stale cluster from an earlier run when no turn overlaps now.
        let segments = vec![seg("sys-1", 10.0, 11.0, Some("system"))];
        let turns = [turn(0.0, 1.0, 0)];
        let out = assign_speaker_ids(&segments, &turns);
        assert_eq!(out[0], ("sys-1".to_string(), None));
    }

    #[test]
    fn auto_fill_assigns_only_one_remote_to_one_cluster() {
        // AE3: one non-self attendee + one cluster -> auto-assign.
        let remote = vec!["Ana".to_string()];
        assert_eq!(
            auto_fill_assignment(&remote, &[2]),
            Some((2, "Ana".to_string()))
        );
    }

    #[test]
    fn auto_fill_declines_when_multiple_attendees_or_clusters() {
        // AE4: three attendees + three clusters -> no guess.
        let remote = vec!["Ana".to_string(), "Bruno".to_string(), "Carla".to_string()];
        assert_eq!(auto_fill_assignment(&remote, &[0, 1, 2]), None);
        // One attendee but two clusters -> still no guess.
        assert_eq!(auto_fill_assignment(&["Ana".to_string()], &[0, 1]), None);
        // One cluster but two attendees -> no guess.
        assert_eq!(
            auto_fill_assignment(&["Ana".to_string(), "Bruno".to_string()], &[0]),
            None
        );
    }

    #[test]
    fn auto_fill_declines_with_no_attendees_or_blank_name() {
        assert_eq!(auto_fill_assignment(&[], &[0]), None);
        assert_eq!(auto_fill_assignment(&["   ".to_string()], &[0]), None);
    }

    #[tokio::test]
    async fn meeting_speakers_assembles_clusters_shortlist_and_self() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        // Two remote clusters (0 and 1) plus a mic segment with no cluster.
        insert_segment(&pool, "m1", "t-mic", "mic", None).await;
        insert_segment(&pool, "m1", "t-sys-0", "system", Some(0)).await;
        insert_segment(&pool, "m1", "t-sys-1", "system", Some(1)).await;
        // Ana is the local user; Bruno and Carla are remote.
        insert_event(
            &pool,
            "m1",
            r#"[{"name":"Ana","status":"accepted","is_self":true},{"name":"Bruno","status":"accepted","is_self":false},{"name":"Carla","status":"accepted","is_self":false}]"#,
        )
        .await;
        // Cluster 0 already named Bruno; cluster 1 unnamed.
        SpeakerNamesRepository::upsert(&pool, "m1", 0, "Bruno")
            .await
            .expect("name cluster 0");

        let ms = meeting_speakers(&pool, "m1").await.expect("assemble");

        assert_eq!(ms.self_name.as_deref(), Some("Ana"));
        assert_eq!(ms.shortlist, vec!["Bruno".to_string(), "Carla".to_string()]);
        assert_eq!(ms.speakers.len(), 2);
        assert_eq!(ms.speakers[0].speaker_id, 0);
        assert_eq!(ms.speakers[0].name.as_deref(), Some("Bruno"));
        assert_eq!(ms.speakers[1].speaker_id, 1);
        assert_eq!(ms.speakers[1].name, None);
    }

    #[tokio::test]
    async fn meeting_speakers_without_calendar_event_has_empty_shortlist() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_segment(&pool, "m1", "t-sys-0", "system", Some(0)).await;

        let ms = meeting_speakers(&pool, "m1").await.expect("assemble");
        assert!(ms.shortlist.is_empty());
        assert_eq!(ms.self_name, None);
        assert_eq!(ms.speakers.len(), 1);
    }

    #[tokio::test]
    async fn meeting_speakers_dedupes_duplicate_attendee_names() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_segment(&pool, "m1", "t-sys-0", "system", Some(0)).await;
        insert_event(
            &pool,
            "m1",
            r#"[{"name":"Guest","status":"accepted","is_self":false},{"name":"Guest","status":"accepted","is_self":false}]"#,
        )
        .await;

        let ms = meeting_speakers(&pool, "m1").await.expect("assemble");
        // A duplicate display name must appear once (keyed rename list would break).
        assert_eq!(ms.shortlist, vec!["Guest".to_string()]);
    }

    #[tokio::test]
    async fn apply_diarization_labels_segments_and_auto_fills_the_single_remote() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_segment(&pool, "m1", "t-sys", "system", None).await;
        insert_event(
            &pool,
            "m1",
            r#"[{"name":"Ana","status":"accepted","is_self":true},{"name":"Bruno","status":"accepted","is_self":false}]"#,
        )
        .await;

        let remote = remote_attendee_names(&pool, "m1").await.expect("attendees");
        assert_eq!(remote, vec!["Bruno".to_string()], "self is excluded");

        let assignments = vec![("t-sys".to_string(), Some(0i64))];
        let labeled = apply_diarization(&pool, "m1", &assignments, &remote)
            .await
            .expect("apply");
        assert_eq!(labeled, 1);

        // The segment carries the cluster and the cluster carries the name.
        let sid: Option<i64> = sqlx::query_scalar("SELECT speaker_id FROM transcripts WHERE id = ?")
            .bind("t-sys")
            .fetch_one(&pool)
            .await
            .expect("segment");
        assert_eq!(sid, Some(0));
        let names = SpeakerNamesRepository::get_for_meeting(&pool, "m1")
            .await
            .expect("get");
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].name, "Bruno");
    }

    #[tokio::test]
    async fn apply_diarization_clears_stale_names_and_declines_ambiguity() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_segment(&pool, "m1", "t-sys", "system", None).await;
        // A name from a previous run must not survive re-diarization.
        SpeakerNamesRepository::upsert(&pool, "m1", 5, "Old Name")
            .await
            .expect("stale name");

        // Two remote names + one cluster -> ambiguous, no auto-fill.
        let remote = vec!["Bruno".to_string(), "Carla".to_string()];
        apply_diarization(&pool, "m1", &[("t-sys".to_string(), Some(0))], &remote)
            .await
            .expect("apply");
        assert!(
            SpeakerNamesRepository::get_for_meeting(&pool, "m1")
                .await
                .expect("get")
                .is_empty(),
            "stale names cleared, no guess made"
        );

        // No attendees at all (e.g. no calendar event) -> still no name, no error.
        insert_meeting(&pool, "m2").await;
        let none = remote_attendee_names(&pool, "m2").await.expect("attendees");
        assert!(none.is_empty());
        apply_diarization(&pool, "m2", &[("missing".to_string(), Some(0))], &none)
            .await
            .expect("apply");
        assert!(SpeakerNamesRepository::get_for_meeting(&pool, "m2")
            .await
            .expect("get")
            .is_empty());
    }
}
