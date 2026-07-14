//! Insert dictated text into the focused application.
//!
//! Text is injected with the clipboard + a synthesized paste chord (not
//! `enigo.text()`, which crashes inside a Tauri command on macOS). On macOS the
//! clipboard (`NSPasteboard`) is not thread-safe, so the save / set / paste run
//! on the app's main thread, and the user's prior clipboard is restored shortly
//! after the paste has had a chance to read it. macOS requires Accessibility
//! permission; other platforms do a best-effort paste with no permission gate.

use anyhow::{Result, anyhow};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    /// Whether this process is trusted for the Accessibility (AX) APIs that back
    /// synthesized keyboard input. Linked via the ApplicationServices framework
    /// (also pulled in by `enigo`'s CoreGraphics usage).
    fn AXIsProcessTrusted() -> bool;
}

/// Whether the OS will accept synthesized input (Accessibility on macOS).
pub fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Set the clipboard to `text`, returning the prior text contents (if any).
fn swap_clipboard(text: &str) -> Result<Option<String>> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| anyhow!("clipboard open: {e}"))?;
    let previous = clipboard.get_text().ok();
    clipboard
        .set_text(text.to_string())
        .map_err(|e| anyhow!("clipboard set: {e}"))?;
    Ok(previous)
}

/// Restore the clipboard to `previous` (no-op when there was nothing to restore).
fn restore_clipboard(previous: Option<String>) {
    if let Some(text) = previous {
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            let _ = clipboard.set_text(text);
        }
    }
}

/// Synthesize the paste chord: Cmd+V on macOS, Ctrl+V elsewhere.
fn synthesize_paste() -> Result<()> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| anyhow!("enigo init: {e}"))?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    enigo
        .key(modifier, Direction::Press)
        .map_err(|e| anyhow!("paste press: {e}"))?;
    enigo
        .key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| anyhow!("paste key: {e}"))?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| anyhow!("paste release: {e}"))?;
    Ok(())
}

/// Insert `text` into the focused app, restoring the prior clipboard afterward.
/// Blocking (waits on the main thread + a short restore delay), so call it from
/// a blocking context. Errors if Accessibility is not granted on macOS.
pub fn inject_text<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    if !accessibility_trusted() {
        return Err(anyhow!(
            "Accessibility permission is required to insert dictated text"
        ));
    }

    let text = text.to_string();
    let injected_text = text.clone();
    let app_for_restore = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<std::result::Result<Option<String>, String>>();

    // Save + set the clipboard and synthesize the paste, all on the main thread
    // (NSPasteboard is not thread-safe and the order must be set-then-paste).
    app.run_on_main_thread(move || {
        let result = (|| -> std::result::Result<Option<String>, String> {
            let previous = swap_clipboard(&text).map_err(|e| e.to_string())?;
            synthesize_paste().map_err(|e| e.to_string())?;
            Ok(previous)
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| anyhow!("dispatch injection to main thread: {e}"))?;

    let previous = rx
        .recv()
        .map_err(|_| anyhow!("injection did not complete"))?
        .map_err(|e| anyhow!("{e}"))?;

    // Let the target app read the clipboard before restoring the prior contents.
    // A fixed delay can't guarantee the paste has been consumed, so use a slightly
    // more forgiving window; the guard below prevents the worst outcome of racing.
    std::thread::sleep(std::time::Duration::from_millis(250));
    let _ = app_for_restore.run_on_main_thread(move || {
        // Only restore if our dictated text is still on the clipboard. If the user
        // (or another app) copied something new during the paste window, keep their
        // content rather than clobbering it with the stale `previous`.
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            if clipboard.get_text().ok().as_deref() == Some(injected_text.as_str()) {
                restore_clipboard(previous);
            }
        }
    });
    Ok(())
}
