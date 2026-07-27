//! System notifications for recording lifecycle events.
//!
//! One user-facing switch (Preferences → System notifications) gates a
//! banner on recording start/stop; every other flow already confirms state
//! on screen (recording UI, tray, in-app toasts) and stays banner-free.

use serde_json::json;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "preferences.json";
const ENABLED_KEY: &str = "system_notifications_enabled";

/// Whether the user enabled system notifications. Seeds once from the legacy
/// notifications.json so a pre-collapse opt-in carries over.
fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Ok(store) = app.store(STORE_FILE) else {
        return false;
    };
    if let Some(value) = store.get(ENABLED_KEY).and_then(|v| v.as_bool()) {
        return value;
    }
    let seeded = legacy_enabled();
    store.set(ENABLED_KEY, json!(seeded));
    if let Err(e) = store.save() {
        log::warn!("failed to persist seeded notification setting: {e}");
    }
    seeded
}

fn legacy_enabled() -> bool {
    let Some(path) = dirs::config_dir().map(|dir| dir.join("muesly/notifications.json")) else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|settings| {
            settings
                .pointer("/notification_preferences/show_recording_started")?
                .as_bool()
        })
        .unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
pub fn get_system_notifications_enabled(app: AppHandle<tauri::Wry>) -> bool {
    enabled(&app)
}

#[tauri::command]
#[specta::specta]
pub fn set_system_notifications_enabled(
    app: AppHandle<tauri::Wry>,
    enabled: bool,
) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(ENABLED_KEY, json!(enabled));
    store.save().map_err(|e| e.to_string())
}

/// The OS-reported permission, requesting it on first use. The desktop plugin
/// currently always grants; mobile and future desktop versions report truth.
fn permission_granted<R: Runtime>(app: &AppHandle<R>) -> bool {
    let notification = app.notification();
    match notification.permission_state() {
        Ok(PermissionState::Granted) => true,
        Ok(_) => matches!(
            notification.request_permission(),
            Ok(PermissionState::Granted)
        ),
        Err(e) => {
            log::warn!("notification permission unavailable: {e}");
            false
        }
    }
}

fn show<R: Runtime>(app: &AppHandle<R>, body: &str) {
    if !enabled(app) || !permission_granted(app) {
        return;
    }
    if let Err(e) = app
        .notification()
        .builder()
        .title("muesly")
        .body(body)
        .show()
    {
        log::warn!("failed to show notification: {e}");
    }
}

pub fn notify_recording_started<R: Runtime>(app: &AppHandle<R>, meeting_name: Option<&str>) {
    let body = match meeting_name {
        Some(name) => format!("Recording started for “{name}”"),
        None => "Recording started".to_string(),
    };
    show(app, &body);
}

pub fn notify_recording_stopped<R: Runtime>(app: &AppHandle<R>) {
    show(app, "Recording stopped and saved");
}
