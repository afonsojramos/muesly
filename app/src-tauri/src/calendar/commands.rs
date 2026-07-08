//! Tauri commands for the calendar feature. All boundary errors are `String`.
//! Any user action is exposed here (agent-reachable), not UI-only.

use crate::calendar::{eventkit, google, permissions, service, CalendarAuthStatus, CalendarInfo};
use crate::database::models::{CalendarAccount, CalendarEvent};
use crate::database::repositories::calendar::CalendarEventsRepository;
use crate::database::repositories::calendar_accounts::CalendarAccountsRepository;
use crate::database::repositories::calendar_event_rules::CalendarEventRulesRepository;
use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use chrono::{DateTime, Utc};
use std::collections::HashSet;
use tauri::Emitter;

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
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_calendar_context_enabled(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())?;
    spawn_upcoming_refresh(state.db_manager.pool(), &app);
    Ok(())
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
    app: tauri::AppHandle,
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
    spawn_upcoming_refresh(pool, &app);
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
    app: tauri::AppHandle,
) -> Result<CalendarAccount, String> {
    let pool = state.db_manager.pool();
    let (sub, email) = google::connect_account().await.map_err(|e| e.to_string())?;
    // Cache the calendar list once on connect so the settings page has an initial
    // list without a live call; later refreshes are a manual action.
    let calendars_json = fetch_google_calendars(&sub)
        .await
        .ok()
        .and_then(|c| serde_json::to_string(&c).ok());
    let account = CalendarAccount {
        id: sub,
        source: "google".to_string(),
        email,
        enabled: true,
        excluded_calendar_ids: Some("[]".to_string()),
        status: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        calendars_json,
    };
    CalendarAccountsRepository::upsert(pool, &account)
        .await
        .map_err(|e| e.to_string())?;
    spawn_upcoming_refresh(pool, &app);
    Ok(account)
}

/// Remove a Google account: revoke + clear its keychain token, then delete the
/// row. Snapshots captured from it are kept (historical). The local source can't
/// be removed (toggle it off instead).
#[tauri::command]
#[specta::specta]
pub async fn calendar_remove_account(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
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
        .map_err(|e| e.to_string())?;
    spawn_upcoming_refresh(pool, &app);
    Ok(())
}

/// Enable or disable a single source.
#[tauri::command]
#[specta::specta]
pub async fn calendar_set_account_enabled(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
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
    spawn_upcoming_refresh(pool, &app);
    Ok(())
}

/// Fetch a Google account's calendars from the API and map them to `CalendarInfo`.
async fn fetch_google_calendars(account_id: &str) -> Result<Vec<CalendarInfo>, String> {
    let cals = google::list_calendars(account_id)
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

/// One account's calendars for the per-account selection UI. Served from the list
/// cached on the account (no network) so opening settings is instant; refreshing
/// from Google is an explicit action (`calendar_refresh_account_calendars`). The
/// local EventKit source is always read live since it is an on-device call.
#[tauri::command]
#[specta::specta]
pub async fn calendar_list_account_calendars(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<CalendarInfo>, String> {
    if account_id == "eventkit-local" {
        return tokio::task::spawn_blocking(|| eventkit::list_calendars(&HashSet::new()))
            .await
            .map_err(|e| e.to_string());
    }
    let account = CalendarAccountsRepository::get(state.db_manager.pool(), &account_id)
        .await
        .map_err(|e| e.to_string())?;
    match account.and_then(|a| a.calendars_json) {
        Some(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

/// Pull a fresh calendar list from Google and cache it on the account. This is the
/// only path that hits the network for calendars, triggered by the manual refresh.
#[tauri::command]
#[specta::specta]
pub async fn calendar_refresh_account_calendars(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<CalendarInfo>, String> {
    if account_id == "eventkit-local" {
        return tokio::task::spawn_blocking(|| eventkit::list_calendars(&HashSet::new()))
            .await
            .map_err(|e| e.to_string());
    }
    let pool = state.db_manager.pool();
    let calendars = fetch_google_calendars(&account_id).await?;
    if let Some(mut account) = CalendarAccountsRepository::get(pool, &account_id)
        .await
        .map_err(|e| e.to_string())?
    {
        account.calendars_json =
            Some(serde_json::to_string(&calendars).map_err(|e| e.to_string())?);
        CalendarAccountsRepository::upsert(pool, &account)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(calendars)
}

/// Set the excluded calendar ids for one account.
#[tauri::command]
#[specta::specta]
pub async fn calendar_set_account_excluded_ids(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
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
    spawn_upcoming_refresh(pool, &app);
    Ok(())
}

/// Preview upcoming events across all enabled sources (settings verification).
#[tauri::command]
#[specta::specta]
pub async fn calendar_preview_upcoming(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<service::PreviewEvent>, String> {
    let pool = state.db_manager.pool();
    let cached: Option<CachedUpcoming> = SettingsRepository::get_calendar_upcoming_cache(pool)
        .await
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str(&json).ok());

    let (events, stale) = match &cached {
        Some(c) => (
            c.events.clone(),
            (Utc::now() - c.fetched_at).num_seconds() > UPCOMING_CACHE_TTL_SECS,
        ),
        None => (Vec::new(), true),
    };

    // Refresh in the background when missing/stale so the caller returns instantly;
    // the frontend re-fetches on the `upcoming-events-updated` event.
    if stale {
        let pool = pool.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            refresh_upcoming_cache(pool, app).await;
        });
    }

    Ok(events)
}

/// The persisted "Coming up" preview: the events plus when they were fetched.
#[derive(serde::Serialize, serde::Deserialize)]
struct CachedUpcoming {
    events: Vec<service::PreviewEvent>,
    fetched_at: DateTime<Utc>,
}

/// Serve the cache without refetching for this long (5 minutes).
const UPCOMING_CACHE_TTL_SECS: i64 = 300;

/// Fetch upcoming events, persist them with a timestamp, and notify the frontend.
async fn refresh_upcoming_cache(pool: sqlx::SqlitePool, app: tauri::AppHandle) {
    let cached = CachedUpcoming {
        events: service::preview_upcoming(&pool, Utc::now()).await,
        fetched_at: Utc::now(),
    };
    if let Ok(json) = serde_json::to_string(&cached) {
        let _ = SettingsRepository::set_calendar_upcoming_cache(&pool, &json).await;
    }
    let _ = app.emit("upcoming-events-updated", ());
}

/// Force-refresh the upcoming-events cache in the background after a calendar
/// change that alters which events appear (toggles, exclusions, account add/
/// remove), so removed/excluded calendars stop showing without waiting for the
/// TTL. Fires `upcoming-events-updated` when done for any mounted home view.
fn spawn_upcoming_refresh(pool: &sqlx::SqlitePool, app: &tauri::AppHandle) {
    let pool = pool.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh_upcoming_cache(pool, app).await;
    });
}

/// One-click, secret-free diagnostic for a calendar source (where it fails).
#[tauri::command]
#[specta::specta]
pub async fn calendar_diagnose(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<String, String> {
    let pool = state.db_manager.pool();
    let account = CalendarAccountsRepository::get(pool, &account_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "account not found".to_string())?;
    if account.source == "eventkit" {
        return Ok(format!(
            "local source; permission: {:?}",
            eventkit::authorization_status()
        ));
    }
    Ok(google::diagnose(&account).await)
}

/// Pre-assign a calendar event (or, when `auto_add_series`, its whole recurring
/// series) to a folder, ahead of any recording. Applied at record time by
/// [`crate::database::repositories::calendar_event_rules`].
#[tauri::command]
#[specta::specta]
pub async fn calendar_set_event_folder(
    state: tauri::State<'_, AppState>,
    ical_uid: String,
    event_identifier: Option<String>,
    occurrence_minute: i64,
    folder_id: String,
    auto_add_series: bool,
) -> Result<(), String> {
    let uid = crate::calendar::dedup::norm_uid(&ical_uid);
    CalendarEventRulesRepository::upsert_rule(
        state.db_manager.pool(),
        &uid,
        event_identifier.as_deref(),
        occurrence_minute,
        &folder_id,
        auto_add_series,
    )
    .await
    .map_err(|e| e.to_string())
}

/// The folder currently pre-assigned to an occurrence (per-occurrence rule wins
/// over a series rule), or None. Hydrates the "Add to folder" picker.
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_event_folder(
    state: tauri::State<'_, AppState>,
    ical_uid: String,
    occurrence_minute: i64,
) -> Result<Option<String>, String> {
    let uid = crate::calendar::dedup::norm_uid(&ical_uid);
    CalendarEventRulesRepository::folder_for(state.db_manager.pool(), &uid, occurrence_minute)
        .await
        .map_err(|e| e.to_string())
}

/// Remove the per-occurrence folder pre-assignment (unassign / "My notes"). A
/// series rule for the same event is left intact.
#[tauri::command]
#[specta::specta]
pub async fn calendar_clear_event_folder(
    state: tauri::State<'_, AppState>,
    ical_uid: String,
    occurrence_minute: i64,
) -> Result<(), String> {
    let uid = crate::calendar::dedup::norm_uid(&ical_uid);
    CalendarEventRulesRepository::clear_rule(state.db_manager.pool(), &uid, occurrence_minute)
        .await
        .map_err(|e| e.to_string())
}

/// Apply a pre-assigned folder to a just-saved recording using the exact event the
/// user recorded (pinned by the home "Start" button), rather than re-matching. Works
/// even when calendar context is disabled. Best-effort; never errors on a missing rule.
#[tauri::command]
#[specta::specta]
pub async fn calendar_apply_folder_rule(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    ical_uid: String,
    occurrence_minute: i64,
) -> Result<(), String> {
    service::apply_folder_rule(state.db_manager.pool(), &meeting_id, &ical_uid, occurrence_minute)
        .await;
    Ok(())
}

/// Whether to auto-start recording when a calendar meeting begins.
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_auto_start_on_event(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_auto_start_on_event(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_set_auto_start_on_event(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_auto_start_on_event(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())
}

/// Whether to also open the meeting's conference link on auto-start.
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_auto_join_meeting(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_auto_join_meeting(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn calendar_set_auto_join_meeting(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_auto_join_meeting(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| e.to_string())
}
