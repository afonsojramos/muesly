//! Floating "meeting started" prompt card (top-right, Granola-style).
//!
//! A statically-declared always-on-top window (label `meeting-prompt`) that
//! offers to record when a calendar meeting begins or a known meeting app comes
//! to the foreground. Recording NEVER starts automatically: it starts only when
//! the user clicks the card's button. The card floats over every app (including
//! fullscreen meeting apps on macOS), so the offer is visible where the meeting
//! actually happens — unlike an in-app toast, which is invisible while muesly
//! is in the background.
//!
//! The card's webview has only `core:event:default` capability, so the whole
//! surface is event-driven (mirroring the pill): Rust pushes state with
//! `meeting-prompt-updated`, and the card answers with
//! `meeting-prompt-accept-clicked` / `meeting-prompt-dismiss-clicked`.
//! Failures are logged and swallowed; nothing here may panic or block.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, Runtime};

const PROMPT_LABEL: &str = "meeting-prompt";
/// Mirrored from the `meeting-prompt` window declaration in `tauri.conf.json`.
const PROMPT_WIDTH: f64 = 356.0;
const PROMPT_HEIGHT: f64 = 128.0;
/// Gap between the card and the work area's top/right edges.
const EDGE_MARGIN: f64 = 16.0;
/// An ignored card dismisses itself; matches the scheduler's staleness window
/// so the offer never outlives the moment it describes.
const AUTO_DISMISS_SECS: u64 = 600;

/// A pending offer to record. Only `title`/`source`/`app_name` reach the
/// webview; scheduler bookkeeping stays in Rust.
#[derive(Clone, Debug)]
pub struct MeetingPrompt {
    /// Meeting title used for the recording (None = backend default).
    pub title: Option<String>,
    /// "calendar" or "app".
    pub source: &'static str,
    /// Detected meeting app name (app source only), for the card subtitle.
    pub app_name: Option<String>,
    /// Calendar fire claim, released if a clicked start fails transiently.
    pub ical_uid: Option<String>,
    pub occurrence_minute: Option<i64>,
    /// Conference link opened on accept when the user enabled auto-join.
    pub conference_url: Option<String>,
    pub auto_join: bool,
}

#[derive(Clone, serde::Serialize)]
struct PromptPayload {
    title: Option<String>,
    source: &'static str,
    app_name: Option<String>,
}

static PENDING: Mutex<Option<MeetingPrompt>> = Mutex::new(None);
/// Bumped on every show/hide so a stale auto-dismiss timer never hides a newer
/// prompt.
static GENERATION: AtomicU64 = AtomicU64::new(0);

fn set_pending(prompt: Option<MeetingPrompt>) -> u64 {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = PENDING.lock() {
        *guard = prompt;
    }
    generation
}

fn take_pending() -> Option<MeetingPrompt> {
    PENDING.lock().ok().and_then(|mut guard| guard.take())
}

fn restore_pending(prompt: MeetingPrompt) {
    if let Ok(mut guard) = PENDING.lock() {
        guard.get_or_insert(prompt);
    }
}

/// Offer to record. Replaces any prompt already showing (newest wins) and is a
/// no-op while a capture is live.
pub fn show<R: Runtime>(app: &AppHandle<R>, prompt: MeetingPrompt) {
    if crate::audio::recording_commands::is_recording_active()
        || crate::audio::recording_commands::is_dictation_active()
    {
        return;
    }
    let payload = PromptPayload {
        title: prompt.title.clone(),
        source: prompt.source,
        app_name: prompt.app_name.clone(),
    };
    let generation = set_pending(Some(prompt));

    let Some(window) = app.get_webview_window(PROMPT_LABEL) else {
        log::warn!("meeting-prompt window not found; skipping show");
        return;
    };
    let _ = window.set_always_on_top(true);
    position_top_right(&window);
    // Push state before showing so the card never paints a stale offer.
    let _ = window.emit_to(PROMPT_LABEL, "meeting-prompt-updated", payload);
    if let Err(e) = window.show() {
        log::warn!("meeting-prompt show failed: {e}");
        return;
    }
    #[cfg(target_os = "macos")]
    crate::pill_window::raise_above_fullscreen(&window);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(AUTO_DISMISS_SECS)).await;
        if GENERATION.load(Ordering::SeqCst) == generation {
            log::info!("meeting prompt auto-dismissed after {AUTO_DISMISS_SECS}s");
            hide(&app);
        }
    });
}

/// Hide the card and clear any pending offer.
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    set_pending(None);
    if let Some(window) = app.get_webview_window(PROMPT_LABEL) {
        if let Err(e) = window.hide() {
            log::warn!("meeting-prompt hide failed: {e}");
        }
    }
}

/// Wire up the card's click events. Called once from setup.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let accept_app = app.clone();
    app.listen("meeting-prompt-accept-clicked", move |_| {
        let app = accept_app.clone();
        tauri::async_runtime::spawn(async move { accept(app).await });
    });
    let dismiss_app = app.clone();
    app.listen("meeting-prompt-dismiss-clicked", move |_| {
        log::info!("meeting prompt dismissed by user");
        hide(&dismiss_app);
    });
}

/// The user clicked "Start recording": run the same start path as a manual
/// start, then the calendar extras (notification, folder pin, auto-join).
async fn accept<R: Runtime>(app: AppHandle<R>) {
    let Some(prompt) = take_pending() else {
        hide(&app);
        return;
    };
    log::info!(
        "meeting prompt accepted (source: {}, title: {:?})",
        prompt.source,
        prompt.title
    );

    match crate::audio::recording_commands::start_recording_with_meeting_name(
        app.clone(),
        prompt.title.clone(),
    )
    .await
    {
        Ok(()) => {
            hide(&app);
            let nstate =
                app.state::<crate::notifications::commands::NotificationManagerState<R>>();
            let _ = crate::notifications::commands::show_recording_started_notification(
                &app,
                &nstate,
                prompt.title.clone(),
            )
            .await;
            if let (Some(uid), Some(minute)) =
                (prompt.ical_uid.as_deref(), prompt.occurrence_minute)
            {
                // Pin the event so its pre-assigned folder is applied at save
                // time even when calendar context is off (frontend consumes it).
                let _ = app.emit(
                    "recording-folder-pin",
                    serde_json::json!({ "icalUid": uid, "occurrenceMinute": minute }),
                );
            }
            if prompt.auto_join {
                if let Some(url) = prompt.conference_url.as_deref() {
                    if crate::calendar::conference::is_allowed_conference_url(url)
                        && open::that_detached(url).is_err()
                    {
                        log::warn!("meeting prompt auto-join failed");
                    }
                }
            }
        }
        Err(e) => {
            // Transient failure (model loading, mic busy): keep the card up so
            // the user can retry, release the calendar claim so a later tick
            // can re-offer, and tell the card to reset its button.
            log::warn!("meeting prompt start failed: {e}");
            if let (Some(uid), Some(minute)) =
                (prompt.ical_uid.as_deref(), prompt.occurrence_minute)
            {
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    crate::calendar::scheduler::unclaim_fire(
                        state.db_manager.pool(),
                        &dedup_norm(uid),
                        minute,
                    )
                    .await;
                }
            }
            let _ = app.emit_to(
                PROMPT_LABEL,
                "meeting-prompt-error",
                serde_json::json!({ "message": e }),
            );
            restore_pending(prompt);
        }
    }
}

/// The scheduler stores normalized uids; normalize again defensively so the
/// unclaim always targets the row the claim wrote.
fn dedup_norm(uid: &str) -> String {
    crate::calendar::dedup::norm_uid(uid)
}

/// Anchor the card to the top-right of the work area of the monitor under the
/// cursor (falling back to the primary monitor), mirroring the pill's logic.
fn position_top_right<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let monitor =
        crate::pill_window::cursor_monitor(window).or_else(|| match window.primary_monitor() {
            Ok(monitor) => monitor,
            Err(e) => {
                log::warn!("meeting-prompt primary_monitor query failed: {e}");
                None
            }
        });
    let Some(monitor) = monitor else {
        log::warn!("meeting-prompt could not resolve a monitor; leaving default position");
        return;
    };

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin: LogicalPosition<f64> = area.position.to_logical(scale);
    let size: LogicalSize<f64> = area.size.to_logical(scale);

    let mut x = origin.x + size.width - PROMPT_WIDTH - EDGE_MARGIN;
    let mut y = origin.y + EDGE_MARGIN;

    let max_x = origin.x + (size.width - PROMPT_WIDTH).max(0.0);
    let max_y = origin.y + (size.height - PROMPT_HEIGHT).max(0.0);
    x = x.clamp(origin.x, max_x);
    y = y.clamp(origin.y, max_y);

    if let Err(e) = window.set_position(LogicalPosition::new(x, y)) {
        log::warn!("meeting-prompt set_position failed: {e}");
    }
}
