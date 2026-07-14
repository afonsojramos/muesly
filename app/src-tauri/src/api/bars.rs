//! Tauri commands for user-authored chat bars.

use tauri::State;

use crate::database::repositories::bars::{BarInput, BarsRepository, UserBar};
use crate::state::AppState;

/// All saved user bars, most recently edited first.
#[tauri::command]
#[specta::specta]
pub async fn bars_list(state: State<'_, AppState>) -> Result<Vec<UserBar>, String> {
    BarsRepository::list(state.db_manager.pool())
        .await
        .map_err(|e| format!("list bars: {e}"))
}

/// Create a new bar or update an existing one (when `input.id` is set).
#[tauri::command]
#[specta::specta]
pub async fn bars_upsert(state: State<'_, AppState>, input: BarInput) -> Result<UserBar, String> {
    BarsRepository::upsert(state.db_manager.pool(), input)
        .await
        .map_err(|e| format!("save bar: {e}"))
}

/// Delete a user bar by id.
#[tauri::command]
#[specta::specta]
pub async fn bars_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    BarsRepository::delete(state.db_manager.pool(), &id)
        .await
        .map_err(|e| format!("delete bar: {e}"))
}
