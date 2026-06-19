//! Foreground-app watcher: detects when a known meeting app becomes frontmost.
//!
//! Runs only while auto-detect is enabled. On macOS it polls the frontmost
//! application about once a second and emits `meeting-app-detected` once per
//! activation (debounced against the previous frontmost app). On other platforms
//! there is no foreground-app API, so [`start`]/[`stop`] are no-ops.

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Runtime};

/// Whether the watcher loop should keep running.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Payload emitted when a known meeting app comes to the foreground.
#[derive(Clone, serde::Serialize)]
struct MeetingAppDetected {
    app_name: String,
    bundle_id: String,
}

/// Start the foreground-app watcher (idempotent). Emits `meeting-app-detected`
/// when a known meeting app becomes frontmost, debounced to once per activation.
/// A no-op on platforms without a foreground-app API.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = std::thread::Builder::new()
            .name("meeting-detect".into())
            .spawn(move || watch_loop(app))
        {
            log::error!("failed to start meeting-detect watcher: {e}");
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app; // no foreground-app API on this platform
    }
}

/// Stop the watcher loop.
pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
}

/// Whether the watcher is currently running.
pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

#[cfg(target_os = "macos")]
fn watch_loop<R: Runtime>(app: AppHandle<R>) {
    use crate::meeting_detect::known::{match_meeting_app, DEFAULT_MEETING_APPS};

    let mut last_bundle_id: Option<String> = None;
    while RUNNING.load(Ordering::SeqCst) {
        // NSWorkspace is AppKit and must be touched on the main thread; reading
        // it from this background thread trips macOS's main-thread checker and
        // aborts the app. Marshal the read to the main thread and wait for it.
        let frontmost = read_frontmost_on_main(&app);
        if let Some(bundle_id) = frontmost {
            let changed = last_bundle_id.as_deref() != Some(bundle_id.as_str());
            if changed {
                if let Some(name) = match_meeting_app(&bundle_id, DEFAULT_MEETING_APPS) {
                    let _ = app.emit(
                        "meeting-app-detected",
                        MeetingAppDetected {
                            app_name: name.to_string(),
                            bundle_id: bundle_id.clone(),
                        },
                    );
                }
                last_bundle_id = Some(bundle_id);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1000));
    }
}

/// Read the frontmost app's bundle id on the main thread. AppKit/NSWorkspace is
/// not safe to access from a background thread, so the read is dispatched to the
/// main thread and the result is marshaled back over a channel.
#[cfg(target_os = "macos")]
fn read_frontmost_on_main<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<String>>(1);
    if app
        .run_on_main_thread(move || {
            // Autorelease pool so the temporary Objective-C objects are freed.
            let _ = tx.send(cidre::objc::ar_pool(frontmost_bundle_id));
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .ok()
        .flatten()
}

/// Bundle identifier of the current frontmost application, if any.
#[cfg(target_os = "macos")]
fn frontmost_bundle_id() -> Option<String> {
    use cidre::ns;

    let workspace = ns::Workspace::shared();
    for app in workspace.running_apps().iter() {
        if app.is_active() {
            return app.bundle_id().map(|id| id.to_string());
        }
    }
    None
}
