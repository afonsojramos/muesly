//! Tauri commands for meeting auto-detection.

use tauri::{AppHandle, Runtime};

use crate::database::repositories::setting::SettingsRepository;
use crate::meeting_detect::watcher;
use crate::state::AppState;

/// Whether auto-detection of meeting apps is enabled.
#[tauri::command]
#[specta::specta]
pub async fn get_auto_detect_meetings(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    SettingsRepository::get_auto_detect_meetings(state.db_manager.pool())
        .await
        .map_err(|e| format!("read auto-detect setting: {e}"))
}

/// Enable or disable meeting auto-detection, starting or stopping the foreground
/// watcher accordingly.
#[tauri::command]
#[specta::specta]
pub async fn set_auto_detect_meetings<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_auto_detect_meetings(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| format!("save auto-detect setting: {e}"))?;
    if enabled {
        watcher::start(app);
    } else {
        watcher::stop();
    }
    Ok(())
}
