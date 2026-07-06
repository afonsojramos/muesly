// Folder CRUD + move-meeting command handlers.
use log::{error as log_error, info as log_info};
use tauri::{AppHandle, Runtime};

use crate::{database::repositories::folders::FoldersRepository, state::AppState};

use super::types::Folder;

/// Normalize an optional emoji: trim, treat empty as unset, and cap the length
/// (in chars) so a stray paste can't store a large blob. 8 chars covers ZWJ
/// sequences with skin-tone modifiers.
fn normalize_emoji(emoji: Option<&str>) -> Option<String> {
    emoji
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| e.chars().take(8).collect::<String>())
}

#[tauri::command]
#[specta::specta]
pub async fn api_list_folders<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Folder>, String> {
    let pool = state.db_manager.pool();
    match FoldersRepository::list_folders(pool).await {
        Ok(folders) => Ok(folders
            .into_iter()
            .map(|f| Folder {
                id: f.id,
                name: f.name,
                emoji: f.emoji,
                created_at: f.created_at.0.to_rfc3339(),
            })
            .collect()),
        Err(e) => {
            log_error!("Error listing folders: {}", e);
            Err(format!("Failed to list folders: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_create_folder<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    name: String,
    emoji: Option<String>,
) -> Result<Folder, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    let emoji = normalize_emoji(emoji.as_deref());
    let pool = state.db_manager.pool();
    match FoldersRepository::create_folder(pool, trimmed, emoji.as_deref()).await {
        Ok(f) => {
            log_info!("Created folder {} ({})", f.name, f.id);
            Ok(Folder {
                id: f.id,
                name: f.name,
                emoji: f.emoji,
                created_at: f.created_at.0.to_rfc3339(),
            })
        }
        Err(e) => {
            log_error!("Error creating folder: {}", e);
            Err(format!("Failed to create folder: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_update_folder<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    folder_id: String,
    name: String,
    emoji: Option<String>,
) -> Result<crate::json::Json, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Folder name cannot be empty".to_string());
    }
    let emoji = normalize_emoji(emoji.as_deref());
    let pool = state.db_manager.pool();
    match FoldersRepository::update_folder(pool, &folder_id, trimmed, emoji.as_deref()).await {
        Ok(true) => Ok(serde_json::json!({ "status": "success" }).into()),
        Ok(false) => Err(format!("Folder not found: {}", folder_id)),
        Err(e) => {
            log_error!("Error updating folder {}: {}", folder_id, e);
            Err(format!("Failed to update folder: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_delete_folder<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    folder_id: String,
) -> Result<crate::json::Json, String> {
    let pool = state.db_manager.pool();
    match FoldersRepository::delete_folder(pool, &folder_id).await {
        Ok(true) => {
            log_info!("Deleted folder {} (meetings detached)", folder_id);
            Ok(serde_json::json!({ "status": "success" }).into())
        }
        Ok(false) => Err(format!("Folder not found: {}", folder_id)),
        Err(e) => {
            log_error!("Error deleting folder {}: {}", folder_id, e);
            Err(format!("Failed to delete folder: {}", e))
        }
    }
}

/// Move a meeting into a folder, or out of all folders when `folder_id` is None.
#[tauri::command]
#[specta::specta]
pub async fn api_move_meeting_to_folder<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    folder_id: Option<String>,
) -> Result<crate::json::Json, String> {
    let pool = state.db_manager.pool();
    match FoldersRepository::set_meeting_folder(pool, &meeting_id, folder_id.as_deref()).await {
        Ok(true) => Ok(serde_json::json!({ "status": "success" }).into()),
        Ok(false) => Err(format!("Meeting not found: {}", meeting_id)),
        Err(e) => {
            log_error!("Error moving meeting {}: {}", meeting_id, e);
            Err(format!("Failed to move meeting: {}", e))
        }
    }
}
