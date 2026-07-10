pub fn format_timestamp(seconds: f64) -> String {
    let total_seconds = seconds as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let secs = total_seconds % 60;
    format!("{:02}:{:02}:{:02}", hours, minutes, secs)
}

/// Returns `Ok(url)` when `raw` is a safe external http(s) URL the app may open
/// via the OS. Rejects empty/placeholder values, non-http schemes, and malformed
/// URLs. Pure so unit tests cover the allow/deny matrix without spawning a browser.
pub fn validate_external_http_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    // Common placeholders that must never reach the OS opener.
    let lower = trimmed.to_ascii_lowercase();
    if lower == "tbd" || lower == "todo" || lower == "n/a" || lower == "null" {
        return Err("URL is not configured".to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host_str().is_none() {
                return Err("URL must include a host".to_string());
            }
            Ok(trimmed.to_string())
        }
        other => Err(format!(
            "Only http and https URLs are allowed (got scheme '{other}')"
        )),
    }
}

/// Whether `path` is strictly under one of `roots` (or equal to a root). Pure
/// string-path check for unit tests of permanent-delete path gating; production
/// delete uses `validate_path_within_roots` which also resolves symlinks.
pub fn path_is_under_any_root(path: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn external_url_allows_https_and_http() {
        assert!(validate_external_http_url("https://example.com/path").is_ok());
        assert!(validate_external_http_url("http://localhost:11434").is_ok());
        assert!(validate_external_http_url("  https://ollama.com/download  ").is_ok());
    }

    #[test]
    fn external_url_rejects_schemes_placeholders_and_empty() {
        assert!(validate_external_http_url("").is_err());
        assert!(validate_external_http_url("TBD").is_err());
        assert!(validate_external_http_url("tbd").is_err());
        assert!(validate_external_http_url("file:///etc/passwd").is_err());
        assert!(validate_external_http_url("javascript:alert(1)").is_err());
        assert!(validate_external_http_url("x-apple.systempreferences:foo").is_err());
        assert!(validate_external_http_url("not a url").is_err());
    }

    #[test]
    fn path_under_root_accepts_in_root_rejects_outside() {
        let root = PathBuf::from("/Users/me/Movies/muesly-recordings");
        let roots = vec![root.clone()];
        assert!(path_is_under_any_root(
            &root.join("Meeting 2026"),
            &roots
        ));
        assert!(path_is_under_any_root(&root, &roots));
        assert!(!path_is_under_any_root(
            std::path::Path::new("/tmp/evil"),
            &roots
        ));
        assert!(!path_is_under_any_root(
            std::path::Path::new("/Users/me/Movies/other"),
            &roots
        ));
    }
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