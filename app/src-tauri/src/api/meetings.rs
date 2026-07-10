// Meeting CRUD + transcript command handlers.
use log::{debug as log_debug, error as log_error, info as log_info, warn as log_warn};
use tauri::{AppHandle, Runtime};

use crate::{
    database::{
        models::MeetingModel,
        repositories::{
            meeting::MeetingsRepository, notes::MeetingNotesRepository,
            transcript::TranscriptsRepository,
        },
    },
    state::AppState,
};

use super::types::*;

#[tauri::command]
#[specta::specta]
pub async fn api_get_meetings<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth_token: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<Vec<Meeting>, String> {
    log_info!(
        "api_get_meetings called with auth_token(native): {}, page: {:?}, page_size: {:?}",
        auth_token.is_some(),
        page,
        page_size,
    );
    let pool = state.db_manager.pool();
    let (limit, offset) = match (page, page_size) {
        (Some(p), Some(ps)) => {
            let lim = ps as i64;
            let off = (p.saturating_sub(1) as i64) * lim;
            (Some(lim), Some(off))
        }
        _ => (None, None),
    };
    let meetings: Result<Vec<MeetingModel>, sqlx::Error> =
        MeetingsRepository::get_meetings(pool, limit, offset).await;

    match meetings {
        Ok(meeting_models) => {
            log_info!("Successfully got {} meetings", meeting_models.len());

            let result: Vec<Meeting> = meeting_models
                .into_iter()
                .map(|m| Meeting {
                    id: m.id,
                    title: m.title,
                    created_at: m.created_at.0.to_rfc3339(),
                    folder_id: m.folder_id,
                })
                .collect();
            Ok(result)
        }
        Err(e) => {
            log_error!("Error getting meetings: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_search_transcripts<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    query: String,
    auth_token: Option<String>,
) -> Result<Vec<TranscriptSearchResult>, String> {
    log_info!(
        "api_search_transcripts called with query: '{}', auth_token: {}",
        query,
        auth_token.is_some()
    );

    let pool = state.db_manager.pool();

    match TranscriptsRepository::search_transcripts(pool, &query).await {
        Ok(results) => {
            log_info!(
                "Search completed successfully with {} results.",
                results.len()
            );
            Ok(results)
        }
        Err(e) => {
            log_error!("Error searching transcripts for query '{}': {}", query, e);
            Err(format!("Failed to search transcripts: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_delete_meeting<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_delete_meeting called for meeting_id(native): {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );

    let pool = state.db_manager.pool();

    // Soft delete: move to trash so it can be restored. Permanent removal happens
    // via api_permanently_delete_meeting from the Trash view.
    match MeetingsRepository::soft_delete_meeting(pool, &meeting_id).await {
        Ok(true) => {
            log_info!("Moved meeting {} to trash", meeting_id);
            Ok(serde_json::json!({
                "status": "success",
                "message": "Meeting moved to trash"
            }).into())
        }
        Ok(false) => {
            log_warn!("Meeting not found or already in trash: {}", meeting_id);
            Err(format!(
                "Meeting not found or could not be deleted: {}",
                meeting_id
            ))
        }
        Err(e) => {
            log_error!("Error deleting meeting {}: {}", meeting_id, e);
            Err(format!("Failed to delete meeting: {}", e))
        }
    }
}

/// List meetings currently in the trash (soft-deleted, restorable).
#[tauri::command]
#[specta::specta]
pub async fn api_get_trashed_meetings<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth_token: Option<String>,
) -> Result<Vec<Meeting>, String> {
    log_info!("api_get_trashed_meetings called, auth_token: {}", auth_token.is_some());
    let pool = state.db_manager.pool();
    match MeetingsRepository::get_trashed_meetings(pool).await {
        Ok(models) => Ok(models
            .into_iter()
            .map(|m| Meeting {
                id: m.id,
                title: m.title,
                created_at: m.created_at.0.to_rfc3339(),
                folder_id: m.folder_id,
            })
            .collect()),
        Err(e) => {
            log_error!("Error listing trashed meetings: {}", e);
            Err(format!("Failed to list trashed meetings: {}", e))
        }
    }
}

/// Restore a meeting from the trash back to the active list.
#[tauri::command]
#[specta::specta]
pub async fn api_restore_meeting<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    _auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    let pool = state.db_manager.pool();
    match MeetingsRepository::restore_meeting(pool, &meeting_id).await {
        Ok(true) => {
            log_info!("Restored meeting {} from trash", meeting_id);
            Ok(serde_json::json!({ "status": "success", "message": "Meeting restored" }).into())
        }
        Ok(false) => Err(format!("Meeting not found in trash: {}", meeting_id)),
        Err(e) => {
            log_error!("Error restoring meeting {}: {}", meeting_id, e);
            Err(format!("Failed to restore meeting: {}", e))
        }
    }
}

/// Permanently delete a meeting and all its data (used from the Trash view).
/// After a successful DB hard-delete, removes the recording folder on disk when
/// it lies under an allowed root (recordings folder / app data). Paths outside
/// those roots are left alone (never `remove_dir_all` on untrusted paths).
#[tauri::command]
#[specta::specta]
pub async fn api_permanently_delete_meeting<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    _auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    let pool = state.db_manager.pool();

    // Capture folder_path before the row is deleted.
    let folder_path = MeetingsRepository::get_meeting_metadata(pool, &meeting_id)
        .await
        .map_err(|e| format!("Failed to load meeting for permanent delete: {e}"))?
        .and_then(|m| m.folder_path);

    match MeetingsRepository::delete_meeting(pool, &meeting_id).await {
        Ok(true) => {
            if let Some(folder) = folder_path.as_deref().filter(|p| !p.trim().is_empty()) {
                match crate::allowed_roots_for_app(&app).await {
                    Ok(roots) => match crate::validate_path_within_roots(folder, &roots, false) {
                        Ok(validated) => {
                            if validated.is_dir() {
                                if let Err(e) = std::fs::remove_dir_all(&validated) {
                                    // DB is already gone; surface a warning but do not
                                    // fail the command — the user-facing delete succeeded.
                                    log_warn!(
                                        "Permanently deleted meeting {} but failed to remove folder {}: {}",
                                        meeting_id,
                                        validated.display(),
                                        e
                                    );
                                } else {
                                    log_info!(
                                        "Removed recording folder for meeting {}: {}",
                                        meeting_id,
                                        validated.display()
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            log_warn!(
                                "Skipping disk delete for meeting {} (path not under allowed roots): {}",
                                meeting_id,
                                e
                            );
                        }
                    },
                    Err(e) => {
                        log_warn!(
                            "Could not resolve allowed roots for disk delete of meeting {}: {}",
                            meeting_id,
                            e
                        );
                    }
                }
            }
            log_info!("Permanently deleted meeting {}", meeting_id);
            Ok(serde_json::json!({ "status": "success", "message": "Meeting permanently deleted" }).into())
        }
        Ok(false) => Err(format!("Meeting not found: {}", meeting_id)),
        Err(e) => {
            log_error!("Error permanently deleting meeting {}: {}", meeting_id, e);
            Err(format!("Failed to permanently delete meeting: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_get_meeting<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    state: tauri::State<'_, AppState>,
    auth_token: Option<String>,
) -> Result<MeetingDetails, String> {
    log_info!(
        "api_get_meeting called(native) for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );

    let pool = state.db_manager.pool();

    match MeetingsRepository::get_meeting(pool, &meeting_id).await {
        Ok(Some(meeting)) => {
            log_info!("Successfully retrieved meeting {}", meeting_id);
            Ok(meeting)
        }
        Ok(None) => {
            log_warn!("Meeting not found: {}", meeting_id);
            Err(format!("Meeting not found: {}", meeting_id))
        }
        Err(e) => {
            log_error!("Error retrieving meeting {}: {}", meeting_id, e);
            Err(format!("Failed to retrieve meeting: {}", e))
        }
    }
}

/// Get meeting metadata without transcripts (for pagination)
#[tauri::command]
#[specta::specta]
pub async fn api_get_meeting_metadata<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<MeetingMetadata, String> {
    log_info!("api_get_meeting_metadata called for meeting_id: {}", meeting_id);

    let pool = state.db_manager.pool();

    match MeetingsRepository::get_meeting_metadata(pool, &meeting_id).await {
        Ok(Some(meeting)) => {
            log_info!("Successfully retrieved meeting metadata {}", meeting_id);
            Ok(MeetingMetadata {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                folder_path: meeting.folder_path,
            })
        }
        Ok(None) => {
            log_warn!("Meeting not found: {}", meeting_id);
            Err(format!("Meeting not found: {}", meeting_id))
        }
        Err(e) => {
            log_error!("Error retrieving meeting metadata {}: {}", meeting_id, e);
            Err(format!("Failed to retrieve meeting metadata: {}", e))
        }
    }
}

/// Get paginated transcripts for a meeting
#[tauri::command]
#[specta::specta]
pub async fn api_get_meeting_transcripts<R: Runtime>(
    _app: AppHandle<R>,
    meeting_id: String,
    limit: i64,
    offset: i64,
    state: tauri::State<'_, AppState>,
) -> Result<PaginatedTranscriptsResponse, String> {
    log_info!(
        "api_get_meeting_transcripts called for meeting_id: {}, limit: {}, offset: {}",
        meeting_id,
        limit,
        offset
    );

    let pool = state.db_manager.pool();

    match MeetingsRepository::get_meeting_transcripts_paginated(pool, &meeting_id, limit, offset).await {
        Ok((transcripts, total_count)) => {
            log_info!(
                "Successfully retrieved {} transcripts for meeting {} (total: {})",
                transcripts.len(),
                meeting_id,
                total_count
            );

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                    speaker: t.speaker,
                    speaker_id: t.speaker_id,
                })
                .collect::<Vec<_>>();

            let has_more = (offset + meeting_transcripts.len() as i64) < total_count;

            Ok(PaginatedTranscriptsResponse {
                transcripts: meeting_transcripts,
                total_count,
                has_more,
            })
        }
        Err(e) => {
            log_error!("Error retrieving transcripts for meeting {}: {}", meeting_id, e);
            Err(format!("Failed to retrieve transcripts: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_save_meeting_title<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    title: String,
    auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_save_meeting_title called for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );
    let pool = state.db_manager.pool();
    match MeetingsRepository::update_meeting_title(pool, &meeting_id, &title).await {
        Ok(true) => {
            log_info!("Successfully saved meeting title");
            Ok(serde_json::json!({"message": "Meeting title saved successfully"}).into())
        }
        Ok(false) => {
            log_error!("No meeting found with id {}", meeting_id);
            Err(format!("No meeting found with id {}", meeting_id))
        }
        Err(e) => {
            log_error!("Failed to update meeting {}", e);
            Err(format!("Failed to update meeting: {}", e))
        }
    }
}

/// Export a meeting's note as a Markdown file. Opens a native Save dialog and
/// writes the provided markdown to the chosen path. Returns the saved path, or
/// `None` if the user cancelled. The frontend builds the markdown (title +
/// summary) so this stays a thin save helper.
#[tauri::command]
#[specta::specta]
pub async fn api_export_meeting_markdown<R: Runtime>(
    app: AppHandle<R>,
    default_file_name: String,
    contents: String,
    _auth_token: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .set_file_name(&default_file_name)
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    match rx.await.map_err(|_| "Save dialog was dismissed".to_string())? {
        Some(file_path) => {
            let path = file_path
                .into_path()
                .map_err(|e| format!("Invalid save path: {}", e))?;
            std::fs::write(&path, contents.as_bytes())
                .map_err(|e| format!("Failed to write file: {}", e))?;
            log_info!("Exported meeting note to {}", path.display());
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

/// Persist the user's in-meeting notes (markdown) for a meeting.
#[tauri::command]
#[specta::specta]
pub async fn api_save_meeting_notes<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    notes_markdown: String,
    auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_save_meeting_notes called for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );
    let pool = state.db_manager.pool();
    match MeetingNotesRepository::upsert_notes(pool, &meeting_id, &notes_markdown).await {
        Ok(true) => Ok(serde_json::json!({"message": "Meeting notes saved successfully"}).into()),
        Ok(false) => {
            log_error!("No meeting found with id {}", meeting_id);
            Err(format!("No meeting found with id {}", meeting_id))
        }
        Err(e) => {
            log_error!("Failed to save meeting notes: {}", e);
            Err(format!("Failed to save meeting notes: {}", e))
        }
    }
}

/// Load the user's saved notes for a meeting, plus the per-meeting summary
/// context. Both live on the same `meeting_notes` row, so a single read returns
/// them together; each field is empty when nothing has been saved yet.
#[tauri::command]
#[specta::specta]
pub async fn api_get_meeting_notes<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    auth_token: Option<String>,
) -> Result<NotesResponse, String> {
    log_info!(
        "api_get_meeting_notes called for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );
    let pool = state.db_manager.pool();
    match MeetingNotesRepository::get_notes(pool, &meeting_id).await {
        Ok(notes) => {
            let (notes_markdown, summary_context) = match notes {
                Some(n) => (n.notes_markdown, n.summary_context),
                None => (None, None),
            };
            Ok(NotesResponse {
                meeting_id,
                notes_markdown,
                summary_context,
            })
        }
        Err(e) => {
            log_error!("Failed to load meeting notes: {}", e);
            Err(format!("Failed to load meeting notes: {}", e))
        }
    }
}

/// Persist the per-meeting context the user types to steer AI summary
/// generation. Stored alongside notes on the `meeting_notes` row.
#[tauri::command]
#[specta::specta]
pub async fn api_save_meeting_summary_context<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    summary_context: String,
    auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_save_meeting_summary_context called for meeting_id: {}, auth_token: {}",
        meeting_id,
        auth_token.is_some()
    );
    let pool = state.db_manager.pool();
    match MeetingNotesRepository::upsert_summary_context(pool, &meeting_id, &summary_context).await {
        Ok(true) => Ok(serde_json::json!({"message": "Meeting summary context saved successfully"}).into()),
        Ok(false) => {
            log_error!("No meeting found with id {}", meeting_id);
            Err(format!("No meeting found with id {}", meeting_id))
        }
        Err(e) => {
            log_error!("Failed to save meeting summary context: {}", e);
            Err(format!("Failed to save meeting summary context: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_save_transcript<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_title: String,
    transcripts: Vec<crate::json::Json>,
    folder_path: Option<String>,
    auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    let transcripts: Vec<serde_json::Value> = transcripts.into_iter().map(|j| j.0).collect();
    log_info!(
        "api_save_transcript called for meeting: {}, transcripts: {}, folder_path: {:?}, auth_token: {}",
        meeting_title,
        transcripts.len(),
        folder_path,
        auth_token.is_some()
    );

    // Log first transcript for debugging
    if let Some(first) = transcripts.first() {
        log_debug!(
            "First transcript data: {}",
            serde_json::to_string_pretty(first).unwrap_or_default()
        );
    }

    // Convert serde_json::Value to TranscriptSegment
    let transcripts_to_save: Vec<TranscriptSegment> = transcripts
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| {
            log_error!("Failed to parse transcript segments: {}", e);
            format!("Invalid transcript data format: {}. Please check the data structure.", e)
        })?;

    // Log parsed segments count and first segment details
    if let Some(first_seg) = transcripts_to_save.first() {
        log_debug!("First parsed segment: text='{}', audio_start_time={:?}, audio_end_time={:?}, duration={:?}",
                   first_seg.text.chars().take(50).collect::<String>(),
                   first_seg.audio_start_time,
                   first_seg.audio_end_time,
                   first_seg.duration);
    }

    let pool = state.db_manager.pool();

    // Now, call the repository with the correctly typed data.
    match TranscriptsRepository::save_transcript(
        pool,
        &meeting_title,
        &transcripts_to_save,
        folder_path,
    )
    .await
    {
        Ok(meeting_id) => {
            log_info!(
                "Successfully saved transcript and created meeting with id: {}",
                meeting_id
            );
            Ok(serde_json::json!({
                "status": "success",
                "message": "Transcript saved successfully",
                "meeting_id": meeting_id
            }).into())
        }
        Err(e) => {
            log_error!(
                "Error saving transcript for meeting '{}': {}",
                meeting_title,
                e
            );
            Err(format!("Failed to save transcript: {}", e))
        }
    }
}

/// Opens the meeting's recording folder in the system file explorer
#[tauri::command]
#[specta::specta]
pub async fn open_meeting_folder<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    log_info!("open_meeting_folder called for meeting_id: {}", meeting_id);

    let pool = state.db_manager.pool();

    // Get meeting with folder_path
    let meeting: Option<MeetingModel> = sqlx::query_as(
        "SELECT id, title, created_at, updated_at, folder_path, folder_id FROM meetings WHERE id = ?",
    )
    .bind(&meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Database error: {}", e))?;

    match meeting {
        Some(m) => {
            if let Some(folder_path) = m.folder_path {
                log_info!("Opening meeting folder: {}", folder_path);

                // Verify folder exists
                let path = std::path::Path::new(&folder_path);
                if !path.exists() {
                    log_warn!("Folder path does not exist: {}", folder_path);
                    return Err(format!("Recording folder not found: {}", folder_path));
                }

                // Open folder based on OS
                #[cfg(target_os = "macos")]
                {
                    std::process::Command::new("open")
                        .arg(&folder_path)
                        .spawn()
                        .map_err(|e| format!("Failed to open folder: {}", e))?;
                }

                #[cfg(target_os = "windows")]
                {
                    std::process::Command::new("explorer")
                        .arg(&folder_path)
                        .spawn()
                        .map_err(|e| format!("Failed to open folder: {}", e))?;
                }

                #[cfg(target_os = "linux")]
                {
                    std::process::Command::new("xdg-open")
                        .arg(&folder_path)
                        .spawn()
                        .map_err(|e| format!("Failed to open folder: {}", e))?;
                }

                log_info!("Successfully opened folder: {}", folder_path);
                Ok(())
            } else {
                log_warn!("Meeting {} has no folder_path set", meeting_id);
                Err("Recording folder path not available for this meeting".to_string())
            }
        }
        None => {
            log_warn!("Meeting not found: {}", meeting_id);
            Err("Meeting not found".to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn open_external_url(url: String) -> Result<(), String> {
    // Scheme allowlist + placeholder rejection before any OS handoff.
    let safe = crate::utils::validate_external_http_url(&url)?;

    // `open::that` avoids Windows `cmd /C start` shell metachar interpretation.
    open::that(&safe).map_err(|e| format!("Failed to open URL: {e}"))
}

// ===== CUSTOM OPENAI API COMMANDS =====

