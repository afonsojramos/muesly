pub fn format_timestamp(seconds: f64) -> String {
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let secs = total_seconds % 60;
    format!("{:02}:{:02}:{:02}", hours, minutes, secs)
}

/// Non-macOS stub so the command is part of the type-safe command set on every
/// platform (the bindings generator and the runtime handler reference it
/// unconditionally). Opening System Settings is only meaningful on macOS.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
#[specta::specta]
pub async fn open_system_settings(_preference_pane: String) -> Result<(), String> {
    Err("Opening system settings is only supported on macOS".to_string())
}

/// Opens macOS System Settings to a specific privacy preference pane
#[cfg(target_os = "macos")]
#[tauri::command]
#[specta::specta]
pub async fn open_system_settings(preference_pane: String) -> Result<(), String> {
    use std::process::Command;

    // Construct the URL for System Settings
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{}", preference_pane);

    // Use the 'open' command on macOS to open the URL
    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open system settings: {}", e))?;

    Ok(())
} 