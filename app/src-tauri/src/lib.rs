use serde::{Deserialize, Serialize};
use std::sync::Mutex as StdMutex;
// Removed unused import

// Performance optimization: Conditional logging macros for hot paths
#[cfg(debug_assertions)]
macro_rules! perf_debug {
    ($($arg:tt)*) => {
        log::debug!($($arg)*)
    };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_debug {
    ($($arg:tt)*) => {};
}

// Make this macro available to other modules
pub(crate) use perf_debug;

// Re-export async logging macros for external use (removed due to macro conflicts)

// Declare audio module
pub mod analytics;
pub mod api;
pub mod audio;
pub mod calendar;
pub mod keychain;
pub mod model_integrity;
pub mod config;
pub mod console_utils;
pub mod database;
pub mod diarization;
pub mod dictation;
pub mod json;
pub mod meeting_detect;
pub mod notifications;
pub mod onboarding;
pub mod parakeet_engine;
pub mod pill_window;
pub mod providers;
pub mod state;
pub mod summary;
pub mod model_idle;
pub mod transcription_models;
pub mod tray;
pub mod disk;
pub mod utils;
pub mod vocabulary;
pub mod whisper_engine;

use audio::{list_audio_devices, AudioDevice, trigger_audio_permission};
use log::{error as log_error, info as log_info, warn as log_warn};
use notifications::commands::NotificationManagerState;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::RwLock;


// Runtime cache of the transcription language preference, read on the
// transcription hot path. The settings DB is the durable source of truth and is
// loaded into this at startup; defaults to "auto" (detect the original language),
// matching the frontend default.
static LANGUAGE_PREFERENCE: std::sync::LazyLock<StdMutex<String>> =
    std::sync::LazyLock::new(|| StdMutex::new("auto".to_string()));

#[derive(Debug, Deserialize, specta::Type)]
struct RecordingArgs {
    save_path: String,
}

#[derive(Debug, Serialize, Clone, specta::Type)]
struct TranscriptionStatus {
    chunks_in_queue: usize,
    is_processing: bool,
    last_activity_ms: u64,
}

#[tauri::command]
#[specta::specta]
async fn start_recording<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    log_info!("🔥 CALLED start_recording with meeting: {:?}", meeting_name);
    log_info!(
        "📋 Backend received parameters - mic: {:?}, system: {:?}, meeting: {:?}",
        mic_device_name,
        system_device_name,
        meeting_name
    );

    if is_recording().await {
        return Err("Recording already in progress".to_string());
    }

    // Call the actual audio recording system with meeting name
    match audio::recording_commands::start_recording_with_devices_and_meeting(
        app.clone(),
        mic_device_name,
        system_device_name,
        meeting_name.clone(),
    )
    .await
    {
        Ok(_) => {
            tray::update_tray_menu(&app);

            log_info!("Recording started successfully");

            // Show recording started notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_started_notification(
                &app,
                &notification_manager_state,
                meeting_name.clone(),
            )
            .await
            {
                log_error!(
                    "Failed to show recording started notification: {}",
                    e
                );
            } else {
                log_info!("Successfully showed recording started notification");
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to start audio recording: {}", e);
            Err(format!("Failed to start recording: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn stop_recording<R: Runtime>(app: AppHandle<R>, args: RecordingArgs) -> Result<(), String> {
    log_info!("Attempting to stop recording...");

    // Check the actual audio recording system state instead of the flag
    if !audio::recording_commands::is_recording().await {
        log_info!("Recording is already stopped");
        return Ok(());
    }

    // Call the actual audio recording system to stop
    match audio::recording_commands::stop_recording(
        app.clone(),
        audio::recording_commands::RecordingArgs {
            save_path: args.save_path.clone(),
        },
    )
    .await
    {
        Ok(_) => {
            tray::update_tray_menu(&app);

            // Create the save directory if it doesn't exist
            if let Some(parent) = std::path::Path::new(&args.save_path).parent() {
                if !parent.exists() {
                    log_info!("Creating directory: {:?}", parent);
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        let err_msg = format!("Failed to create save directory: {}", e);
                        log_error!("{}", err_msg);
                        return Err(err_msg);
                    }
                }
            }

            // Show recording stopped notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_stopped_notification(
                &app,
                &notification_manager_state,
            )
            .await
            {
                log_error!(
                    "Failed to show recording stopped notification: {}",
                    e
                );
            } else {
                log_info!("Successfully showed recording stopped notification");
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to stop audio recording: {}", e);
            // Still refresh the tray even if stopping failed
            tray::update_tray_menu(&app);
            Err(format!("Failed to stop recording: {}", e))
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn is_recording() -> bool {
    audio::recording_commands::is_recording().await
}

#[tauri::command]
#[specta::specta]
fn get_transcription_status() -> TranscriptionStatus {
    let (queued, completed) = audio::transcription::worker::transcription_progress();
    let in_queue = queued.saturating_sub(completed) as usize;
    TranscriptionStatus {
        chunks_in_queue: in_queue,
        is_processing: in_queue > 0,
        last_activity_ms: 0, // Wall-clock tracking not implemented; see plan 022 scope note.
    }
}

#[cfg(test)]
mod specta_bindings_tests {
    // Regenerates app/src-svelte/src/lib/bindings.ts from the command set, so the
    // typed frontend bindings stay in sync and a type drift fails the test suite.
    #[test]
    fn exports_typescript_bindings() {
        super::make_specta_builder()
            // u64/usize values (counts, sizes, ms timestamps) are within JS
            // safe-integer range, so export them as `number`.
            .dangerously_cast_bigints_to_number()
            .export(
                specta_typescript::Typescript::default(),
                "../src-svelte/src/lib/bindings.ts",
            )
            .expect("failed to export TypeScript bindings");
    }
}

/// Returns the resolved path if it falls inside one of `allowed_roots`, otherwise
/// returns an error. Works for both reads (target exists) and writes (target or its
/// parent may not exist yet).
///
/// Resolution strategy: walk up the path until we find an existing ancestor, run
/// `canonicalize()` on that ancestor (resolves symlinks and `..`), then re-append
/// the remaining components. Any `.` or `..` segment in the not-yet-existing tail
/// is rejected immediately so traversal cannot hide in a non-existent path suffix.
pub fn validate_path_within_roots(
    requested: &str,
    allowed_roots: &[std::path::PathBuf],
    _for_write: bool,
) -> Result<std::path::PathBuf, String> {
    let requested_path = std::path::Path::new(requested);

    // Resolve without requiring the full path (or its parent) to exist:
    // canonicalize the deepest existing ancestor, then re-append the remaining
    // components, rejecting `.`/`..` in the not-yet-existing tail so traversal
    // cannot hide there.
    let mut existing = requested_path;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let canonical_existing = loop {
        match existing.canonicalize() {
            Ok(c) => break c,
            Err(_) => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| "Path has no resolvable ancestor".to_string())?;
                tail.push(name.to_os_string());
                existing = existing
                    .parent()
                    .ok_or_else(|| "Path has no parent directory".to_string())?;
            }
        }
    };

    let mut resolved = canonical_existing;
    for seg in tail.iter().rev() {
        if seg == ".." || seg == "." {
            return Err("Access denied: path contains a traversal segment".to_string());
        }
        resolved.push(seg);
    }

    for root in allowed_roots {
        if resolved.starts_with(root) {
            return Ok(resolved);
        }
    }
    Err("Access denied: path is outside allowed directories".to_string())
}

/// Collects the allowed roots for the current app instance: app data dir plus
/// the user-configured recordings folder (which may be outside app data).
pub(crate) async fn allowed_roots_for_app<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<std::path::PathBuf>, String> {
    let mut roots = Vec::new();

    if let Ok(app_data) = app.path().app_data_dir() {
        roots.push(app_data.canonicalize().unwrap_or(app_data));
    }

    // Include the user-configured recordings folder, which may be outside app data.
    match audio::recording_preferences::load_recording_preferences(app).await {
        Ok(prefs) => {
            let folder = prefs.save_folder;
            roots.push(folder.canonicalize().unwrap_or(folder));
        }
        Err(e) => {
            log_warn!("Could not load recording preferences for path validation: {}", e);
        }
    }

    if roots.is_empty() {
        return Err("No allowed directories could be determined".to_string());
    }

    Ok(roots)
}

#[tauri::command]
#[specta::specta]
async fn read_audio_file<R: Runtime>(
    app: AppHandle<R>,
    file_path: String,
) -> Result<Vec<u8>, String> {
    let roots = allowed_roots_for_app(&app).await?;
    let validated = validate_path_within_roots(&file_path, &roots, false)?;
    match std::fs::read(&validated) {
        Ok(data) => Ok(data),
        Err(e) => Err(format!("Failed to read audio file: {}", e)),
    }
}

#[tauri::command]
#[specta::specta]
async fn save_transcript<R: Runtime>(
    app: AppHandle<R>,
    file_path: String,
    content: String,
) -> Result<(), String> {
    log_info!("Saving transcript to: {}", file_path);

    // Validate before creating any directories so a rejected path cannot create
    // directories outside the allowed roots.
    let roots = allowed_roots_for_app(&app).await?;
    let validated = validate_path_within_roots(&file_path, &roots, true)?;

    if let Some(parent) = validated.parent() {
        if !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    tokio::fs::write(&validated, content)
        .await
        .map_err(|e| format!("Failed to write transcript: {}", e))?;

    log_info!("Transcript saved successfully");
    Ok(())
}

#[cfg(test)]
mod path_validation_tests {
    use super::validate_path_within_roots;
    use tempfile::TempDir;

    #[test]
    fn path_inside_root_is_accepted() {
        let root = TempDir::new().unwrap();
        let target = root.path().join("subdir").join("file.txt");
        // Create the subdirectory so canonicalize can resolve the parent.
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"data").unwrap();

        let roots = vec![root.path().canonicalize().unwrap()];
        let result = validate_path_within_roots(target.to_str().unwrap(), &roots, false);
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
    }

    #[test]
    fn path_outside_root_is_rejected() {
        let root = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let target = other.path().join("secret.txt");
        std::fs::write(&target, b"secret").unwrap();

        let roots = vec![root.path().canonicalize().unwrap()];
        let result = validate_path_within_roots(target.to_str().unwrap(), &roots, false);
        assert!(result.is_err(), "expected Err for path outside root");
    }

    #[test]
    fn traversal_path_is_rejected() {
        let root = TempDir::new().unwrap();
        // Create a sibling directory the traversal would escape into.
        let sibling = TempDir::new().unwrap();
        let escape_target = sibling.path().join("escape.txt");
        std::fs::write(&escape_target, b"escaped").unwrap();

        // Build a path that looks like it is inside root but escapes via `..`.
        let traversal = format!(
            "{}/inside/../../{}",
            root.path().display(),
            escape_target.display()
        );

        let roots = vec![root.path().canonicalize().unwrap()];
        let result = validate_path_within_roots(&traversal, &roots, false);
        assert!(result.is_err(), "expected Err for traversal path");
    }

    #[test]
    fn write_path_inside_root_is_accepted() {
        let root = TempDir::new().unwrap();
        let subdir = root.path().join("transcripts");
        std::fs::create_dir_all(&subdir).unwrap();
        // Target file does not need to exist for a write.
        let target = subdir.join("output.txt");

        let roots = vec![root.path().canonicalize().unwrap()];
        let result = validate_path_within_roots(target.to_str().unwrap(), &roots, true);
        assert!(result.is_ok(), "expected Ok for write inside root, got {:?}", result);
    }

    #[test]
    fn write_traversal_is_rejected() {
        let root = TempDir::new().unwrap();
        let sibling = TempDir::new().unwrap();
        // Parent (sibling dir) exists; file does not.
        let traversal = format!(
            "{}/inside/../../{}/out.txt",
            root.path().display(),
            sibling.path().display()
        );

        let roots = vec![root.path().canonicalize().unwrap()];
        let result = validate_path_within_roots(&traversal, &roots, true);
        assert!(result.is_err(), "expected Err for write traversal");
    }

    #[test]
    fn write_to_nonexistent_subdir_inside_root_is_accepted() {
        let root = TempDir::new().unwrap();
        // `newsub` does not exist yet — the validator must not require it to.
        let target = root.path().join("newsub").join("out.txt");

        let roots = vec![root.path().canonicalize().unwrap()];
        let result = validate_path_within_roots(target.to_str().unwrap(), &roots, true);
        assert!(result.is_ok(), "expected Ok for write with non-existent parent inside root, got {:?}", result);
    }
}

// Audio level monitoring commands
#[tauri::command]
#[specta::specta]
async fn start_audio_level_monitoring<R: Runtime>(
    app: AppHandle<R>,
    device_names: Vec<String>,
) -> Result<(), String> {
    log_info!(
        "Starting audio level monitoring for devices: {:?}",
        device_names
    );

    audio::simple_level_monitor::start_monitoring(app, device_names)
        .await
        .map_err(|e| format!("Failed to start audio level monitoring: {}", e))
}

#[tauri::command]
#[specta::specta]
async fn stop_audio_level_monitoring() -> Result<(), String> {
    log_info!("Stopping audio level monitoring");

    audio::simple_level_monitor::stop_monitoring()
        .await
        .map_err(|e| format!("Failed to stop audio level monitoring: {}", e))
}

#[tauri::command]
#[specta::specta]
async fn is_audio_level_monitoring() -> bool {
    audio::simple_level_monitor::is_monitoring()
}

// Analytics commands are now handled by analytics::commands module

// Whisper commands are now handled by whisper_engine::commands module

#[tauri::command]
#[specta::specta]
async fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    list_audio_devices()
        .await
        .map_err(|e| format!("Failed to list audio devices: {}", e))
}

#[tauri::command]
#[specta::specta]
async fn trigger_microphone_permission() -> Result<bool, String> {
    trigger_audio_permission()
        .map_err(|e| format!("Failed to trigger microphone permission: {}", e))
}

#[tauri::command]
#[specta::specta]
async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None).await
}

#[tauri::command]
#[specta::specta]
async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    log_info!("🚀 CALLED start_recording_with_devices_and_meeting - Mic: {:?}, System: {:?}, Meeting: {:?}",
             mic_device_name, system_device_name, meeting_name);

    // System Audio Recording permission check (macOS 14.4+): without it the
    // Core Audio tap silently records zeros, so warn the user up front rather
    // than producing a meeting with no system audio. Non-blocking: mic-only
    // recording still proceeds. Undetermined also warns (dev builds never get
    // the consent prompt; bundled builds may, and the toast is then harmless).
    // Unknown (preflight SPI unavailable) stays silent: the tap may well be
    // authorized, and a false warning for every recording would be worse.
    #[cfg(target_os = "macos")]
    {
        use audio::permissions::{system_audio_permission_status, SystemAudioPermission};
        let status = tokio::task::spawn_blocking(system_audio_permission_status)
            .await
            .unwrap_or(SystemAudioPermission::Unknown);
        if matches!(
            status,
            SystemAudioPermission::Denied | SystemAudioPermission::Undetermined
        ) {
            log_warn!(
                "⚠️ System Audio Recording permission is {:?} - system audio may be silent",
                status
            );
            let payload = if status == SystemAudioPermission::Denied {
                "denied"
            } else {
                "undetermined"
            };
            let _ = app.emit("system-audio-permission-missing", payload);
        }
    }

    // Clone meeting_name for notification use later
    let meeting_name_for_notification = meeting_name.clone();

    // Call the recording module functions that support meeting names
    let recording_result = match (mic_device_name.clone(), system_device_name.clone()) {
        (None, None) => {
            log_info!(
                "No devices specified, starting with defaults and meeting: {:?}",
                meeting_name
            );
            audio::recording_commands::start_recording_with_meeting_name(app.clone(), meeting_name)
                .await
        }
        _ => {
            log_info!(
                "Starting with specified devices: mic={:?}, system={:?}, meeting={:?}",
                mic_device_name,
                system_device_name,
                meeting_name
            );
            audio::recording_commands::start_recording_with_devices_and_meeting(
                app.clone(),
                mic_device_name,
                system_device_name,
                meeting_name,
            )
            .await
        }
    };

    match recording_result {
        Ok(_) => {
            log_info!("Recording started successfully via tauri command");

            // Show recording started notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_started_notification(
                &app,
                &notification_manager_state,
                meeting_name_for_notification.clone(),
            )
            .await
            {
                log_error!(
                    "Failed to show recording started notification: {}",
                    e
                );
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to start recording via tauri command: {}", e);
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn set_language_preference<R: Runtime>(
    app: AppHandle<R>,
    language: String,
) -> Result<(), String> {
    log_info!("Setting language preference to: {}", language);
    // Update the in-memory cache first so the live worker reflects the change
    // immediately, then persist best-effort: a transient DB error must not make
    // the in-session change appear to fail.
    set_language_preference_internal(&language);
    if let Some(state) = app.try_state::<state::AppState>() {
        if let Err(e) =
            crate::database::repositories::setting::SettingsRepository::set_transcription_language(
                state.db_manager.pool(),
                &language,
            )
            .await
        {
            log_warn!("Failed to persist transcription language: {}", e);
        }
    }
    Ok(())
}

/// Set the in-memory transcription language cache. Used by the startup DB load
/// and by `set_language_preference`.
pub fn set_language_preference_internal(language: &str) {
    if let Ok(mut lang_pref) = LANGUAGE_PREFERENCE.lock() {
        *lang_pref = language.to_string();
    }
}

// Internal helper function to get language preference (for use within Rust code)
pub fn get_language_preference_internal() -> Option<String> {
    LANGUAGE_PREFERENCE.lock().ok().map(|lang| lang.clone())
}

/// Read the persisted transcription language from the DB, or `None` if unset.
/// The frontend uses this to treat the DB as the source of truth and to run a
/// one-time migration of the legacy localStorage value.
#[tauri::command]
#[specta::specta]
async fn get_transcription_language<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    match app.try_state::<state::AppState>() {
        Some(state) => {
            crate::database::repositories::setting::SettingsRepository::get_transcription_language(
                state.db_manager.pool(),
            )
            .await
            .map_err(|e| format!("Failed to read transcription language: {}", e))
        }
        None => Ok(None),
    }
}

#[tauri::command]
#[specta::specta]
async fn set_custom_vocabulary<R: Runtime>(
    app: AppHandle<R>,
    entries: Vec<vocabulary::VocabularyEntry>,
) -> Result<(), String> {
    vocabulary::set_vocabulary(entries.clone());
    if let Some(state) = app.try_state::<state::AppState>() {
        match serde_json::to_string(&entries) {
            Ok(json) => {
                if let Err(e) = crate::database::repositories::setting::SettingsRepository::set_custom_vocabulary(
                    state.db_manager.pool(), &json,
                ).await {
                    log_warn!("Failed to persist custom vocabulary: {}", e);
                }
            }
            Err(e) => log_warn!("Failed to serialize custom vocabulary: {}", e),
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_custom_vocabulary<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<vocabulary::VocabularyEntry>, String> {
    match app.try_state::<state::AppState>() {
        Some(state) => {
            let json = crate::database::repositories::setting::SettingsRepository::get_custom_vocabulary(
                state.db_manager.pool(),
            ).await.map_err(|e| format!("Failed to read custom vocabulary: {}", e))?;
            match json {
                Some(j) => serde_json::from_str(&j).map_err(|e| format!("Invalid vocabulary JSON: {}", e)),
                None => Ok(Vec::new()),
            }
        }
        None => Ok(Vec::new()),
    }
}

/// The single global recording shortcut. Uses Alt/Option (not Shift) to avoid
/// the browser hard-reload clash on Cmd/Ctrl+Shift+R.
const RECORDING_SHORTCUT: &str = "CmdOrCtrl+Alt+R";

#[tauri::command]
#[specta::specta]
async fn set_recording_shortcut_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    if enabled {
        // Re-register defensively: unregister first so a double-enable cannot error.
        let _ = gs.unregister(RECORDING_SHORTCUT);
        gs.register(RECORDING_SHORTCUT)
            .map_err(|e| format!("Failed to register recording shortcut: {}", e))?;
        log_info!("Global recording shortcut registered: {}", RECORDING_SHORTCUT);
    } else {
        let _ = gs.unregister(RECORDING_SHORTCUT);
        log_info!("Global recording shortcut disabled");
    }
    Ok(())
}

/// The global push-to-talk dictation shortcut: hold to dictate, release to transcribe.
const DICTATION_SHORTCUT: &str = "CmdOrCtrl+Shift+D";

#[tauri::command]
#[specta::specta]
async fn set_dictation_shortcut_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    if enabled {
        let _ = gs.unregister(DICTATION_SHORTCUT);
        gs.register(DICTATION_SHORTCUT)
            .map_err(|e| format!("Failed to register dictation shortcut: {}", e))?;
        log_info!("Global dictation shortcut registered: {}", DICTATION_SHORTCUT);
    } else {
        let _ = gs.unregister(DICTATION_SHORTCUT);
        log_info!("Global dictation shortcut disabled");
    }
    Ok(())
}

/// Single source of truth for the Tauri command set: drives both the runtime
/// invoke handler and the generated TypeScript bindings. Generic `R: Runtime`
/// commands are monomorphized to `tauri::Wry` here.
fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    use tauri_specta::{collect_commands, Builder};
    Builder::<tauri::Wry>::new().commands(collect_commands![
        start_recording::<tauri::Wry>,
        stop_recording::<tauri::Wry>,
        is_recording,
        get_transcription_status,
        meeting_detect::commands::get_auto_detect_meetings,
        meeting_detect::commands::set_auto_detect_meetings::<tauri::Wry>,
        diarization::commands::diarization_models_ready::<tauri::Wry>,
        diarization::commands::diarize_meeting::<tauri::Wry>,
        diarization::commands::download_diarization_models::<tauri::Wry>,
        diarization::commands::get_meeting_speakers,
        diarization::commands::set_speaker_name,
        read_audio_file::<tauri::Wry>,
        save_transcript::<tauri::Wry>,
        analytics::commands::init_analytics,
        analytics::commands::disable_analytics,
        analytics::commands::track_event,
        analytics::commands::identify_user,
        analytics::commands::track_meeting_deleted,
        analytics::commands::track_settings_changed,
        analytics::commands::track_feature_used,
        analytics::commands::is_analytics_enabled,
        analytics::commands::start_analytics_session,
        analytics::commands::end_analytics_session,
        analytics::commands::track_daily_active_user,
        analytics::commands::track_user_first_launch,
        analytics::commands::is_analytics_session_active,
        analytics::commands::track_summary_generation_completed,
        analytics::commands::track_summary_regenerated,
        analytics::commands::track_model_changed,
        analytics::commands::track_custom_prompt_used,
        analytics::commands::track_meeting_ended,
        analytics::commands::track_analytics_enabled,
        analytics::commands::track_analytics_disabled,
        analytics::commands::track_analytics_transparency_viewed,
        analytics::commands::track_exception,
        whisper_engine::commands::whisper_init,
        whisper_engine::commands::whisper_get_available_models,
        whisper_engine::commands::whisper_load_model,
        whisper_engine::commands::whisper_get_current_model,
        whisper_engine::commands::whisper_is_model_loaded,
        whisper_engine::commands::whisper_has_available_models,
        whisper_engine::commands::whisper_validate_model_ready,
        whisper_engine::commands::whisper_transcribe_audio,
        whisper_engine::commands::whisper_get_models_directory,
        whisper_engine::commands::whisper_download_model,
        whisper_engine::commands::whisper_cancel_download,
        whisper_engine::commands::whisper_delete_corrupted_model,
        parakeet_engine::commands::parakeet_init,
        parakeet_engine::commands::parakeet_get_available_models,
        parakeet_engine::commands::parakeet_load_model::<tauri::Wry>,
        parakeet_engine::commands::parakeet_get_current_model,
        parakeet_engine::commands::parakeet_is_model_loaded,
        parakeet_engine::commands::parakeet_has_available_models,
        parakeet_engine::commands::parakeet_validate_model_ready,
        parakeet_engine::commands::parakeet_transcribe_audio,
        parakeet_engine::commands::parakeet_get_models_directory,
        parakeet_engine::commands::parakeet_download_model::<tauri::Wry>,
        parakeet_engine::commands::parakeet_retry_download::<tauri::Wry>,
        parakeet_engine::commands::parakeet_cancel_download::<tauri::Wry>,
        parakeet_engine::commands::parakeet_delete_corrupted_model,
        parakeet_engine::commands::open_parakeet_models_folder,
        get_audio_devices,
        trigger_microphone_permission,
        start_recording_with_devices::<tauri::Wry>,
        start_recording_with_devices_and_meeting::<tauri::Wry>,
        start_audio_level_monitoring::<tauri::Wry>,
        stop_audio_level_monitoring,
        is_audio_level_monitoring,
        audio::recording_commands::pause_recording::<tauri::Wry>,
        audio::recording_commands::resume_recording::<tauri::Wry>,
        audio::recording_commands::is_recording_paused,
        audio::recording_commands::get_recording_state,
        audio::recording_commands::get_meeting_folder_path,
        audio::recording_commands::get_transcript_history,
        audio::recording_commands::get_recording_meeting_name,
        audio::recording_commands::poll_audio_device_events,
        audio::recording_commands::get_reconnection_status,
        audio::recording_commands::attempt_device_reconnect,
        audio::recording_commands::get_active_audio_output,
        audio::recording_commands::set_dictation_enabled,
        audio::recording_commands::get_dictation_enabled,
        dictation::commands::start_dictation,
        dictation::commands::stop_dictation::<tauri::Wry>,
        dictation::commands::dictation_accessibility_trusted,
        dictation::commands::get_dictation_cleanup_enabled,
        dictation::commands::set_dictation_cleanup_enabled,
        dictation::commands::list_dictation_cleanup_presets,
        dictation::commands::create_dictation_cleanup_preset,
        dictation::commands::update_dictation_cleanup_preset,
        dictation::commands::delete_dictation_cleanup_preset,
        dictation::commands::set_active_dictation_cleanup_preset,
        audio::incremental_saver::recover_audio_from_checkpoints,
        audio::incremental_saver::cleanup_checkpoints,
        audio::incremental_saver::has_audio_checkpoints,
        console_utils::show_console,
        console_utils::hide_console,
        console_utils::toggle_console,
        providers::ollama::get_ollama_models,
        providers::ollama::pull_ollama_model::<tauri::Wry>,
        providers::ollama::delete_ollama_model,
        providers::ollama::get_ollama_model_context,
        providers::openai::get_openai_models,
        providers::anthropic::get_anthropic_models,
        providers::groq::get_groq_models,
        providers::xai::get_xai_models,
        api::api_get_meetings::<tauri::Wry>,
        api::api_search_transcripts::<tauri::Wry>,
        api::api_get_model_config::<tauri::Wry>,
        api::api_save_model_config::<tauri::Wry>,
        api::api_get_api_key::<tauri::Wry>,
        api::api_get_transcript_config::<tauri::Wry>,
        api::api_save_transcript_config::<tauri::Wry>,
        api::api_get_transcript_api_key::<tauri::Wry>,
        api::api_delete_meeting::<tauri::Wry>,
        api::api_get_trashed_meetings::<tauri::Wry>,
        api::api_restore_meeting::<tauri::Wry>,
        api::api_permanently_delete_meeting::<tauri::Wry>,
        api::api_list_folders::<tauri::Wry>,
        api::api_create_folder::<tauri::Wry>,
        api::api_update_folder::<tauri::Wry>,
        api::api_delete_folder::<tauri::Wry>,
        api::api_move_meeting_to_folder::<tauri::Wry>,
        api::api_get_meeting::<tauri::Wry>,
        api::api_get_meeting_metadata::<tauri::Wry>,
        api::api_get_meeting_transcripts::<tauri::Wry>,
        api::api_save_meeting_title::<tauri::Wry>,
        api::api_save_meeting_notes::<tauri::Wry>,
        api::api_get_meeting_notes::<tauri::Wry>,
        api::api_save_meeting_summary_context::<tauri::Wry>,
        api::api_export_meeting_markdown::<tauri::Wry>,
        api::api_save_transcript::<tauri::Wry>,
        api::open_meeting_folder::<tauri::Wry>,
        api::open_external_url,
        api::api_save_custom_openai_config::<tauri::Wry>,
        api::api_get_custom_openai_config::<tauri::Wry>,
        api::api_test_custom_openai_connection::<tauri::Wry>,
        summary::commands::api_process_transcript::<tauri::Wry>,
        summary::commands::api_get_summary::<tauri::Wry>,
        summary::commands::api_save_meeting_summary::<tauri::Wry>,
        summary::commands::api_cancel_summary::<tauri::Wry>,
        summary::commands::api_get_meeting_summary_language::<tauri::Wry>,
        summary::commands::api_save_meeting_summary_language::<tauri::Wry>,
        summary::commands::api_get_meeting_detected_summary_language::<tauri::Wry>,
        summary::commands::api_detect_transcript_summary_language,
        summary::commands::api_generate_meeting_title::<tauri::Wry>,
        summary::chat::chat_ask::<tauri::Wry>,
        summary::chat::chat_cancel,
        summary::template_commands::api_list_templates::<tauri::Wry>,
        summary::template_commands::api_get_template_details::<tauri::Wry>,
        summary::template_commands::api_validate_template::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_list_models::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_get_model_info::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_download_model::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_cancel_download::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_delete_model,
        summary::summary_engine::commands::builtin_ai_is_model_ready::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_get_available_summary_model::<tauri::Wry>,
        summary::summary_engine::commands::builtin_ai_get_recommended_model,
        providers::openrouter::get_openrouter_models,
        audio::recording_preferences::get_recording_preferences::<tauri::Wry>,
        audio::recording_preferences::set_recording_preferences::<tauri::Wry>,
        audio::recording_preferences::get_default_recordings_folder_path,
        audio::recording_preferences::open_recordings_folder::<tauri::Wry>,
        audio::recording_preferences::select_recording_folder::<tauri::Wry>,
        audio::recording_preferences::get_available_audio_backends,
        audio::recording_preferences::get_current_audio_backend,
        audio::recording_preferences::set_audio_backend,
        audio::recording_preferences::get_audio_backend_info,
        set_language_preference::<tauri::Wry>,
        get_transcription_language::<tauri::Wry>,
        set_custom_vocabulary::<tauri::Wry>,
        get_custom_vocabulary::<tauri::Wry>,
        set_recording_shortcut_enabled::<tauri::Wry>,
        set_dictation_shortcut_enabled::<tauri::Wry>,
        notifications::commands::get_notification_settings,
        notifications::commands::set_notification_settings,
        notifications::commands::request_notification_permission,
        notifications::commands::show_notification,
        notifications::commands::show_test_notification,
        notifications::commands::is_dnd_active,
        notifications::commands::get_system_dnd_status,
        notifications::commands::set_manual_dnd,
        notifications::commands::set_notification_consent,
        notifications::commands::clear_notifications,
        notifications::commands::is_notification_system_ready,
        notifications::commands::initialize_notification_manager_manual,
        notifications::commands::test_notification_with_auto_consent,
        notifications::commands::get_notification_stats,
        audio::system_audio_commands::start_system_audio_capture_command,
        audio::system_audio_commands::list_system_audio_devices_command,
        audio::system_audio_commands::check_system_audio_permissions_command,
        audio::system_audio_commands::start_system_audio_monitoring,
        audio::system_audio_commands::stop_system_audio_monitoring,
        audio::system_audio_commands::get_system_audio_monitoring_status,
        audio::permissions::check_screen_recording_permission_command,
        audio::permissions::request_screen_recording_permission_command,
        audio::permissions::trigger_system_audio_permission_command,
        audio::permissions::check_system_audio_permission_command,
        database::commands::check_first_launch,
        database::commands::select_legacy_database_path,
        database::commands::detect_legacy_database,
        database::commands::check_default_legacy_database,
        database::commands::check_homebrew_database,
        database::commands::import_and_initialize_database,
        database::commands::initialize_fresh_database,
        database::commands::get_database_directory,
        database::commands::open_database_folder,
        whisper_engine::commands::open_models_folder,
        onboarding::get_onboarding_status::<tauri::Wry>,
        onboarding::save_onboarding_status_cmd::<tauri::Wry>,
        onboarding::reset_onboarding_status_cmd::<tauri::Wry>,
        onboarding::complete_onboarding::<tauri::Wry>,
        utils::open_system_settings,
        audio::retranscription::start_retranscription_command::<tauri::Wry>,
        audio::retranscription::cancel_retranscription_command,
        audio::retranscription::is_retranscription_in_progress_command,
        audio::import::select_and_validate_audio_command::<tauri::Wry>,
        audio::import::validate_audio_file_command,
        audio::import::start_import_audio_command::<tauri::Wry>,
        audio::import::cancel_import_command,
        audio::import::is_import_in_progress_command,
        calendar::commands::calendar_permission_status,
        calendar::commands::calendar_request_access,
        calendar::commands::calendar_open_settings,
        calendar::commands::calendar_list_calendars,
        calendar::commands::calendar_get_context_enabled,
        calendar::commands::calendar_set_context_enabled,
        calendar::commands::calendar_get_excluded_ids,
        calendar::commands::calendar_set_excluded_ids,
        calendar::commands::calendar_get_send_attendee_names_to_cloud,
        calendar::commands::calendar_set_send_attendee_names_to_cloud,
        calendar::commands::calendar_get_send_notes_to_cloud,
        calendar::commands::calendar_set_send_notes_to_cloud,
        calendar::commands::calendar_get_event,
        calendar::commands::calendar_attach_event,
        calendar::commands::calendar_detach_event,
        calendar::commands::calendar_purge_all_snapshots,
        calendar::commands::calendar_google_configured,
        calendar::commands::calendar_list_accounts,
        calendar::commands::calendar_add_google_account,
        calendar::commands::calendar_remove_account,
        calendar::commands::calendar_set_account_enabled,
        calendar::commands::calendar_list_account_calendars,
        calendar::commands::calendar_refresh_account_calendars,
        calendar::commands::calendar_set_account_excluded_ids,
        calendar::commands::calendar_preview_upcoming,
        calendar::commands::calendar_diagnose,
        calendar::commands::calendar_set_event_folder,
        calendar::commands::calendar_get_event_folder,
        calendar::commands::calendar_clear_event_folder,
        calendar::commands::calendar_apply_folder_rule,
        calendar::commands::calendar_get_auto_start_on_event,
        calendar::commands::calendar_set_auto_start_on_event,
        calendar::commands::calendar_get_auto_join_meeting,
        calendar::commands::calendar_set_auto_join_meeting,
    ])
}

pub fn run() {
    log::set_max_level(log::LevelFilter::Info);

    // Load a local `.env` (walks up from the binary's dir, finding `app/.env` in
    // dev) so credentials like MUESLY_GOOGLE_CLIENT_ID/SECRET reach std::env.
    // No-op when absent; production builds embed config differently.
    let _ = dotenvy::dotenv();

    // Best-effort crash reporting: forward Rust panics to PostHog error tracking.
    // No-op unless analytics is enabled (the client is None otherwise), and the
    // message is redacted before sending. Chains onto the previous hook so default
    // logging/abort behavior is preserved; `capture_panic` only enqueues, so it is
    // safe to call from the panic context.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(client) = analytics::commands::current_client() {
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".to_string());
            let frames = info
                .location()
                .map(|loc| {
                    vec![analytics::ExceptionFrame {
                        filename: Some(loc.file().to_string()),
                        function: None,
                        lineno: Some(loc.line()),
                        colno: Some(loc.column()),
                    }]
                })
                .unwrap_or_default();
            client.capture_panic(&message, frames);
        }
        previous_hook(info);
    }));

    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            log_info!(
                "Second app instance requested with args: {:?}, cwd: {:?}",
                args,
                cwd
            );
            tray::focus_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    let matches = |chord: &str| {
                        chord
                            .parse::<tauri_plugin_global_shortcut::Shortcut>()
                            .map(|s| &s == shortcut)
                            .unwrap_or(false)
                    };
                    let is_dictation = matches(DICTATION_SHORTCUT);
                    // Pill backstops act on key-down only; the handlers themselves
                    // no-op when no recording is active.
                    if matches(pill_window::TOGGLE_PAUSE_SHORTCUT) {
                        if event.state() == ShortcutState::Pressed {
                            crate::tray::toggle_pause_handler(app);
                        }
                        return;
                    }
                    if is_dictation {
                        // Push-to-talk: hold to dictate, release to transcribe + emit.
                        let app = app.clone();
                        match event.state() {
                            ShortcutState::Pressed => {
                                tauri::async_runtime::spawn(async move {
                                    if let Err(e) =
                                        crate::dictation::commands::start_dictation().await
                                    {
                                        log_warn!("Dictation start failed: {}", e);
                                    }
                                });
                            }
                            ShortcutState::Released => {
                                tauri::async_runtime::spawn(async move {
                                    if let Err(e) =
                                        crate::dictation::commands::stop_dictation(app).await
                                    {
                                        log_warn!("Dictation stop failed: {}", e);
                                    }
                                });
                            }
                        }
                    } else if event.state() == ShortcutState::Pressed {
                        // The recording shortcut toggles on key-down.
                        crate::tray::toggle_recording_handler(app);
                    }
                })
                .build(),
        )
        .manage(Arc::new(RwLock::new(
            None::<notifications::manager::NotificationManager<tauri::Wry>>,
        )) as NotificationManagerState<tauri::Wry>)
        .manage(audio::init_system_audio_state())
        .manage(summary::summary_engine::ModelManagerState(Arc::new(tokio::sync::Mutex::new(None))))
        .setup(|_app| {
            log::info!("Application setup complete");

            // Initialize system tray
            if let Err(e) = tray::create_tray(_app.handle()) {
                log::error!("Failed to create system tray: {}", e);
            }

            // If the app was relaunched while a recording is already active,
            // reconcile the pill now that the windows exist: it shows only if the
            // main window is not focused. Best-effort and no-ops if missing.
            if audio::recording_commands::is_recording_active() {
                pill_window::sync_visibility(&_app.handle());
            }

            // Initialize notification system with proper defaults
            log::info!("Initializing notification system...");
            let app_for_notif = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let notif_state = app_for_notif.state::<NotificationManagerState<tauri::Wry>>();
                match notifications::commands::initialize_notification_manager(app_for_notif.clone()).await {
                    Ok(manager) => {
                        // Set default consent and permissions on first launch
                        if let Err(e) = manager.set_consent(true).await {
                            log::error!("Failed to set initial consent: {}", e);
                        }
                        if let Err(e) = manager.request_permission().await {
                            log::error!("Failed to request initial permission: {}", e);
                        }

                        // Store the initialized manager
                        let mut state_lock = notif_state.write().await;
                        *state_lock = Some(manager);
                        log::info!("Notification system initialized with default permissions");
                    }
                    Err(e) => {
                        log::error!("Failed to initialize notification manager: {}", e);
                    }
                }
            });

            // Set models directory to use app_data_dir (unified storage location)
            whisper_engine::commands::set_models_directory(&_app.handle());

            // Initialize Whisper engine on startup
            tauri::async_runtime::spawn(async {
                if let Err(e) = whisper_engine::commands::whisper_init().await {
                    log::error!("Failed to initialize Whisper engine on startup: {}", e);
                }
            });

            // Set Parakeet models directory
            parakeet_engine::commands::set_models_directory(&_app.handle());

            // Initialize Parakeet engine on startup
            tauri::async_runtime::spawn(async {
                if let Err(e) = parakeet_engine::commands::parakeet_init().await {
                    log::error!("Failed to initialize Parakeet engine on startup: {}", e);
                }
            });

            // Start the meeting-app auto-detection watcher if the user enabled it.
            let app_for_detect = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app_for_detect.try_state::<state::AppState>() {
                    match database::repositories::setting::SettingsRepository::get_auto_detect_meetings(
                        state.db_manager.pool(),
                    )
                    .await
                    {
                        Ok(true) => meeting_detect::watcher::start(app_for_detect.clone()),
                        Ok(false) => {}
                        Err(e) => log::error!("Failed to read auto-detect setting: {}", e),
                    }
                }
            });

            // Free model RAM after periods of inactivity (never during recording).
            crate::model_idle::spawn_idle_unload_watcher();

            // Auto-start recording (opt-in) when a calendar meeting begins.
            calendar::scheduler::spawn_meeting_scheduler(_app.handle().clone());

            // Initialize ModelManager for summary engine (async, non-blocking)
            let app_handle_for_model_manager = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match summary::summary_engine::commands::init_model_manager_at_startup(&app_handle_for_model_manager).await {
                    Ok(_) => log::info!("ModelManager initialized successfully at startup"),
                    Err(e) => {
                        log::warn!("Failed to initialize ModelManager at startup: {}", e);
                        log::warn!("ModelManager will be lazy-initialized on first use");
                    }
                }
            });

            // Trigger system audio permission request on startup (similar to microphone permission)
            // #[cfg(target_os = "macos")]
            // {
            //     tauri::async_runtime::spawn(async {
            //         if let Err(e) = audio::permissions::trigger_system_audio_permission() {
            //             log::warn!("Failed to trigger system audio permission: {}", e);
            //         }
            //     });
            // }

            // Initialize database (handles first launch detection and conditional setup).
            // The DB must be ready before commands run, so this stays synchronous, but
            // a failure returns a setup error (logged, graceful exit) rather than an
            // unwinding panic with no user-facing context.
            if let Err(e) = tauri::async_runtime::block_on(async {
                database::setup::initialize_database_on_startup(&_app.handle()).await
            }) {
                log::error!("Failed to initialize database: {}", e);
                return Err(format!("Failed to initialize database: {}", e).into());
            }

            // Keychain preflight and one-time migration.
            // Runs asynchronously so it does not block startup for the UI.
            let app_for_keychain = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let store = crate::keychain::keyring_store();
                if !crate::keychain::check_available(store) {
                    log::warn!("OS keychain is unavailable; API keys remain in SQLite until it is set up");
                    if let Err(e) = app_for_keychain.emit("keychain-unavailable", ()) {
                        log::error!("Failed to emit keychain-unavailable event: {}", e);
                    }
                    return;
                }

                let app_state = app_for_keychain.state::<crate::state::AppState>();
                let pool = app_state.db_manager.pool();

                // Check whether migration has already completed.
                let migrated: Result<Option<i64>, sqlx::Error> =
                    sqlx::query_scalar("SELECT keychainMigrated FROM settings WHERE id = '1' LIMIT 1")
                        .fetch_optional(pool)
                        .await;

                match migrated {
                    Ok(Some(1)) => {
                        log::info!("Keychain migration already complete; skipping");
                    }
                    Ok(_) => {
                        log::info!("Running one-time keychain migration...");
                        match crate::database::repositories::setting::SettingsRepository::migrate_keys_to_keychain(pool, store).await {
                            Ok(crate::database::repositories::setting::MigrationOutcome::Complete) => {
                                log::info!("Keychain migration complete; all API keys moved to OS keychain");
                            }
                            Ok(crate::database::repositories::setting::MigrationOutcome::Partial) => {
                                log::warn!("Keychain migration only partially succeeded; will retry on next launch");
                                if let Err(e) = app_for_keychain.emit("keychain-unavailable", ()) {
                                    log::error!("Failed to emit keychain-unavailable event: {}", e);
                                }
                            }
                            Err(e) => {
                                log::error!("Keychain migration failed with database error: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("Could not read keychainMigrated flag (settings row may not exist yet): {}", e);
                    }
                }
            });

            // Initialize bundled templates directory for dynamic template discovery
            log::info!("Initializing bundled templates directory...");
            if let Ok(resource_path) = _app.handle().path().resource_dir() {
                let templates_dir = resource_path.join("templates");
                log::info!("Setting bundled templates directory to: {:?}", templates_dir);
                summary::templates::set_bundled_templates_dir(templates_dir);
            } else {
                log::warn!("Failed to resolve resource directory for templates");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // The floating pill is only for the backgrounded case: hide it when the
            // main window gains focus (the in-app recording bar takes over), and
            // show it again when focus leaves. sync_visibility itself gates on
            // whether a recording is active.
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    // Use the event's authoritative focus state rather than
                    // re-querying, which can lag on some window managers.
                    pill_window::sync_visibility_with_main_focus(window.app_handle(), *focused);
                }
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => {
                        api.prevent_close();
                        if let Err(e) = window.hide() {
                            log::error!("Failed to hide main window on close request: {}", e);
                        } else {
                            log::info!("Main window hidden to tray on close request");
                        }
                    }
                    // Never destroy the pre-warmed pill: a stray Cmd+W must hide
                    // it, otherwise `pill_window::show` would no-op forever.
                    "pill" => {
                        api.prevent_close();
                        if let Err(e) = window.hide() {
                            log::error!("Failed to hide pill window on close request: {}", e);
                        }
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(make_specta_builder().invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    tray::focus_main_window(_app_handle);
                }
                tauri::RunEvent::Exit => {
                    log::info!("Application exiting, cleaning up resources...");
                    tauri::async_runtime::block_on(async {
                        // Clean up database connection and checkpoint WAL
                        if let Some(app_state) = _app_handle.try_state::<state::AppState>() {
                            log::info!("Starting database cleanup...");
                            if let Err(e) = app_state.db_manager.cleanup().await {
                                log::error!("Failed to cleanup database: {}", e);
                            } else {
                                log::info!("Database cleanup completed successfully");
                            }
                        } else {
                            log::warn!("AppState not available for database cleanup (likely first launch)");
                        }

                        // Clean up sidecar
                        log::info!("Cleaning up sidecar...");
                        if let Err(e) = summary::summary_engine::force_shutdown_sidecar().await {
                            log::error!("Failed to force shutdown sidecar: {}", e);
                        }
                    });
                    log::info!("Application cleanup complete");
                }
                _ => {}
            }
        });
}
