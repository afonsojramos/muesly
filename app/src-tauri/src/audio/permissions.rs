// macOS audio permissions handling
use anyhow::Result;
use log::{error, info, warn};

#[cfg(target_os = "macos")]
use std::process::Command;

/// Status of the macOS "System Audio Recording" permission
/// (kTCCServiceAudioCapture, macOS 14.4+), required by Core Audio process taps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemAudioPermission {
    Granted,
    Denied,
    Undetermined,
    /// The TCC preflight SPI could not be loaded; status cannot be determined.
    Unknown,
}

/// Query the System Audio Recording permission via the TCC preflight SPI.
///
/// There is NO public API to query this permission (unlike screen recording's
/// CGPreflightScreenCaptureAccess), and a Core Audio tap without it silently
/// delivers all-zero buffers instead of erroring. Like insidegui/AudioCap we
/// call the TCC framework's read-only preflight. muesly is not App Store
/// distributed, so private SPI use is acceptable; any loading failure fails
/// open as `Unknown`.
#[cfg(target_os = "macos")]
pub fn system_audio_permission_status() -> SystemAudioPermission {
    use std::ffi::CString;
    use std::os::raw::{c_int, c_void};

    type PreflightFn = unsafe extern "C" fn(*const c_void, *const c_void) -> c_int;

    // SAFETY: TCCAccessPreflight has the C ABI `int (CFStringRef, CFDictionaryRef)`;
    // the transmute target matches it. cidre's `cf::String` is repr(transparent)
    // over the CF object pointer, so `&cf::String` is bit-identical to a
    // CFStringRef, and the named `service` binding keeps the +1 retain alive
    // across the call. The fn pointer is never used after dlclose.
    unsafe {
        let path = match CString::new("/System/Library/PrivateFrameworks/TCC.framework/TCC") {
            Ok(p) => p,
            Err(_) => return SystemAudioPermission::Unknown,
        };
        let handle = libc::dlopen(path.as_ptr(), libc::RTLD_NOW);
        if handle.is_null() {
            return SystemAudioPermission::Unknown;
        }

        let symbol = match CString::new("TCCAccessPreflight") {
            Ok(s) => s,
            Err(_) => {
                libc::dlclose(handle);
                return SystemAudioPermission::Unknown;
            }
        };
        let func = libc::dlsym(handle, symbol.as_ptr());
        if func.is_null() {
            libc::dlclose(handle);
            return SystemAudioPermission::Unknown;
        }

        let preflight: PreflightFn = std::mem::transmute(func);
        let service = cidre::cf::String::from_str("kTCCServiceAudioCapture");
        let result = preflight(
            service.as_ref() as *const cidre::cf::String as *const c_void,
            std::ptr::null(),
        );
        libc::dlclose(handle);

        // 0 = granted, 1 = denied, anything else = not determined.
        match result {
            0 => SystemAudioPermission::Granted,
            1 => SystemAudioPermission::Denied,
            _ => SystemAudioPermission::Undetermined,
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn system_audio_permission_status() -> SystemAudioPermission {
    SystemAudioPermission::Granted // Not required on other platforms
}

/// Check if the app has System Audio Recording permission (required for Core
/// Audio taps on macOS 14.4+).
///
/// Note: Core Audio taps require NSAudioCaptureUsageDescription in Info.plist.
/// When a properly bundled app first reads a Core Audio tap, macOS shows the
/// consent prompt automatically. If permission is denied, the tap returns
/// silence (all zeros) with no error, so an explicit preflight is the only
/// reliable check.
#[cfg(target_os = "macos")]
pub fn check_screen_recording_permission() -> bool {
    match system_audio_permission_status() {
        SystemAudioPermission::Denied => {
            warn!("❌ System Audio Recording permission is DENIED - taps will record silence");
            info!(
                "📍 Enable it in System Settings → Privacy & Security → Screen & System Audio Recording"
            );
            false
        }
        status => {
            info!("ℹ️  System Audio Recording permission status: {:?}", status);
            // Granted, or cannot be determined: the bundled-app consent prompt
            // appears automatically on first tap use, so don't block.
            true
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn check_screen_recording_permission() -> bool {
    true // Not required on other platforms
}

/// Request Audio Capture permission from the user
/// This will open System Settings to the Privacy & Security page
#[cfg(target_os = "macos")]
pub fn request_screen_recording_permission() -> Result<()> {
    info!("🔐 Opening System Settings for Audio Capture permission...");

    // "System Audio Recording Only" lives inside the Screen & System Audio
    // Recording pane; Privacy_ScreenCapture is its (unchanged) anchor.
    let result = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();

    match result {
        Ok(_) => {
            info!("✅ Opened System Settings - navigate to Privacy & Security → Audio Capture");
            info!("👉 Please enable Audio Capture permission and restart the app");
            Ok(())
        }
        Err(e) => {
            error!("❌ Failed to open System Settings: {}", e);
            Err(anyhow::anyhow!("Failed to open System Settings: {}", e))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_recording_permission() -> Result<()> {
    Ok(()) // Not required on other platforms
}

/// Check and request Audio Capture permission if not granted
/// Returns true if permission is granted, false otherwise
pub fn ensure_screen_recording_permission() -> bool {
    if check_screen_recording_permission() {
        return true;
    }

    warn!("Audio Capture permission not granted - requesting...");

    if let Err(e) = request_screen_recording_permission() {
        error!("Failed to request Audio Capture permission: {}", e);
        return false;
    }

    false // Permission will be granted after restart
}

/// Tauri command to check Screen Recording permission
#[tauri::command]
#[specta::specta]
pub async fn check_screen_recording_permission_command() -> bool {
    check_screen_recording_permission()
}

/// Tauri command to request Screen Recording permission
#[tauri::command]
#[specta::specta]
pub async fn request_screen_recording_permission_command() -> Result<(), String> {
    request_screen_recording_permission().map_err(|e| e.to_string())
}

/// Trigger system audio permission request and verify it was granted.
/// Returns Ok(true) if permission is granted, Ok(false) if denied.
///
/// Strategy: preflight first (tap creation succeeds even when denied, so it
/// proves nothing by itself). If undetermined, create a tap, which makes a
/// properly bundled app fire the system consent prompt, then poll the
/// preflight while the user answers the dialog.
#[cfg(target_os = "macos")]
pub fn trigger_system_audio_permission() -> Result<bool> {
    info!("🔐 Checking System Audio Recording permission...");

    match system_audio_permission_status() {
        SystemAudioPermission::Granted => {
            info!("✅ System Audio Recording permission already granted");
            return Ok(true);
        }
        SystemAudioPermission::Denied => {
            info!("❌ System Audio Recording permission denied");
            info!(
                "👉 Enable it in System Settings → Privacy & Security → Screen & System Audio Recording"
            );
            return Ok(false);
        }
        SystemAudioPermission::Undetermined | SystemAudioPermission::Unknown => {}
    }

    info!("🔐 Triggering the consent prompt via tap creation...");
    let tap_created = match crate::audio::capture::CoreAudioCapture::new() {
        Ok(_capture) => true,
        Err(e) => {
            warn!("⚠️ Failed to create Core Audio tap: {}", e);
            false
        }
    };

    // Poll while the user answers the consent dialog (it is asynchronous).
    const POLL_INTERVAL_MS: u64 = 500;
    const MAX_WAIT_MS: u64 = 10_000;
    let mut waited = 0;
    loop {
        match system_audio_permission_status() {
            SystemAudioPermission::Granted => {
                info!("✅ System Audio Recording permission granted");
                return Ok(true);
            }
            SystemAudioPermission::Denied => {
                info!("❌ System Audio Recording permission denied by user");
                return Ok(false);
            }
            SystemAudioPermission::Undetermined => {
                if waited >= MAX_WAIT_MS {
                    info!(
                        "⏳ Permission still undetermined after {}s (dialog unanswered?)",
                        MAX_WAIT_MS / 1000
                    );
                    return Ok(false);
                }
            }
            SystemAudioPermission::Unknown => {
                // Deliberate fail-open: with the preflight SPI unavailable we
                // cannot distinguish granted from denied, and blocking onboarding
                // on an unverifiable permission would be worse. The recording-start
                // warning path makes the same trade-off.
                warn!("⚠️ TCC preflight unavailable; assuming permission based on tap creation");
                return Ok(tap_created);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
        waited += POLL_INTERVAL_MS;
    }
}

#[cfg(not(target_os = "macos"))]
pub fn trigger_system_audio_permission() -> Result<bool> {
    // System audio permissions not required on other platforms
    info!("System audio permissions not required on this platform");
    Ok(true)
}

/// Tauri command to trigger system audio permission request
/// Returns true if permission was granted (stream created), false if denied
#[tauri::command]
#[specta::specta]
pub async fn trigger_system_audio_permission_command() -> Result<bool, String> {
    // Run in blocking task to avoid blocking the async runtime
    tokio::task::spawn_blocking(|| trigger_system_audio_permission())
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| e.to_string())
}

/// Tauri command: query the System Audio Recording permission status without
/// triggering any prompt. Returns "granted" | "denied" | "undetermined" | "unknown".
#[tauri::command]
#[specta::specta]
pub async fn check_system_audio_permission_command() -> String {
    let status = tokio::task::spawn_blocking(system_audio_permission_status)
        .await
        .unwrap_or(SystemAudioPermission::Unknown);
    match status {
        SystemAudioPermission::Granted => "granted",
        SystemAudioPermission::Denied => "denied",
        SystemAudioPermission::Undetermined => "undetermined",
        SystemAudioPermission::Unknown => "unknown",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_permission() {
        let has_permission = check_screen_recording_permission();
        println!("Has Screen Recording permission: {}", has_permission);
    }

    /// Prints the live TCC preflight result for this process.
    /// Run with: cargo test tcc_preflight -- --nocapture
    #[test]
    fn tcc_preflight_status() {
        let status = system_audio_permission_status();
        println!("System Audio Recording permission status: {:?}", status);
    }
}
