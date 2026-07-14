//! Calendar permission status, request, and the System Settings deep-link.
//! Thin wrappers over [`crate::calendar::eventkit`] plus the OS settings pane.

use crate::calendar::{CalendarAuthStatus, eventkit};
use tauri::{AppHandle, Runtime};

/// Current read-access status. Cheap, synchronous, thread-agnostic.
pub fn status() -> CalendarAuthStatus {
    eventkit::authorization_status()
}

/// Prompt for full calendar access and return the resulting status. Blocks the
/// calling (background) thread until the user responds; never blocks main.
pub fn request<R: Runtime>(app: &AppHandle<R>) -> CalendarAuthStatus {
    eventkit::request_access(app)
}

/// Open the macOS Calendars privacy pane so the user can grant access manually
/// (used when status is `Denied`).
#[cfg(target_os = "macos")]
pub fn open_system_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn open_system_settings() -> Result<(), String> {
    Ok(())
}
