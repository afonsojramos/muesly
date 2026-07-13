use log::info;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};

use super::manager::DatabaseManager;
use crate::state::AppState;

/// Load the persisted transcription language into the in-memory cache that the
/// transcription hot path reads. Best-effort: a read failure or an unset value
/// leaves the default ("auto") in place and must never block launch.
pub async fn load_transcription_language_cache(pool: &SqlitePool) {
    if let Ok(Some(language)) =
        crate::database::repositories::setting::SettingsRepository::get_transcription_language(pool)
            .await
    {
        crate::set_language_preference_internal(&language);
    }
}

/// Retire the former Parakeet default without penalizing weaker machines. Old
/// installs are migrated once to the hardware-appropriate Whisper model.
pub async fn migrate_legacy_parakeet_config(pool: &SqlitePool) -> Result<(), String> {
    let current = crate::database::repositories::setting::SettingsRepository::get_transcript_config(pool)
        .await
        .map_err(|error| error.to_string())?;
    if current.as_ref().is_some_and(|config| config.provider != "parakeet") {
        return Ok(());
    }

    let recommended = crate::config::recommended_whisper_model(crate::audio::HardwareProfile::detect());
    crate::database::repositories::setting::SettingsRepository::save_transcript_config(
        pool,
        "localWhisper",
        recommended,
    )
    .await
    .map_err(|error| error.to_string())
}

/// Initialize database on app startup
/// Handles first launch detection and conditional initialization
pub async fn initialize_database_on_startup(app: &AppHandle) -> Result<(), String> {
    // Check if this is the first launch (no database exists yet)
    let is_first_launch = DatabaseManager::is_first_launch(app)
        .await
        .map_err(|e| format!("Failed to check first launch status: {}", e))?;

    if is_first_launch {
        info!("First launch detected - will notify window when ready");

        // Delay event emission to ensure window is ready and React listeners are registered
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            app_handle
                .emit("first-launch-detected", ())
                .expect("Failed to emit first-launch-detected event");
            info!("Emitted first-launch-detected after delay");
        });
    } else {
        // Normal flow - initialize database immediately
        let db_manager = DatabaseManager::new_from_app_handle(app)
            .await
            .map_err(|e| format!("Failed to initialize database manager: {}", e))?;

        // Load the persisted transcription language into the in-memory cache before
        // transcription can run.
        migrate_legacy_parakeet_config(db_manager.pool()).await?;
        load_transcription_language_cache(db_manager.pool()).await;

        app.manage(AppState { db_manager });
        info!("Database initialized successfully");
    }

    Ok(())
}
