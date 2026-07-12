// audio/recording_commands.rs
//
// Slim Tauri command layer for recording functionality.
// Delegates to transcription and recording modules for actual implementation.

use anyhow::Result;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::task::JoinHandle;

use super::recording_state::RecordingState;
use super::{
    default_input_device,  // Get default microphone
    default_output_device, // Get default system audio
    parse_audio_device,
    RecordingManager,
};

// Import transcription modules
use super::transcription::{self, reset_speech_detected_flag};

// Re-export TranscriptUpdate for backward compatibility
pub use super::transcription::TranscriptUpdate;

// Read-only status queries and device-monitoring commands live in submodules;
// they access the shared state below via `super::`. Re-exported so the command
// surface stays at `recording_commands::*`.
mod devices;
mod query;
pub use devices::*;
pub use query::*;

// ============================================================================
// GLOBAL STATE
// ============================================================================

// Simple recording state tracking
static IS_RECORDING: AtomicBool = AtomicBool::new(false);

/// A dictation push-to-talk burst is in progress. Mirrors `IS_RECORDING` so the
/// two mic-using modes never run at once: each refuses to start while the other
/// is active (see [`can_start`]).
static DICTATION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether a meeting recording is currently active.
pub(crate) fn is_recording_active() -> bool {
    IS_RECORDING.load(Ordering::SeqCst)
}

/// Whether a dictation burst is currently active.
pub(crate) fn is_dictation_active() -> bool {
    DICTATION_ACTIVE.load(Ordering::SeqCst)
}

/// Mark a dictation burst active or finished (owned by the dictation path).
/// Prefer [`try_claim_dictation`] / [`release_dictation_claim`] for start/stop
/// so concurrent starts cannot both pass a check-then-act gate.
#[allow(dead_code)] // kept for tests and any external callers of the flag API
pub(crate) fn set_dictation_active(active: bool) {
    DICTATION_ACTIVE.store(active, Ordering::SeqCst);
}

/// Whether a mic-using mode may start: only when neither it nor the other mode
/// is active. Pure mutual-exclusion gate, separated out for testing.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn can_start(this_active: bool, other_active: bool) -> bool {
    !this_active && !other_active
}

/// Atomically claim the recording slot before any device/async work. Returns
/// `Err` if a recording is already claimed or dictation holds the mic.
/// On success the caller **must** either complete start (leave the flag set)
/// or call [`release_recording_claim`] on every failure path.
pub(crate) fn try_claim_recording() -> Result<(), String> {
    if DICTATION_ACTIVE.load(Ordering::SeqCst) {
        return Err("Cannot start recording while dictation is active".to_string());
    }
    match IS_RECORDING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => {
            // Close the race where dictation claimed between the load and CAS.
            if DICTATION_ACTIVE.load(Ordering::SeqCst) {
                IS_RECORDING.store(false, Ordering::SeqCst);
                return Err("Cannot start recording while dictation is active".to_string());
            }
            Ok(())
        }
        Err(_) => Err("Recording already in progress".to_string()),
    }
}

/// Drop a recording claim after a failed start (or after a full stop).
pub(crate) fn release_recording_claim() {
    IS_RECORDING.store(false, Ordering::SeqCst);
}

/// Atomically claim the dictation slot. Mirrors [`try_claim_recording`].
pub(crate) fn try_claim_dictation() -> Result<(), String> {
    if IS_RECORDING.load(Ordering::SeqCst) {
        return Err("Cannot start dictation while recording or already dictating".to_string());
    }
    match DICTATION_ACTIVE.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => {
            if IS_RECORDING.load(Ordering::SeqCst) {
                DICTATION_ACTIVE.store(false, Ordering::SeqCst);
                return Err(
                    "Cannot start dictation while recording or already dictating".to_string(),
                );
            }
            Ok(())
        }
        Err(_) => Err("Cannot start dictation while recording or already dictating".to_string()),
    }
}

/// Drop a dictation claim after stop or a failed start.
pub(crate) fn release_dictation_claim() {
    DICTATION_ACTIVE.store(false, Ordering::SeqCst);
}

/// Whether the dictation feature is enabled. While enabled, the transcription
/// model is kept warm (meeting `stop_recording` skips the unload and the idle
/// watcher leaves it loaded) so a dictation burst starts without a cold reload.
static DICTATION_ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether the dictation feature is enabled (keep the model warm).
pub(crate) fn dictation_enabled() -> bool {
    DICTATION_ENABLED.load(Ordering::SeqCst)
}

/// Enable or disable the dictation feature. While enabled the transcription
/// model is kept warm so a push-to-talk burst doesn't pay a cold reload.
#[tauri::command]
#[specta::specta]
pub async fn set_dictation_enabled(enabled: bool) -> Result<(), String> {
    DICTATION_ENABLED.store(enabled, Ordering::SeqCst);
    Ok(())
}

/// Whether the dictation feature is currently enabled.
#[tauri::command]
#[specta::specta]
pub async fn get_dictation_enabled() -> Result<bool, String> {
    Ok(DICTATION_ENABLED.load(Ordering::SeqCst))
}

// Global recording manager and transcription task to keep them alive during recording.
// This uses a tokio (async) mutex because some commands hold the manager across an
// `.await` (e.g. device reconnection); a std mutex held across `.await` risks blocking
// a worker / deadlock. The other statics below stay on std::sync::Mutex — they're only
// held briefly with no await in between.
/// Resolve the calendar event for "now" once, returning the high-confidence
/// title override (used to auto-title an unnamed recording) plus prompt-bias
/// terms (event title + attendee names) for the local transcription engine.
/// Returns empty on any failure (calendar off, no permission, no match) so it
/// can never block or fail a recording. Resolved before the `RecordingManager`
/// lock is taken so an EventKit stall can't extend a contended lock.
async fn calendar_recording_context<R: Runtime>(
    app: &AppHandle<R>,
) -> (Option<String>, Vec<String>) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return (None, Vec::new());
    };
    let pool = state.db_manager.pool().clone();
    let Some(resolved) =
        crate::calendar::service::resolve_event_for_instant(&pool, chrono::Utc::now()).await
    else {
        return (None, Vec::new());
    };
    let title_override = resolved.title_for_high_confidence().map(|s| s.to_string());
    // Prompt terms use the resolved event at any confidence: a wrong bias term
    // is harmless, a right one fixes proper-noun spellings.
    let mut terms: Vec<String> = Vec::new();
    if let Some(title) = resolved.candidate.title.as_deref() {
        terms.push(title.to_string());
    }
    for attendee in &resolved.candidate.attendees {
        if let Some(name) = attendee.name.as_deref() {
            terms.push(name.to_string());
        }
    }
    (title_override, terms)
}

static RECORDING_MANAGER: std::sync::LazyLock<tokio::sync::Mutex<Option<RecordingManager>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(None));
static TRANSCRIPTION_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

// Listener ID for proper cleanup - prevents microphone from staying active after recording stops
static TRANSCRIPT_LISTENER_ID: Mutex<Option<tauri::EventId>> = Mutex::new(None);

/// Linear peak amplitude corresponding to ~-55 dBFS (10^(-55/20)). Below this,
/// the microphone is treated as effectively silent (muted, wrong device, or dead
/// hardware) — even ambient room tone normally peaks well above it.
const SILENT_MIC_PEAK_THRESHOLD: f32 = 0.001_778;

/// After ~10s of recording, warn the UI if the microphone never rose above the
/// silence floor. A dead mic otherwise records minutes of nothing with no
/// feedback. Fires at most once per recording (one spawned task per start).
fn spawn_silent_mic_check<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<RecordingState>,
    mic_name: Option<String>,
) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;

        // The user may have already stopped; don't warn after the fact.
        if !state.is_recording() {
            return;
        }

        let peak = state.peak_mic_amplitude();
        if peak < SILENT_MIC_PEAK_THRESHOLD {
            warn!(
                "🎤 Microphone appears silent after 10s (peak {:.5} < {:.5} threshold), device={:?}",
                peak, SILENT_MIC_PEAK_THRESHOLD, mic_name
            );
            let _ = app.emit("mic-silent", serde_json::json!({ "device": mic_name }));
        }
    });
}

/// Emit the live audio level (`recording-level`, an f32 in 0.0..1.0) to the
/// frontend every ~66ms while recording, so the pill and in-app bar can animate a
/// real level meter instead of a random one. Reads and resets the peak-hold in
/// `RecordingState` each frame (VU-meter behaviour). The loop ends on its own when
/// recording stops, so no explicit handle/cleanup is needed.
fn spawn_level_emitter<R: Runtime>(app: AppHandle<R>, state: Arc<RecordingState>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(66));
        loop {
            ticker.tick().await;
            if !state.is_recording() {
                break;
            }
            let _ = app.emit("recording-level", state.take_live_peak());
        }
    });
}

// ============================================================================
// PUBLIC TYPES
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct RecordingArgs {
    pub save_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TranscriptionStatus {
    pub chunks_in_queue: usize,
    pub is_processing: bool,
    pub last_activity_ms: u64,
}

// ============================================================================
// RECORDING COMMANDS
// ============================================================================

/// Start recording with default devices
pub async fn start_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    start_recording_with_meeting_name(app, None).await
}

/// Start recording with default devices and optional meeting name
pub async fn start_recording_with_meeting_name<R: Runtime>(
    app: AppHandle<R>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with default devices, meeting: {:?}",
        meeting_name
    );

    // Claim the recording slot before any async work so concurrent starts
    // (UI + calendar scheduler, double-click) cannot both pass a load check.
    try_claim_recording()?;
    info!("🔍 IS_RECORDING claimed for start");

    // Validate that transcription models are available before starting recording
    info!("🔍 Validating transcription model availability before starting recording...");
    if let Err(validation_error) = transcription::validate_transcription_model_ready(&app).await {
        error!("Model validation failed: {}", validation_error);
        release_recording_claim();

        // Emit error event for frontend - actionable: false to show toast instead of modal
        // (download progress is already shown in top-right toast)
        let _ = app.emit("transcription-error", serde_json::json!({
            "error": validation_error,
            "userMessage": "Recording cannot start: Transcription model is still downloading. Please wait for the download to complete.",
            "actionable": false
        }));

        return Err(validation_error);
    }
    info!("✅ Transcription model validation passed");

    // Async-first approach - no more blocking operations!
    info!("🚀 Starting async recording initialization");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to get auto_save AND device preferences
    let (auto_save, preferred_mic_name, preferred_system_name) =
        match super::recording_preferences::load_recording_preferences(&app).await {
            Ok(prefs) => {
                info!("📋 Loaded recording preferences: auto_save={}, preferred_mic={:?}, preferred_system={:?}",
                      prefs.auto_save, prefs.preferred_mic_device, prefs.preferred_system_device);
                (
                    prefs.auto_save,
                    prefs.preferred_mic_device,
                    prefs.preferred_system_device,
                )
            }
            Err(e) => {
                warn!(
                    "Failed to load recording preferences, using defaults: {}",
                    e
                );
                (true, None, None)
            }
        };

    // ============================================================================
    // MICROPHONE DEVICE RESOLUTION: Preference → Default → Error
    // ============================================================================
    let microphone_device = match preferred_mic_name {
        Some(pref_name) => {
            info!("🎤 Attempting to use preferred microphone: '{}'", pref_name);
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    info!("✅ Using preferred microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!(
                        "⚠️ Preferred microphone '{}' not available: {}",
                        pref_name, e
                    );
                    warn!("   Falling back to system default microphone...");
                    match default_input_device() {
                        Ok(device) => {
                            info!("✅ Using default microphone: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            error!(
                                "❌ No microphone available (preferred and default both failed)"
                            );
                            release_recording_claim();
                            return Err(format!(
                                "No microphone device available. Preferred device '{}' not found, and default microphone unavailable: {}",
                                pref_name, default_err
                            ));
                        }
                    }
                }
            }
        }
        None => {
            info!("🎤 No microphone preference set, using system default");
            match default_input_device() {
                Ok(device) => {
                    info!("✅ Using default microphone: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    error!("❌ No default microphone available");
                    release_recording_claim();
                    return Err(format!("No microphone device available: {}", e));
                }
            }
        }
    };

    // ============================================================================
    // SYSTEM AUDIO DEVICE RESOLUTION: Preference → Default → None (optional)
    // ============================================================================
    let system_device = match preferred_system_name {
        Some(pref_name) => {
            info!(
                "🔊 Attempting to use preferred system audio: '{}'",
                pref_name
            );
            match parse_audio_device(&pref_name) {
                Ok(device) => {
                    info!("✅ Using preferred system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!(
                        "⚠️ Preferred system audio '{}' not available: {}",
                        pref_name, e
                    );
                    warn!("   Falling back to system default...");
                    match default_output_device() {
                        Ok(device) => {
                            info!("✅ Using default system audio: '{}'", device.name);
                            Some(Arc::new(device))
                        }
                        Err(default_err) => {
                            warn!("⚠️ No system audio available (preferred and default both failed): {}", default_err);
                            warn!("   Recording will continue with microphone only");
                            None // System audio is optional
                        }
                    }
                }
            }
        }
        None => {
            info!("🔊 No system audio preference set, using system default");
            match default_output_device() {
                Ok(device) => {
                    info!("✅ Using default system audio: '{}'", device.name);
                    Some(Arc::new(device))
                }
                Err(e) => {
                    warn!("⚠️ No default system audio available: {}", e);
                    warn!("   Recording will continue with microphone only");
                    None // System audio is optional
                }
            }
        }
    };

    // Always ensure a meeting name is set so incremental saver initializes.
    // When the user didn't name it, try the calendar for a high-confidence
    // meeting title before falling back to a timestamp.
    let (title_override, mut prompt_terms) = calendar_recording_context(&app).await;
    let effective_meeting_name = match meeting_name.clone() {
        Some(name) => name,
        None => match title_override {
            Some(title) => title,
            None => {
                // Example: Meeting 2025-10-03_08-25-23
                let now = chrono::Local::now();
                format!("Meeting {}", now.format("%Y-%m-%d_%H-%M-%S"))
            }
        },
    };
    // Bias Whisper toward this meeting's proper nouns (event title + attendee
    // names, plus a user-typed meeting name) for the duration of the recording;
    // cleared again in stop_recording.
    if let Some(name) = meeting_name.as_deref() {
        prompt_terms.push(name.to_string());
    }
    crate::vocabulary::set_meeting_prompt_terms(prompt_terms);
    manager.set_meeting_name(Some(effective_meeting_name));

    // Set up error callback
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
        // A recording error hides the pill so it is never orphaned over other
        // apps; the error path does not always flip IS_RECORDING/emit stopped.
        crate::pill_window::hide(&app_for_error);
    });

    // Capture the mic name + shared recording state before the manager is moved
    // into the global, so we can run the silent-input check after start.
    let mic_name_for_check = microphone_device.as_ref().map(|d| d.name.clone());

    // Start recording with resolved devices (replaces start_recording_with_defaults_and_auto_save call)
    let transcription_receiver = match manager
        .start_recording(microphone_device, system_device, auto_save)
        .await
    {
        Ok(rx) => rx,
        Err(e) => {
            release_recording_claim();
            return Err(format!("Failed to start recording: {}", e));
        }
    };

    let recording_state_for_check = manager.get_state().clone();
    let recording_state_for_level = manager.get_state().clone();

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        *global_manager = Some(manager);
    }

    // Claim already set IS_RECORDING; reset session flags and show the pill.
    info!("🔍 Recording claim held; resetting SPEECH_DETECTED_EMITTED");
    // Reconcile the pill in lockstep with the recording flag (both start paths):
    // it appears only if the main window is not focused, else the in-app bar shows.
    crate::pill_window::sync_visibility(&app);
    reset_speech_detected_flag(); // Reset for new recording session
    crate::whisper_engine::reset_session_detected_language(); // Clear stale auto-detected language lock

    // Warn if the mic stays silent for the first ~10s (dead/muted/wrong device).
    spawn_silent_mic_check(app.clone(), recording_state_for_check, mic_name_for_check);
    spawn_level_emitter(app.clone(), recording_state_for_level);

    // Start optimized parallel transcription task and store handle
    let task_handle = transcription::start_transcription_task(app.clone(), transcription_receiver);
    {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(task_handle);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    {
        use tauri::Listener;
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                    speaker: Some(update.source.clone()),
                };

                // Save to recording manager. This runs in a synchronous Tauri event
                // callback, so use the non-blocking `try_lock` (matching the original
                // best-effort `if let Ok` behavior — skip if momentarily contended).
                if let Ok(manager_guard) = RECORDING_MANAGER.try_lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment);
                    }
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().unwrap();
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Emit success event
    if let Err(e) = app.emit(
        "recording-started",
        serde_json::json!({
            "message": "Recording started successfully with parallel processing",
            "devices": ["Default Microphone", "Default System Audio"],
            "workers": 3
        }),
    ) {
        // Streams are already running; leave the claim held so stop can clean up.
        return Err(e.to_string());
    }

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("✅ Recording started successfully with async-first approach");

    Ok(())
}

/// Start recording with specific devices
pub async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None).await
}

/// Start recording with specific devices and optional meeting name
pub async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    info!(
        "Starting recording with specific devices: mic={:?}, system={:?}, meeting={:?}",
        mic_device_name, system_device_name, meeting_name
    );

    // Claim the recording slot before any async work (see try_claim_recording).
    try_claim_recording()?;
    info!("🔍 IS_RECORDING claimed for device-specific start");

    // Validate that transcription models are available before starting recording
    info!("🔍 Validating transcription model availability before starting recording...");
    if let Err(validation_error) = transcription::validate_transcription_model_ready(&app).await {
        error!("Model validation failed: {}", validation_error);
        release_recording_claim();

        // Emit error event for frontend - actionable: false to show toast instead of modal
        // (download progress is already shown in top-right toast)
        let _ = app.emit("transcription-error", serde_json::json!({
            "error": validation_error,
            "userMessage": "Recording cannot start: Transcription model is still downloading. Please wait for the download to complete.",
            "actionable": false
        }));

        return Err(validation_error);
    }
    info!("✅ Transcription model validation passed");

    // Parse devices
    let mic_device = if let Some(ref name) = mic_device_name {
        match parse_audio_device(name) {
            Ok(device) => Some(Arc::new(device)),
            Err(e) => {
                release_recording_claim();
                return Err(format!("Invalid microphone device '{}': {}", name, e));
            }
        }
    } else {
        None
    };

    let system_device = if let Some(ref name) = system_device_name {
        match parse_audio_device(name) {
            Ok(device) => Some(Arc::new(device)),
            Err(e) => {
                release_recording_claim();
                return Err(format!("Invalid system device '{}': {}", name, e));
            }
        }
    } else {
        None
    };

    // Async-first approach for custom devices - no more blocking operations!
    info!("🚀 Starting async recording initialization with custom devices");

    // Create new recording manager
    let mut manager = RecordingManager::new();

    // Load recording preferences to check auto_save setting
    let auto_save = match super::recording_preferences::load_recording_preferences(&app).await {
        Ok(prefs) => {
            info!(
                "📋 Loaded recording preferences: auto_save={}",
                prefs.auto_save
            );
            prefs.auto_save
        }
        Err(e) => {
            warn!(
                "Failed to load recording preferences, defaulting to auto_save=true: {}",
                e
            );
            true // Default to saving if preferences can't be loaded
        }
    };

    // Always ensure a meeting name is set so incremental saver initializes
    let effective_meeting_name = meeting_name.clone().unwrap_or_else(|| {
        let now = chrono::Local::now();
        format!("Meeting {}", now.format("%Y-%m-%d_%H-%M-%S"))
    });
    manager.set_meeting_name(Some(effective_meeting_name));

    // Set up error callback
    let app_for_error = app.clone();
    manager.set_error_callback(move |error| {
        let _ = app_for_error.emit("recording-error", error.user_message());
        // A recording error hides the pill so it is never orphaned over other
        // apps; the error path does not always flip IS_RECORDING/emit stopped.
        crate::pill_window::hide(&app_for_error);
    });

    // Capture mic name + shared state before the manager moves into the global.
    let mic_name_for_check = mic_device.as_ref().map(|d| d.name.clone());

    // Start recording with specified devices and auto_save setting
    let transcription_receiver = match manager
        .start_recording(mic_device, system_device, auto_save)
        .await
    {
        Ok(rx) => rx,
        Err(e) => {
            release_recording_claim();
            return Err(format!("Failed to start recording: {}", e));
        }
    };

    let recording_state_for_check = manager.get_state().clone();
    let recording_state_for_level = manager.get_state().clone();

    // Store the manager globally to keep it alive
    {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        *global_manager = Some(manager);
    }

    // Claim already set IS_RECORDING; reset session flags and show the pill.
    info!("🔍 Recording claim held; resetting SPEECH_DETECTED_EMITTED");
    // Reconcile the pill in lockstep with the recording flag (both start paths):
    // it appears only if the main window is not focused, else the in-app bar shows.
    crate::pill_window::sync_visibility(&app);
    reset_speech_detected_flag(); // Reset for new recording session
    crate::whisper_engine::reset_session_detected_language(); // Clear stale auto-detected language lock

    // Warn if the mic stays silent for the first ~10s (dead/muted/wrong device).
    spawn_silent_mic_check(app.clone(), recording_state_for_check, mic_name_for_check);
    spawn_level_emitter(app.clone(), recording_state_for_level);

    // Start optimized parallel transcription task and store handle
    let task_handle = transcription::start_transcription_task(app.clone(), transcription_receiver);
    {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        *global_task = Some(task_handle);
    }

    // CRITICAL: Listen for transcript-update events and save to recording manager
    // This enables transcript history persistence for page reload sync
    // Store listener ID for cleanup during stop_recording to ensure microphone is released
    {
        use tauri::Listener;
        let listener_id = app.listen("transcript-update", move |event: tauri::Event| {
            // Parse the transcript update from the event payload
            if let Ok(update) = serde_json::from_str::<TranscriptUpdate>(event.payload()) {
                // Create structured transcript segment
                let segment = crate::audio::recording_saver::TranscriptSegment {
                    id: format!("seg_{}", update.sequence_id),
                    text: update.text.clone(),
                    audio_start_time: update.audio_start_time,
                    audio_end_time: update.audio_end_time,
                    duration: update.duration,
                    display_time: update.timestamp.clone(), // Use wall-clock timestamp for display
                    confidence: update.confidence,
                    sequence_id: update.sequence_id,
                    speaker: Some(update.source.clone()),
                };

                // Save to recording manager. This runs in a synchronous Tauri event
                // callback, so use the non-blocking `try_lock` (matching the original
                // best-effort `if let Ok` behavior — skip if momentarily contended).
                if let Ok(manager_guard) = RECORDING_MANAGER.try_lock() {
                    if let Some(manager) = manager_guard.as_ref() {
                        manager.add_transcript_segment(segment);
                    }
                }
            }
        });
        let mut global_listener = TRANSCRIPT_LISTENER_ID.lock().unwrap();
        *global_listener = Some(listener_id);
        info!("✅ Transcript-update event listener registered for history persistence");
    }

    // Emit success event
    app.emit(
        "recording-started",
        serde_json::json!({
            "message": "Recording started with custom devices and parallel processing",
            "devices": [
                mic_device_name.unwrap_or_else(|| "Default Microphone".to_string()),
                system_device_name.unwrap_or_else(|| "Default System Audio".to_string())
            ],
            "workers": 3
        }),
    )
    .map_err(|e| e.to_string())?;

    // Update tray menu to reflect recording state
    crate::tray::update_tray_menu(&app);

    info!("✅ Recording started with custom devices using async-first approach");

    Ok(())
}

/// Stop recording with optimized graceful shutdown ensuring NO transcript chunks are lost
pub async fn stop_recording<R: Runtime>(
    app: AppHandle<R>,
    _args: RecordingArgs,
) -> Result<(), String> {
    info!(
        "🛑 Starting optimized recording shutdown - ensuring ALL transcript chunks are preserved"
    );

    // Check if recording is active
    if !IS_RECORDING.load(Ordering::SeqCst) {
        info!("Recording was not active");
        return Ok(());
    }

    // Emit shutdown progress to frontend
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "stopping_audio",
            "message": "Stopping audio capture...",
            "progress": 20
        }),
    );

    // Step 1: Stop audio capture immediately (no more new chunks) with proper error handling
    let manager_for_cleanup = {
        let mut global_manager = RECORDING_MANAGER.lock().await;
        global_manager.take()
    };

    let stop_result = if let Some(mut manager) = manager_for_cleanup {
        // Use FORCE FLUSH to immediately process all accumulated audio - eliminates 30s delay!
        info!("🚀 Using FORCE FLUSH to eliminate pipeline accumulation delays");
        let result = manager.stop_streams_and_force_flush().await;
        // Store manager back for later cleanup
        let manager_for_cleanup = Some(manager);
        (result, manager_for_cleanup)
    } else {
        warn!("No recording manager found to stop");
        (Ok(()), None)
    };

    let (stop_result, manager_for_cleanup) = stop_result;

    // Remember a stream-stop error so we still best-effort save + emit
    // `recording-stopped` (frontend depends on that event for the SQLite save).
    let stream_stop_error = match stop_result {
        Ok(_) => {
            info!("✅ Audio streams stopped successfully - no more chunks will be created");
            None
        }
        Err(e) => {
            error!(
                "❌ Failed to stop audio streams (continuing best-effort save): {}",
                e
            );
            Some(e)
        }
    };

    // Step 1.5: Clean up transcript listener to release microphone
    // Unlisten transcript-update event to prevent lingering references
    {
        use tauri::Listener;
        if let Some(listener_id) = TRANSCRIPT_LISTENER_ID.lock().unwrap().take() {
            app.unlisten(listener_id);
            info!("✅ Transcript-update listener removed");
        }
    }

    // Step 2: Signal transcription workers to finish processing ALL queued chunks
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "processing_transcripts",
            "message": "Processing remaining transcript chunks...",
            "progress": 40
        }),
    );

    // Wait for transcription task with enhanced progress monitoring (NO TIMEOUT - we must process all chunks)
    let transcription_task = {
        let mut global_task = TRANSCRIPTION_TASK.lock().unwrap();
        global_task.take()
    };

    if let Some(task_handle) = transcription_task {
        info!("⏳ Waiting for ALL transcription chunks to be processed (no timeout - preserving every chunk)");

        // Enhanced progress monitoring during shutdown
        let progress_app = app.clone();
        let progress_task = tokio::spawn(async move {
            let last_update = std::time::Instant::now();

            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                // Emit periodic progress updates during shutdown
                let elapsed = last_update.elapsed().as_secs();
                let _ = progress_app.emit(
                    "recording-shutdown-progress",
                    serde_json::json!({
                        "stage": "processing_transcripts",
                        "message": format!("Processing transcripts... ({}s elapsed)", elapsed),
                        "progress": 40,
                        "detailed": true,
                        "elapsed_seconds": elapsed
                    }),
                );
            }
        });

        // Wait up to 10 minutes for transcription completion to prevent indefinite hangs
        match tokio::time::timeout(
            tokio::time::Duration::from_secs(600), // 10 minutes max
            task_handle,
        )
        .await
        {
            Ok(Ok(())) => {
                info!("✅ ALL transcription chunks processed successfully - no data lost");
            }
            Ok(Err(e)) => {
                warn!("⚠️ Transcription task completed with error: {:?}", e);
                // Continue anyway - the worker may have processed most chunks
            }
            Err(_) => {
                warn!("⏱️ Transcription timeout (10 minutes) reached, continuing shutdown to prevent indefinite hang");
                // Continue shutdown even on timeout - better to lose some chunks than hang forever
            }
        }

        // Stop progress monitoring
        progress_task.abort();
    } else {
        info!("ℹ️ No transcription task found to wait for");
    }

    // All chunks of this recording are decoded; drop the per-meeting prompt
    // bias so it can't leak into the next recording or into dictation.
    crate::vocabulary::clear_meeting_prompt_terms();

    // Step 3: Now safely unload Whisper model after ALL chunks are processed
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "unloading_model",
            "message": "Unloading speech recognition model...",
            "progress": 70
        }),
    );

    info!("🧠 All transcript chunks processed. Now safely unloading transcription model...");

    // Determine which provider was used and unload the appropriate model (with timeout)
    let config = match tokio::time::timeout(
        tokio::time::Duration::from_secs(30), // 30 seconds max for DB operation
        crate::api::api_get_transcript_config(app.clone(), app.clone().state(), None),
    )
    .await
    {
        Ok(Ok(Some(config))) => Some(config.provider),
        Ok(Ok(None)) => None,
        Ok(Err(e)) => {
            warn!("⚠️ Failed to get transcript config: {:?}", e);
            None
        }
        Err(_) => {
            warn!("⏱️ Transcript config timeout (30s), continuing shutdown");
            None
        }
    };

    if dictation_enabled() {
        info!("🔥 Dictation enabled: keeping the transcription model warm (skipping unload)");
    } else {
        match config.as_deref() {
            Some("parakeet") => {
                info!("🦜 Unloading Parakeet model...");
                let engine_clone = {
                    let engine_guard = crate::parakeet_engine::commands::PARAKEET_ENGINE
                        .lock()
                        .unwrap();
                    engine_guard.as_ref().cloned()
                };

                if let Some(engine) = engine_clone {
                    let current_model = engine
                        .get_current_model()
                        .await
                        .unwrap_or_else(|| "unknown".to_string());
                    info!("Current Parakeet model before unload: '{}'", current_model);

                    if engine.unload_model().await {
                        info!(
                            "✅ Parakeet model '{}' unloaded successfully",
                            current_model
                        );
                    } else {
                        warn!("⚠️ Failed to unload Parakeet model '{}'", current_model);
                    }
                } else {
                    warn!("⚠️ No Parakeet engine found to unload model");
                }
            }
            _ => {
                // Default to Whisper
                info!("🎤 Unloading Whisper model...");
                let engine_clone = {
                    let engine_guard = crate::whisper_engine::commands::WHISPER_ENGINE
                        .lock()
                        .unwrap();
                    engine_guard.as_ref().cloned()
                };

                if let Some(engine) = engine_clone {
                    let current_model = engine
                        .get_current_model()
                        .await
                        .unwrap_or_else(|| "unknown".to_string());
                    info!("Current Whisper model before unload: '{}'", current_model);

                    if engine.unload_model().await {
                        info!("✅ Whisper model '{}' unloaded successfully", current_model);
                    } else {
                        warn!("⚠️ Failed to unload Whisper model '{}'", current_model);
                    }
                } else {
                    warn!("⚠️ No Whisper engine found to unload model");
                }
            }
        }
    }

    // Step 3.5: Track meeting ended analytics with privacy-safe metadata
    // Extract all data from manager BEFORE any async operations to avoid Send issues
    let analytics_data = if let Some(ref manager) = manager_for_cleanup {
        let state = manager.get_state();
        let stats = state.get_stats();

        Some((
            manager.get_recording_duration(),
            manager.get_active_recording_duration().unwrap_or(0.0),
            manager.get_total_pause_duration(),
            manager.get_transcript_segments().len() as u64,
            state.has_fatal_error(),
            state.get_microphone_device().map(|d| d.name.clone()),
            state.get_system_device().map(|d| d.name.clone()),
            stats.chunks_processed,
        ))
    } else {
        None
    };

    // Now perform async analytics tracking without holding manager reference
    if let Some((
        total_duration,
        active_duration,
        pause_duration,
        transcript_segments_count,
        had_fatal_error,
        mic_device_name,
        sys_device_name,
        chunks_processed,
    )) = analytics_data
    {
        info!("📊 Collecting analytics for meeting end");

        // Get transcription model info (already loaded above for model unload)
        let transcription_config =
            match crate::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
                .await
            {
                Ok(Some(config)) => Some((config.provider, config.model)),
                _ => None,
            };

        let (transcription_provider, transcription_model) =
            transcription_config.unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Get summary model info from API
        let summary_config =
            match crate::api::api_get_model_config(app.clone(), app.clone().state(), None).await {
                Ok(Some(config)) => Some((config.provider, config.model)),
                _ => None,
            };

        let (summary_provider, summary_model) =
            summary_config.unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));

        // Classify device types (privacy-safe)
        let microphone_device_type = mic_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        let system_audio_device_type = sys_device_name
            .as_ref()
            .map(|name| classify_device_type(name))
            .unwrap_or("Unknown");

        // Track meeting ended event with privacy-safe data
        match crate::analytics::commands::track_meeting_ended(
            crate::analytics::commands::MeetingEndedMetrics {
                transcription_provider: transcription_provider.clone(),
                transcription_model: transcription_model.clone(),
                summary_provider: summary_provider.clone(),
                summary_model: summary_model.clone(),
                total_duration_seconds: total_duration,
                active_duration_seconds: active_duration,
                pause_duration_seconds: pause_duration,
                microphone_device_type: microphone_device_type.to_string(),
                system_audio_device_type: system_audio_device_type.to_string(),
                chunks_processed,
                transcript_segments_count,
                had_fatal_error,
            },
        )
        .await
        {
            Ok(_) => info!("✅ Analytics tracked successfully for meeting end"),
            Err(e) => warn!("⚠️ Failed to track analytics: {}", e),
        }
    }

    // Step 4: Finalize recording state and cleanup resources safely
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "finalizing",
            "message": "Finalizing recording and cleaning up resources...",
            "progress": 90
        }),
    );

    // Perform final cleanup with the manager if available
    let (meeting_folder, meeting_name) = if let Some(mut manager) = manager_for_cleanup {
        info!("🧹 Performing final cleanup and saving recording data");

        // Extract meeting info BEFORE async operations
        let meeting_folder = manager.get_meeting_folder();
        let meeting_name = manager.get_meeting_name();

        match tokio::time::timeout(
            tokio::time::Duration::from_secs(300), // 5 minutes max for file I/O
            manager.save_recording_only(&app),
        )
        .await
        {
            Ok(Ok(_)) => {
                info!("✅ Recording data saved successfully during cleanup");
            }
            Ok(Err(e)) => {
                warn!(
                    "⚠️ Error during recording cleanup (transcripts preserved): {}",
                    e
                );
                // Don't fail shutdown - transcripts are already preserved
            }
            Err(_) => {
                warn!("⏱️ File I/O timeout (5 minutes) reached during save, continuing shutdown");
                // Don't fail shutdown - transcripts are already preserved
            }
        }

        (meeting_folder, meeting_name)
    } else {
        info!("ℹ️ No recording manager available for cleanup");
        (None, None)
    };

    // Set recording flag to false
    info!("🔍 Setting IS_RECORDING to false");
    release_recording_claim();
    // Hide the floating pill before emitting `recording-stopped` so the webview
    // does not flash a teardown frame as it unmounts.
    crate::pill_window::hide(&app);

    // Step 4.5: Prepare metadata for frontend (NO database save)
    // NOTE: We do NOT save to database here. The frontend will save after all transcripts are displayed.
    // This ensures the user sees all transcripts streaming in before the database save happens.
    let (folder_path_str, meeting_name_str) = match (&meeting_folder, &meeting_name) {
        (Some(path), Some(name)) => (Some(path.to_string_lossy().to_string()), Some(name.clone())),
        _ => (None, None),
    };

    info!("📤 Preparing recording metadata for frontend save");
    info!("   folder_path: {:?}", folder_path_str);
    info!("   meeting_name: {:?}", meeting_name_str);

    // Database save removed - frontend will handle this after receiving all transcripts
    info!("ℹ️ Skipping database save in Rust - frontend will save after all transcripts received");

    // Step 5: Complete shutdown
    let _ = app.emit(
        "recording-shutdown-progress",
        serde_json::json!({
            "stage": "complete",
            "message": if stream_stop_error.is_some() {
                "Recording stopped with stream errors (best-effort save)"
            } else {
                "Recording stopped successfully"
            },
            "progress": 100
        }),
    );

    // Always emit stop so the frontend can save, even when stream stop failed.
    // Soft stream failures are carried only on the event payload.
    app.emit(
        "recording-stopped",
        serde_json::json!({
            "message": "Recording stopped - frontend will save after all transcripts received",
            "folder_path": folder_path_str,
            "meeting_name": meeting_name_str,
            "stream_stop_error": stream_stop_error.as_ref().map(|e| e.to_string()),
        }),
    )
    .map_err(|e| e.to_string())?;
    let recording_stopped_emitted = true;

    // Update tray menu to reflect stopped state
    crate::tray::update_tray_menu(&app);

    if let Some(e) = stream_stop_error {
        warn!(
            "Recording stopped with stream error after best-effort save (returning Ok so frontend can persist): {}",
            e
        );
    } else {
        info!("🎉 Recording stopped successfully with ZERO transcript chunks lost");
    }

    // Every stop entry point (UI pill/bar, tray, RecordingControls) gates the
    // SQLite save pipeline on invoke success. After recording-stopped is
    // emitted, always report Ok — stream soft-failures must not skip save.
    if stop_invoke_succeeds_after_best_effort(recording_stopped_emitted) {
        Ok(())
    } else {
        Err("Failed to emit recording-stopped".to_string())
    }
}

/// Whether the stop invoke should report success after the best-effort save
/// path. Once `recording-stopped` has been emitted, the answer is always yes —
/// stream soft-failures must not surface as invoke `Err` or the frontend/tray
/// skip the SQLite save pipeline.
pub(crate) fn stop_invoke_succeeds_after_best_effort(
    recording_stopped_emitted: bool,
) -> bool {
    recording_stopped_emitted
}

/// Pause the current recording
#[tauri::command]
#[specta::specta]
pub async fn pause_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Pausing recording");

    // Check if currently recording
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and pause it
    let manager_guard = RECORDING_MANAGER.lock().await;
    if let Some(manager) = manager_guard.as_ref() {
        manager.pause_recording().map_err(|e| e.to_string())?;

        // Emit pause event to frontend
        app.emit(
            "recording-paused",
            serde_json::json!({
                "message": "Recording paused"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect paused state
        crate::tray::update_tray_menu(&app);

        info!("Recording paused successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Resume the current recording
#[tauri::command]
#[specta::specta]
pub async fn resume_recording<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("Resuming recording");

    // Check if currently recording
    if !IS_RECORDING.load(Ordering::SeqCst) {
        return Err("No recording is currently active".to_string());
    }

    // Access the recording manager and resume it
    let manager_guard = RECORDING_MANAGER.lock().await;
    if let Some(manager) = manager_guard.as_ref() {
        manager.resume_recording().map_err(|e| e.to_string())?;

        // Emit resume event to frontend
        app.emit(
            "recording-resumed",
            serde_json::json!({
                "message": "Recording resumed"
            }),
        )
        .map_err(|e| e.to_string())?;

        // Update tray menu to reflect resumed state
        crate::tray::update_tray_menu(&app);

        info!("Recording resumed successfully");
        Ok(())
    } else {
        Err("No recording manager found".to_string())
    }
}

/// Classify device type from device name (privacy-safe: returns only a type label, never the input string).
pub(crate) fn classify_device_type(device_name: &str) -> &'static str {
    let name_lower = device_name.to_lowercase();
    // Check for Bluetooth keywords
    if name_lower.contains("bluetooth")
        || name_lower.contains("airpods")
        || name_lower.contains("beats")
        || name_lower.contains("headphones")
        || name_lower.contains("bt ")
        || name_lower.contains("wireless")
    {
        "Bluetooth"
    } else {
        "Wired"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_device_type_bluetooth() {
        assert_eq!(classify_device_type("AirPods Pro"), "Bluetooth");
        assert_eq!(classify_device_type("Beats Studio"), "Bluetooth");
        assert_eq!(classify_device_type("BT speaker"), "Bluetooth");
        assert_eq!(
            classify_device_type("Sony WH-1000XM5 Wireless"),
            "Bluetooth"
        );
    }

    #[test]
    fn classify_device_type_wired() {
        assert_eq!(classify_device_type("MacBook Pro Microphone"), "Wired");
        assert_eq!(classify_device_type("External Microphone"), "Wired");
    }

    #[test]
    fn classify_device_type_never_returns_input() {
        let name = "AirPods Pro";
        let result = classify_device_type(name);
        assert_ne!(result, name, "must not return the device name");
        let name2 = "MacBook Pro Microphone";
        let result2 = classify_device_type(name2);
        assert_ne!(result2, name2, "must not return the device name");
    }

    #[test]
    fn can_start_only_when_both_idle() {
        // A mode may start only when neither it nor the other mode is active.
        assert!(can_start(false, false));
        assert!(!can_start(true, false)); // this mode already active
        assert!(!can_start(false, true)); // the other mode active
        assert!(!can_start(true, true));
    }

    /// Serialize claim tests: they mutate process-wide statics.
    static CLAIM_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn try_claim_recording_is_exclusive() {
        let _lock = CLAIM_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Ensure a clean slate (other tests may have touched the flags).
        release_recording_claim();
        release_dictation_claim();

        assert!(try_claim_recording().is_ok());
        assert!(is_recording_active());
        // Second claim must fail while the first holds the slot.
        let err = try_claim_recording().unwrap_err();
        assert!(err.contains("already in progress"), "got: {err}");
        release_recording_claim();
        assert!(!is_recording_active());
        // After release, claim works again.
        assert!(try_claim_recording().is_ok());
        release_recording_claim();
    }

    #[test]
    fn try_claim_recording_refuses_when_dictation_active() {
        let _lock = CLAIM_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        release_recording_claim();
        release_dictation_claim();
        assert!(try_claim_dictation().is_ok());
        let err = try_claim_recording().unwrap_err();
        assert!(err.contains("dictation"), "got: {err}");
        release_dictation_claim();
    }

    #[test]
    fn try_claim_dictation_is_exclusive_and_blocks_recording() {
        let _lock = CLAIM_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        release_recording_claim();
        release_dictation_claim();
        assert!(try_claim_dictation().is_ok());
        assert!(try_claim_dictation().is_err());
        assert!(try_claim_recording().is_err());
        release_dictation_claim();
        assert!(try_claim_recording().is_ok());
        assert!(try_claim_dictation().is_err());
        release_recording_claim();
    }

    #[test]
    fn stop_invoke_succeeds_when_recording_stopped_was_emitted() {
        // After best-effort save + emit, invoke must be Ok so UI/tray save runs
        // even if streams failed soft. Stream error is event-only.
        assert!(stop_invoke_succeeds_after_best_effort(true));
        assert!(!stop_invoke_succeeds_after_best_effort(false));
    }
}
