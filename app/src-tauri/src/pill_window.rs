//! Floating always-on-top recording pill window.
//!
//! A second, statically-declared Tauri window (label `pill`, declared in
//! `tauri.conf.json`) that floats above every other OS window while a recording
//! is active. Visibility is driven entirely from Rust: [`show`] is called when a
//! recording starts and [`hide`] when it stops or errors, so the pill can never
//! desync from the real recording state.
//!
//! All Tauri window methods here are synchronous, event-loop dispatched, and
//! return `Result<()>`; failures are logged and swallowed. This module must
//! never panic and never block, so it can be called from the recording
//! lifecycle without ever stalling or aborting a recording.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

/// The label of the pill window as declared in `tauri.conf.json`.
const PILL_LABEL: &str = "pill";

/// Global backstop to toggle pause/resume while recording. The pill is declared
/// `focus: false` and is therefore not keyboard-reachable, so this chord is
/// registered while the pill is shown and unregistered when it hides. The
/// matching dispatch lives in the global-shortcut handler in `lib.rs`.
///
/// Only pause/resume is exposed as a global chord: it is non-destructive. Stop is
/// deliberately left to the on-pill button and the (keyboard-reachable) tray, so
/// a recording can never be ended by a stray global hotkey, and so we avoid
/// OS-reserved chords like `Ctrl+Shift+Esc` (Windows Task Manager).
pub const TOGGLE_PAUSE_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";

/// The pill window's logical size, mirrored from the `tauri.conf.json` `pill`
/// window declaration (`width: 80`, `height: 220`). Used to compute its
/// bottom-center anchor; kept in sync with the config by hand (Tauri does not
/// expose the declared size before the window is shown).
const PILL_WIDTH: f64 = 72.0;
const PILL_HEIGHT: f64 = 184.0;

/// Gap in logical pixels between the pill's bottom edge and the monitor work
/// area's bottom edge, so it does not sit flush against the Dock/taskbar.
const BOTTOM_MARGIN: f64 = 24.0;

/// Reveal the pill window, anchoring it bottom-center of a connected monitor's
/// work area and (on macOS) raising it above fullscreen apps.
///
/// No-op if the pill window does not exist (e.g. it was never created). Every
/// fallible call is logged and swallowed; this never panics and never blocks a
/// recording. `show()` deliberately does **not** call `set_focus()` so the pill
/// (declared `focus: false`) never steals focus from the foreground app.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(PILL_LABEL) else {
        log::warn!("pill window not found; skipping show");
        return;
    };

    if let Err(e) = window.set_always_on_top(true) {
        log::warn!("pill set_always_on_top failed: {e}");
    }

    position_bottom_center(&window);

    if let Err(e) = window.show() {
        log::warn!("pill show failed: {e}");
        return;
    }

    // Built-in always-on-top does not clear macOS fullscreen apps; raise the
    // raw NSWindow level + collection behavior on every show (re-asserted in
    // case macOS reset it while hidden).
    #[cfg(target_os = "macos")]
    raise_above_fullscreen(&window);

    // Keep the pill out of the taskbar/Alt+Tab and prevent focus theft.
    #[cfg(windows)]
    apply_windows_ex_styles(&window);

    register_shortcuts(app);

    log::debug!("pill window shown");
}

/// Reconcile the pill's visibility with the current state: it should be visible
/// only while a recording is active AND the main window is not focused. When the
/// main window is focused the in-app recording bar takes over, so the pill hides
/// to avoid duplicate stop controls. Called on recording start and whenever the
/// main window's focus changes.
pub fn sync_visibility<R: Runtime>(app: &AppHandle<R>) {
    let main_focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    sync_visibility_with_main_focus(app, main_focused);
}

/// Reconcile the pill using an already-known main-window focus state (e.g. the
/// `WindowEvent::Focused` payload), avoiding a redundant `is_focused()` re-query
/// that could observe a stale value on focus-lagging window managers. Acts only
/// on a real visibility transition, so repeated focus toggles don't re-anchor
/// the pill to the cursor's monitor or churn global-shortcut registration.
pub fn sync_visibility_with_main_focus<R: Runtime>(app: &AppHandle<R>, main_focused: bool) {
    let want_visible = crate::audio::recording_commands::is_recording_active() && !main_focused;

    let currently_visible = app
        .get_webview_window(PILL_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if want_visible == currently_visible {
        return;
    }

    if want_visible {
        show(app);
    } else {
        hide(app);
    }
}

/// Hide the pill window. No-op if the window does not exist. Hiding (rather than
/// closing) keeps the pre-warmed webview alive for the next recording.
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    unregister_shortcuts(app);
    if let Some(window) = app.get_webview_window(PILL_LABEL) {
        match window.hide() {
            Err(e) => {
                log::warn!("pill hide failed: {e}");
            }
            _ => {
                log::debug!("pill window hidden");
            }
        }
    }
}

/// Register the pause global-shortcut backstop while the pill is visible.
/// Registered only during recording (not at idle) so it cannot collide with
/// other apps' shortcuts when nothing is being recorded. Re-registering an
/// already-registered chord errors, so unregister first to keep it idempotent.
fn register_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let global_shortcut = app.global_shortcut();
    let _ = global_shortcut.unregister(TOGGLE_PAUSE_SHORTCUT);
    if let Err(e) = global_shortcut.register(TOGGLE_PAUSE_SHORTCUT) {
        log::warn!("pill shortcut register failed for {TOGGLE_PAUSE_SHORTCUT}: {e}");
    }
}

/// Unregister the pause global-shortcut backstop when the pill hides.
fn unregister_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.global_shortcut().unregister(TOGGLE_PAUSE_SHORTCUT);
}

/// Position the pill at the bottom-center of the work area of the monitor under
/// the cursor (falling back to the primary monitor), computed in logical
/// coordinates and clamped to stay on-screen.
///
/// Monitor APIs are queried via the `WebviewWindow` (which dispatches to the
/// main thread internally) and every fallible step degrades gracefully: a
/// missing monitor or a failed query simply skips repositioning, leaving the
/// window at its last/declared position rather than panicking.
fn position_bottom_center<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    // Prefer the monitor under the cursor so the pill appears on the display the
    // user is actively working on; fall back to the primary monitor.
    let monitor = cursor_monitor(window).or_else(|| match window.primary_monitor() {
        Ok(monitor) => monitor,
        Err(e) => {
            log::warn!("pill primary_monitor query failed: {e}");
            None
        }
    });

    let Some(monitor) = monitor else {
        log::warn!("pill could not resolve a monitor; leaving default position");
        return;
    };

    // The work area excludes the menu bar / Dock / taskbar. Both fields are in
    // physical pixels; convert to logical using the monitor's scale factor so
    // positioning is DPI-correct on mixed-DPI multi-monitor setups.
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin: LogicalPosition<f64> = area.position.to_logical(scale);
    let size: LogicalSize<f64> = area.size.to_logical(scale);

    // Bottom-center anchor within the work area.
    let mut x = origin.x + (size.width - PILL_WIDTH) / 2.0;
    let mut y = origin.y + size.height - PILL_HEIGHT - BOTTOM_MARGIN;

    // Clamp so the pill never lands off-screen if the work area is smaller than
    // the pill or the computed anchor would overflow an edge.
    let max_x = origin.x + (size.width - PILL_WIDTH).max(0.0);
    let max_y = origin.y + (size.height - PILL_HEIGHT).max(0.0);
    x = x.clamp(origin.x, max_x);
    y = y.clamp(origin.y, max_y);

    if let Err(e) = window.set_position(LogicalPosition::new(x, y)) {
        log::warn!("pill set_position failed: {e}");
    }
}

/// The monitor under the current cursor position, or `None` if the cursor
/// position or monitor lookup fails. `cursor_position` is physical; the
/// `monitor_from_point` API expects the same physical coordinates.
pub(crate) fn cursor_monitor<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Option<tauri::Monitor> {
    let cursor = match window.cursor_position() {
        Ok(position) => position,
        Err(e) => {
            log::warn!("pill cursor_position query failed: {e}");
            return None;
        }
    };
    match window.monitor_from_point(cursor.x, cursor.y) {
        Ok(monitor) => monitor,
        Err(e) => {
            log::warn!("pill monitor_from_point query failed: {e}");
            None
        }
    }
}

/// Raise the pill above macOS fullscreen apps and across all Spaces.
///
/// Tauri's `set_always_on_top`/`set_visible_on_all_workspaces` do not float
/// above fullscreen apps; this sets the raw `NSWindow` level and collection
/// behavior via AppKit. AppKit must be touched on the main thread, so the two
/// property sets are dispatched there via `run_on_main_thread`, fire-and-forget:
/// nothing downstream depends on them landing before `show` returns, and `show`
/// is itself called from the main thread during `setup` (relaunch-while-recording),
/// where blocking on a channel would deadlock. If the `NSWindow` handle cannot be
/// obtained, we degrade to `set_visible_on_all_workspaces(true)` and log, never
/// crashing.
// The `objc` 0.2.7 `msg_send!`/`sel_impl!` macros emit an internal
// `#[cfg(feature = "cargo-clippy")]` that this crate does not declare; suppress
// the resulting `unexpected_cfgs` lint from that third-party macro expansion.
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
pub(crate) fn raise_above_fullscreen<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    // `NSScreenSaverWindowLevel` (CoreGraphics `kCGScreenSaverWindowLevelKey`)
    // is the standard "above everything, including fullscreen" level. Using the
    // numeric constant avoids linking the AppKit symbol.
    const NS_SCREEN_SAVER_WINDOW_LEVEL: i64 = 1000;
    // NSWindowCollectionBehavior bitmask: canJoinAllSpaces (1<<0) so the pill is
    // present on every Space, fullScreenAuxiliary (1<<8) so it floats over a
    // fullscreen Space, and stationary (1<<4) so Exposé/Mission Control leaves
    // it in place.
    const NS_WINDOW_COLLECTION_BEHAVIOR: u64 = (1 << 0) | (1 << 4) | (1 << 8);

    let ns_window = match window.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr,
        Ok(_) => {
            log::warn!("pill ns_window returned null; degrading to all-workspaces visibility");
            let _ = window.set_visible_on_all_workspaces(true);
            return;
        }
        Err(e) => {
            log::warn!("pill ns_window failed ({e}); degrading to all-workspaces visibility");
            let _ = window.set_visible_on_all_workspaces(true);
            return;
        }
    };

    // `*mut c_void` is not `Send`; move the raw address (usize) across the
    // thread boundary and rebuild the pointer on the main thread. The pill window
    // is statically declared and never destroyed (its CloseRequested only hides
    // it), so the pointer stays valid for the dispatched closure.
    let ns_window_addr = ns_window as usize;

    let dispatch = window.run_on_main_thread(move || {
        // The `msg_send!` keyword-argument form expands to call `sel!`, so its
        // helper macros (`sel`, `sel_impl`) must be in scope here.
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        // SAFETY: runs on the main (AppKit) thread; `ns_window_addr` is the live
        // NSWindow for this webview, valid for the duration of this call.
        unsafe {
            let ns_window = ns_window_addr as *mut Object;
            let _: () = msg_send![ns_window, setLevel: NS_SCREEN_SAVER_WINDOW_LEVEL];
            let _: () = msg_send![ns_window, setCollectionBehavior: NS_WINDOW_COLLECTION_BEHAVIOR];
        }
    });

    if let Err(e) = dispatch {
        log::warn!("pill raise-above-fullscreen dispatch failed: {e}");
        let _ = window.set_visible_on_all_workspaces(true);
    }
}

/// Apply the Windows extended window styles that keep the pill out of the
/// taskbar and Alt+Tab and prevent it from stealing foreground focus.
///
/// `WS_EX_TOOLWINDOW` removes it from the taskbar **and** the Alt+Tab switcher
/// (`skipTaskbar` alone leaves it in Alt+Tab), and `WS_EX_NOACTIVATE` stops
/// clicks on pause/stop from stealing the foreground window.
#[cfg(windows)]
fn apply_windows_ex_styles<R: Runtime>(_window: &tauri::WebviewWindow<R>) {
    // TODO(windows): apply WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE on the pill HWND
    // via `_window.hwnd()` + `SetWindowLongPtrW(GWL_EXSTYLE, ...)`. This needs
    // the `windows`/`windows-sys` crate, which is not currently a direct
    // dependency (per the project policy against adding a new heavy
    // dependency). Until then the pill relies on the `skipTaskbar: true` config
    // flag, which keeps it out of the taskbar but not Alt+Tab. macOS is the
    // priority platform.
    log::debug!("pill Windows ex-styles are a no-op; relying on skipTaskbar config");
}
