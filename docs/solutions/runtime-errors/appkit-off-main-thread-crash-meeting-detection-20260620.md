---
module: Meeting Detection
date: 2026-06-20
problem_type: runtime_error
component: service_object
symptoms:
  - "Enabling 'Automatically detect meetings' instantly blanks the window / kills the app"
  - "App aborts within ~1s of the foreground-app watcher starting"
  - "Crash on launch when the auto-detect setting was left enabled (setup auto-start path)"
root_cause: thread_violation
resolution_type: code_fix
severity: high
tags: [tauri, macos, appkit, nsworkspace, main-thread, threading, cidre]
---

# Troubleshooting: Meeting auto-detect crashes the app (AppKit read off the main thread)

## Problem
Turning on "Automatically detect meetings" immediately broke the UI: the webview went blank / the app process died. The feature spawns a background thread that reads the macOS frontmost application via `NSWorkspace`, and touching AppKit from a non-main thread makes macOS abort the process.

## Environment
- Module: Meeting Detection (`app/src-tauri/src/meeting_detect/watcher.rs`)
- Stack: Tauri 2.6.2, Rust (pinned nightly), Svelte 5 frontend; macOS (aarch64), `cidre` for AppKit access
- Affected Component: foreground-app watcher (background polling thread)
- Date: 2026-06-20

## Symptoms
- Flipping Settings → "Automatically detect meetings" ON immediately blanks/kills the app.
- The app aborts ~1s after the watcher starts (its first poll tick).
- Relaunching with the setting persisted ON crashes on startup (the setup auto-start path runs the same code).

## What Didn't Work

**Attempted Solution 1 (ruled out):** Suspected the frontend — the `meeting-app-detected` listener in `routes/+layout.svelte` and the toggle handler in `RecordingSettings.svelte`.
- **Why it wasn't it:** both are guarded (try/catch, optional chaining, error-toast on the command result envelope); the matcher (`match_meeting_app`) and the `set_auto_detect_meetings` command are pure/clean with no panic. The crash happens on enable regardless of whether any meeting app is focused, which pointed at the watcher startup, not the UI.

## Solution

The watcher's per-tick read of `NSWorkspace` was running on the spawned background thread. The fix marshals that AppKit read to the **main thread** via `AppHandle::run_on_main_thread`, returning the result over a channel — the same pattern the dictation clipboard injection (`dictation/inject.rs`) already uses.

**Code changes** (`app/src-tauri/src/meeting_detect/watcher.rs`):
```rust
// Before (broken): NSWorkspace touched on the background watcher thread
let frontmost = cidre::objc::ar_pool(frontmost_bundle_id);

// After (fixed): dispatch the AppKit read to the main thread
let frontmost = read_frontmost_on_main(&app);

#[cfg(target_os = "macos")]
fn read_frontmost_on_main<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<String>>(1);
    if app
        .run_on_main_thread(move || {
            // Autorelease pool so the temporary Objective-C objects are freed.
            let _ = tx.send(cidre::objc::ar_pool(frontmost_bundle_id));
        })
        .is_err()
    {
        return None;
    }
    rx.recv_timeout(std::time::Duration::from_secs(2)).ok().flatten()
}
```
The loop and `sleep` stay on the background thread (so the main thread is only touched briefly each tick); only the `NSWorkspace`/`NSRunningApplication` access moves to the main thread.

Commit: `4fd17e8 fix(meetings): read frontmost app on the main thread to stop UI crash`.

## Why This Works
1. **Root cause:** AppKit (`NSWorkspace`, `NSRunningApplication`) is not safe to use off the main thread. macOS's main-thread checker aborts the entire process (SIGABRT) the moment a UI/AppKit API is invoked on a non-main thread — which happened on the watcher's very first poll tick, i.e. right after enabling the toggle.
2. **Fix:** `run_on_main_thread` runs the read on the Cocoa main thread where AppKit is valid; the result (a plain `Option<String>`, which is `Send`) is returned over a `sync_channel`. No `!Send`/AppKit object ever crosses a thread boundary.
3. **Why background polling is still fine:** the cadence/`sleep` remain off-main, so the UI thread isn't blocked; only the short frontmost read is dispatched to it.

## Prevention
- In a Tauri app, **any AppKit / Cocoa / `cidre` call must run on the main thread.** Wrap it in `app.run_on_main_thread(...)` and marshal results back over a channel. Never call `NSWorkspace`, `NSPasteboard`, `NSRunningApplication`, etc. from `std::thread::spawn` / `tokio::spawn`.
- Reference pattern to copy: the dictation text injection in `app/src-tauri/src/dictation/inject.rs`.
- Watch for: any new background thread/task that touches `cidre::ns::*` or `objc` UI types — route it through the main thread.
- Catch early: a debug build surfaces this as a main-thread-checker abort the instant the off-main call runs. `cargo check`/`cargo test` will NOT catch it — exercise the feature in a real app run at least once.

## Related Issues
No related issues documented yet. The same main-thread-dispatch pattern is used (correctly) by the dictation text injection in `app/src-tauri/src/dictation/inject.rs`.
