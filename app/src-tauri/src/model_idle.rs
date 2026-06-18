//! Background watcher that unloads idle transcription models to free RAM
//! between meetings. Never unloads while a recording is active; the
//! recording-start path reloads the model before transcription resumes.

use std::time::Duration;

/// How long a model may sit unused before it is unloaded.
const MODEL_IDLE_TIMEOUT: Duration = Duration::from_secs(300); // 5 minutes
/// How often the watcher checks.
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Pure unload decision, so it can be unit-tested without engines.
pub fn should_unload(is_loaded: bool, is_recording: bool, idle: Duration, timeout: Duration) -> bool {
    is_loaded && !is_recording && idle >= timeout
}

/// Spawn the watcher. Safe to call once at startup; loops for the app lifetime.
pub fn spawn_idle_unload_watcher() {
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(CHECK_INTERVAL).await;

            // Never unload mid-recording.
            if crate::audio::recording_commands::is_recording().await {
                continue;
            }

            // Whisper.
            let whisper = {
                let guard = crate::whisper_engine::commands::WHISPER_ENGINE.lock().unwrap();
                guard.as_ref().cloned()
            };
            if let Some(engine) = whisper {
                let loaded = engine.is_model_loaded().await;
                let idle = engine.idle_for().await;
                if should_unload(loaded, false, idle, MODEL_IDLE_TIMEOUT) {
                    log::info!("Idle for {:?}, unloading Whisper model to free memory", idle);
                    engine.unload_model().await;
                }
            }

            // Parakeet.
            let parakeet = {
                let guard = crate::parakeet_engine::commands::PARAKEET_ENGINE.lock().unwrap();
                guard.as_ref().cloned()
            };
            if let Some(engine) = parakeet {
                let loaded = engine.is_model_loaded().await;
                let idle = engine.idle_for().await;
                if should_unload(loaded, false, idle, MODEL_IDLE_TIMEOUT) {
                    log::info!("Idle for {:?}, unloading Parakeet model to free memory", idle);
                    engine.unload_model().await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unloads_only_when_loaded_idle_and_not_recording() {
        let t = Duration::from_secs(300);
        assert!(should_unload(true, false, Duration::from_secs(301), t));
        assert!(!should_unload(false, false, Duration::from_secs(999), t)); // not loaded
        assert!(!should_unload(true, true, Duration::from_secs(999), t));   // recording
        assert!(!should_unload(true, false, Duration::from_secs(120), t));  // still recent
    }
}
