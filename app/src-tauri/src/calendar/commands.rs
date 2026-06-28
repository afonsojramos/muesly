//! Tauri commands for the calendar feature. All boundary errors are `String`.
//! Any user action is exposed here (agent-reachable), not UI-only.

use crate::calendar::{eventkit, google, permissions, service, CalendarAuthStatus, CalendarInfo};
use crate::database::models::{CalendarAccount, CalendarEvent};
use crate::database::repositories::calendar::CalendarEventsRepository;
use crate::database::repositories::calendar_accounts::CalendarAccountsRepository;
use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use chrono::{DateTime, Utc};
use std::collections::HashSet;

#[tauri::command]
#[specta::specta]
pub fn calendar_permission_status() -> CalendarAuthStatus {
    permissions::status()
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_request_access(app: tauri::AppHandle) -> Result<CalendarAuthStatus, String> {
    // The request blocks the calling thread up to 60s awaiting the prompt, so
    // run it off the async runtime.
    tokio::task::spawn_blocking(move || permissions::request(&app))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn calendar_open_settings() -> Result<(), String> {
    permissions::open_system_settings()
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_list_calendars() -> Result<Vec<CalendarInfo>, String> {
    // EventKit read is synchronous and blocking; keep it off the async reactor.
    tokio::task::spawn_blocking(|| eventkit::list_calendars(&HashSet::new()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_get_context_enabled(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_calendar_context_enabled(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_set_context_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_calendar_context_enabled(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_get_excluded_ids(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    // Excluded ids are now per-account; the local source is "eventkit-local".
    let account = CalendarAccountsRepository::get(state.db_manager.pool(), "eventkit-local")
        .await
        .map_err(|e| e.to_string())?;
    Ok(account
        .and_then(|a| a.excluded_calendar_ids)
        .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_set_excluded_ids(
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    if let Some(mut account) = CalendarAccountsRepository::get(pool, "eventkit-local")
        .await
        .map_err(|e| e.to_string())?
    {
        account.excluded_calendar_ids = Some(json);
        CalendarAccountsRepository::upsert(pool, &account)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_get_send_attendee_names_to_cloud(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_calendar_send_attendee_names_to_cloud(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_set_send_attendee_names_to_cloud(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_calendar_send_attendee_names_to_cloud(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_get_send_notes_to_cloud(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_calendar_send_notes_to_cloud(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_set_send_notes_to_cloud(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_calendar_send_notes_to_cloud(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())
}

/// Read the calendar snapshot attached to a recording (for the detail view).
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_event(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<CalendarEvent>, String> {
    CalendarEventsRepository::get(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

/// Resolve and attach the calendar event for a recording. Called by the frontend
/// after a recording is saved (auto), and on manual re-attach. Resolves for the
/// meeting's start instant.
#[tauri::command]
#[specta::specta]
pub async fn calendar_attach_event(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<bool, String> {
    let pool = state.db_manager.pool();
    let created_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT created_at FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    let instant = created_at.unwrap_or_else(Utc::now);
    service::attach_event_for_meeting(pool, &meeting_id, instant).await
}

/// Detach the calendar snapshot from a recording.
#[tauri::command]
#[specta::specta]
pub async fn calendar_detach_event(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    CalendarEventsRepository::delete(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

/// Delete every stored calendar snapshot (offered when disabling the feature).
#[tauri::command]
#[specta::specta]
pub async fn calendar_purge_all_snapshots(
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    CalendarEventsRepository::purge_all(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

// ===== Multi-source accounts (local + Google) =====

/// Whether a Google OAuth client id is configured (drives the "Add account" UI).
#[tauri::command]
#[specta::specta]
pub fn calendar_google_configured() -> bool {
    google::is_configured()
}

/// All connected calendar sources (the local source + any Google accounts).
#[tauri::command]
#[specta::specta]
pub async fn calendar_list_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CalendarAccount>, String> {
    CalendarAccountsRepository::list(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

/// Run the Google OAuth flow (system browser + loopback) and persist the account.
#[tauri::command]
#[specta::specta]
pub async fn calendar_add_google_account(
    state: tauri::State<'_, AppState>,
) -> Result<CalendarAccount, String> {
    let pool = state.db_manager.pool();
    let (sub, email) = google::connect_account().await.map_err(|e| e.to_string())?;
    let account = CalendarAccount {
        id: sub,
        source: "google".to_string(),
        email,
        enabled: true,
        excluded_calendar_ids: Some("[]".to_string()),
        status: None,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    CalendarAccountsRepository::upsert(pool, &account)
        .await
        .map_err(|e| e.to_string())?;
    Ok(account)
}

/// Remove a Google account: revoke + clear its keychain token, then delete the
/// row. Snapshots captured from it are kept (historical). The local source can't
/// be removed (toggle it off instead).
#[tauri::command]
#[specta::specta]
pub async fn calendar_remove_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    if account_id == "eventkit-local" {
        return Ok(());
    }
    if let Some(account) = CalendarAccountsRepository::get(pool, &account_id)
        .await
        .map_err(|e| e.to_string())?
    {
        if account.source == "google" {
            google::disconnect_account(&account_id)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    CalendarAccountsRepository::delete(pool, &account_id)
        .await
        .map_err(|e| e.to_string())
}

/// Enable or disable a single source.
#[tauri::command]
#[specta::specta]
pub async fn calendar_set_account_enabled(
    state: tauri::State<'_, AppState>,
    account_id: String,
    enabled: bool,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    if let Some(mut account) = CalendarAccountsRepository::get(pool, &account_id)
        .await
        .map_err(|e| e.to_string())?
    {
        account.enabled = enabled;
        CalendarAccountsRepository::upsert(pool, &account)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// List one account's calendars (for the per-account selection UI).
#[tauri::command]
#[specta::specta]
pub async fn calendar_list_account_calendars(
    account_id: String,
) -> Result<Vec<CalendarInfo>, String> {
    if account_id == "eventkit-local" {
        return tokio::task::spawn_blocking(|| eventkit::list_calendars(&HashSet::new()))
            .await
            .map_err(|e| e.to_string());
    }
    let cals = google::list_calendars(&account_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(cals
        .into_iter()
        .map(|c| CalendarInfo {
            id: c.id,
            title: c.summary.unwrap_or_default(),
            excluded_by_default: false,
        })
        .collect())
}

/// Set the excluded calendar ids for one account.
#[tauri::command]
#[specta::specta]
pub async fn calendar_set_account_excluded_ids(
    state: tauri::State<'_, AppState>,
    account_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    if let Some(mut account) = CalendarAccountsRepository::get(pool, &account_id)
        .await
        .map_err(|e| e.to_string())?
    {
        account.excluded_calendar_ids = Some(json);
        CalendarAccountsRepository::upsert(pool, &account)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
