// Folder context store command handlers: user-curated folder memory plus the
// accept/reject flow for extracted memory proposals.

use log::{error as log_error, info as log_info};
use tauri::{AppHandle, Runtime};

use crate::database::repositories::folder_context::{
    FolderContextInput, FolderContextItem, FolderContextRepository,
};
use crate::state::AppState;

fn require_folder_id(folder_id: &str) -> Result<&str, String> {
    let trimmed = folder_id.trim();
    if trimmed.is_empty() {
        return Err("folder_id cannot be empty".to_string());
    }
    Ok(trimmed)
}

#[tauri::command]
#[specta::specta]
pub async fn api_list_folder_context<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    folder_id: String,
) -> Result<Vec<FolderContextItem>, String> {
    let folder_id = require_folder_id(&folder_id)?;
    FolderContextRepository::list_items(state.db_manager.pool(), folder_id)
        .await
        .map_err(|e| {
            log_error!("Error listing folder context for {}: {}", folder_id, e);
            format!("Failed to list folder context: {e}")
        })
}

#[tauri::command]
#[specta::specta]
pub async fn api_save_folder_context_item<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: FolderContextInput,
) -> Result<FolderContextItem, String> {
    require_folder_id(&input.folder_id)?;
    let item = FolderContextRepository::save_item(state.db_manager.pool(), &input).await?;
    log_info!("Saved folder context item {} in {}", item.id, item.folder_id);
    Ok(item)
}

#[tauri::command]
#[specta::specta]
pub async fn api_delete_folder_context_item<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if !FolderContextRepository::delete_item(state.db_manager.pool(), id.trim())
        .await
        .map_err(|e| format!("Failed to delete folder context: {e}"))?
    {
        return Err("Folder context item not found".to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn api_accept_folder_memory<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if !FolderContextRepository::accept_item(state.db_manager.pool(), id.trim())
        .await
        .map_err(|e| format!("Failed to accept folder memory: {e}"))?
    {
        return Err("Proposed folder memory not found or already reviewed".to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn api_reject_folder_memory<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if !FolderContextRepository::reject_item(state.db_manager.pool(), id.trim())
        .await
        .map_err(|e| format!("Failed to reject folder memory: {e}"))?
    {
        return Err("Proposed folder memory not found".to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn api_get_folder_context_toggles<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    folder_id: String,
) -> Result<FolderContextToggles, String> {
    let folder_id = require_folder_id(&folder_id)?;
    let (in_summaries, extraction) =
        FolderContextRepository::folder_toggles(state.db_manager.pool(), folder_id).await;
    Ok(FolderContextToggles {
        context_in_summaries: in_summaries,
        memory_extraction: extraction,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn api_set_folder_context_in_summaries<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    folder_id: String,
    enabled: bool,
) -> Result<(), String> {
    let folder_id = require_folder_id(&folder_id)?;
    if !FolderContextRepository::set_context_in_summaries(
        state.db_manager.pool(),
        folder_id,
        enabled,
    )
    .await
    .map_err(|e| format!("Failed to update folder setting: {e}"))?
    {
        return Err("Folder not found".to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn api_set_folder_memory_extraction<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    folder_id: String,
    enabled: bool,
) -> Result<(), String> {
    let folder_id = require_folder_id(&folder_id)?;
    if !FolderContextRepository::set_memory_extraction(
        state.db_manager.pool(),
        folder_id,
        enabled,
    )
    .await
    .map_err(|e| format!("Failed to update folder setting: {e}"))?
    {
        return Err("Folder not found".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct FolderContextToggles {
    pub context_in_summaries: bool,
    pub memory_extraction: bool,
}
