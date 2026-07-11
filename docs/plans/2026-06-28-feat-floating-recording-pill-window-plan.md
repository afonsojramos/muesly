---
title: Floating always-on-top recording pill window
type: feat
status: active
date: 2026-06-28
---

# ✨ Floating always-on-top recording pill window

## Enhancement Summary

**Deepened on:** 2026-06-28
**Research agents used:** framework-docs-researcher (Tauri/SvelteKit), best-practices-researcher
(floating-widget UX + cross-platform), architecture-strategist, feasibility-reviewer,
code-simplicity-reviewer, spec-flow-analyzer.

### Key improvements over the first draft
1. **Show/hide is bound to the `IS_RECORDING` flag transitions, not the emit sites.** There
   are **two** `recording-started` sites (`recording_commands/mod.rs:418` and `:611`) and
   several stop exits that never emit `recording-stopped` (early `Ok` at `:644`, `Err` at
   `:683`, and the `recording-error` path at `:345`/`:539`). Hooking only the emit sites
   would strand an undismissable always-on-top pill. A single `set_recording_active(app, bool)`
   helper that toggles `IS_RECORDING` **and** the pill makes desync structurally impossible.
2. **Float-above-fullscreen requires raw AppKit, confirmed.** `set_always_on_top` and even
   `set_visible_on_all_workspaces(true)` do **not** float above macOS fullscreen apps (Tauri
   #11488/#5793). Granola parity needs `NSWindow.level` raised plus
   `CanJoinAllSpaces | FullScreenAuxiliary | Stationary` collection behaviour, applied via the
   codebase's existing `run_on_main_thread` + `sync_channel` pattern. This is the required
   path, not a contingency.
3. **Route isolation needs the route-group refactor, confirmed mandatory.** A `+page@.svelte`
   layout reset does **not** escape the root layout, and the heavy shell lives in the root
   `+layout.svelte`. The shell must move into `(app)/` with a minimal root layout.
4. **Two correctness must-fixes surfaced:** the pre-warmed hidden pill webview is
   background-throttled/unloaded after ~5 min (set `backgroundThrottling: "disabled"` + a
   `get_recording_state` self-heal on show), and a stray `Cmd+W` permanently destroys the
   pill unless `CloseRequested` is intercepted for the `pill` label.
5. **Stop UX reworked (D5 flipped):** hiding the pill the instant `recording-stopped` fires
   leaves zero feedback when the main window is in the tray. The pill now shows a brief
   non-interactive "Saving…" state and hides when the session reaches a terminal state.
6. **Accessibility:** a non-focusable pill is keyboard-dead, so pause/stop get a global
   shortcut (the `tauri-plugin-global-shortcut` is already a dependency), plus `aria-label`s
   and an `aria-live` timer.
7. **Pre-existing bug fixed in passing:** `recording-error` is emitted by Rust but has **no
   frontend listener anywhere**, violating the "never swallow errors" rule. We add a listener
   that toasts the message and resets state (and hides the pill).

### New considerations discovered
- Background throttling of hidden webviews (D1's pre-warm rationale needs the throttling flag).
- Windows needs `WS_EX_TOOLWINDOW` (out of Alt+Tab, not just taskbar) and `WS_EX_NOACTIVATE`
  (no focus steal); `skipTaskbar` alone is insufficient.
- Multi-monitor + DPI: position from the cursor's monitor work-area in logical coordinates
  (Tauri #7890/#7139/#15170 caution: monitor APIs must run on the main thread and can report
  wrong DPI positions).
- `(app)/+layout.svelte` must **drop** its `import '../app.css'` after the move (the minimal
  root keeps it); otherwise the path breaks the build.
- The pill is bound to the meeting-recording lifecycle only; dictation bursts never show it
  (falls out of the architecture, now stated explicitly).

---

## Overview

Turn the in-app recording controls "pill" into a dedicated, frameless, always-on-top
floating window (Granola-style) that is shown **only while a recording is active**, and
lay the pill out **vertically** instead of horizontally.

Today the pill lives inside the main window as a fixed overlay and is visible whenever the
app has microphone permission, even when nothing is being recorded. We want the active
recording controls to float above every other OS window so the user can pause/stop a
recording without bringing muesly to the foreground, and we want that surface to disappear
entirely when no recording is in progress.

This introduces the project's **first multi-window pattern**, so a chunk of the work is
establishing the seams cleanly (window config, capability scoping, SvelteKit layout
isolation, macOS main-thread dispatch) rather than raw UI.

## Problem Statement

1. **Wrong visibility model.** The pill is gated by `showRecordingControls`
   (`app/src-svelte/src/routes/+page.svelte:78-82`), which is true when
   `permissions.hasMicrophone || recordingState.isRecording`. In practice it is on screen
   almost always, not only during active recording.
2. **Trapped in the main window.** The pill is a fixed overlay
   (`app/src-svelte/src/routes/+page.svelte:281-305`). If the user tabs away to their
   meeting app, the controls are gone. There is no way to pause/stop without refocusing
   muesly.
3. **Horizontal layout.** The pill row is `flex items-center space-x-2`
   (`app/src-svelte/src/lib/components/RecordingControls.svelte:205-206`). The request is a
   vertical stack.

## Proposed Solution

Add a second Tauri window labelled `pill` that hosts a new vertical `RecordingPill.svelte`
component on a dedicated, layout-isolated SvelteKit route (`/pill`). The window is declared
statically in `tauri.conf.json` with `visible: false`, and its visibility is driven from
Rust by a single `set_recording_active(app, bool)` helper that is the **same seam** that
flips the global `IS_RECORDING` flag, so the pill can never desync from the real recording
state.

```
  set_recording_active(app, true)                 set_recording_active(app, false)
  (where IS_RECORDING -> true:                     (where IS_RECORDING -> false:
   mod.rs:368 + devices path)                       mod.rs:996, error paths, early-returns)
                │                                                 │
                ▼                                                 ▼
        pill_window::show(app)                            pill_window::hide(app)
        + macOS NSWindow level/collectionBehavior         (after "Saving…" terminal state)
                │
   ┌────────────┴─────────────────────────────────────────────────────────────┐
   │  Tauri window "pill"  (alwaysOnTop, decorations:false, transparent,        │
   │   skipTaskbar, focus:false, backgroundThrottling:disabled, visible:false)  │
   │  loads SPA route /pill -> RecordingPill.svelte (vertical)                  │
   │  on show: get_recording_state() self-heal; listens to recording-* events;  │
   │  calls pause/resume/stop; global shortcut backstop for keyboard            │
   └────────────────────────────────────────────────────────────────────────────┘
```

Both windows share one Rust recording state (the commands are global), and Tauri's
`app.emit(...)` broadcasts events to every window (verified: `recording-started:418`,
`recording-stopped:1024`, `recording-paused:1058`, `recording-resumed:1093` all use
`app.emit`, not `emit_to`), so the pill webview stays in sync via the same events the main
window already uses (`app/src-svelte/src/lib/services/recording.ts:108-167`).

### Why a statically-declared, Rust-controlled window (not dynamic creation)

- **Pre-warmed:** the webview is created at startup (hidden), so there is no first-paint lag
  when recording starts. **Caveat (new):** hidden webviews are background-throttled and can
  be unloaded after ~5 min, so the pill window sets `backgroundThrottling: "disabled"` and
  the pill page re-fetches `get_recording_state()` on `show`/`visibilitychange`.
- **No AppKit creation dance:** Tauri builds the window on the main thread during setup, so
  we avoid the off-main-thread `WebviewWindowBuilder` hazards documented in
  `docs/solutions/runtime-errors/appkit-off-main-thread-crash-meeting-detection-20260620.md`.
- **Clean capability scoping:** the `pill` window gets its own minimal capability block.
- **Visibility follows recording, not a webview.** Driving show/hide from the `IS_RECORDING`
  transition guarantees the pill is correct even if the main window is hidden to tray, a
  recording is stopped from the tray, or a recording fails.

## Key Design Decisions

| # | Decision | Resolution | Notes |
|---|----------|------------|-------|
| D1 | Window lifecycle | Static window in `tauri.conf.json`, `visible:false`, `backgroundThrottling:"disabled"`; Rust `show()`/`hide()` | Dynamic builder rejected |
| D2 | Show/hide trigger | Rust `set_recording_active(app,bool)` co-located with the `IS_RECORDING` flag toggle (not the emit sites) | Covers 2 start sites + all stop/error paths |
| D3 | Route isolation | **Route-group refactor**: move shell into `(app)/`, minimal root `+layout.svelte` | `+page@.svelte` reset does **not** escape root; refactor is mandatory |
| D4 | Main-window pill during recording | Show the in-app pill for idle/start; **hide it while `recordingState.isRecording`** so the floating pill is the sole active surface | Deliberate product call; small guard change in `+page.svelte:281` |
| D5 | Hide timing / stop UX | On stop, pill shows a brief **non-interactive "Saving…"** state; window hides when the session reaches a terminal state, not on raw `recording-stopped` | Avoids zero-feedback when main window is in tray |
| D6 | Audio bars | Self-animated `Math.random()` loop locally; honour `prefers-reduced-motion` (static bars + steady cue) | No real-RMS plumbing |
| D7 | Dictation mode | **Out of scope by construction**: dictation emits `dictation-text` and skips the meeting lifecycle, so the pill never shows for hold-to-talk bursts | Stated explicitly to protect the boundary |
| D8 | Component | New `RecordingPill.svelte` scoped to active controls; pause/resume/stop extracted to shared `recordingState` methods | Do **not** parametrize `RecordingControls.svelte` |

D4 is the one genuine product call. The simplicity review noted a purely additive
alternative (leave `+page.svelte` untouched, both surfaces visible). We keep D4 because the
literal request is that the actively-recording pill is the only place active controls live;
the change is a one-line guard and is revisited in `/workflows:review`.

## Technical Approach

### 1. Tauri window declaration (`app/src-tauri/tauri.conf.json`)

Add a second entry to `app.windows` (alongside the existing `main`, `tauri.conf.json:13-24`),
and give the existing window an explicit `"label": "main"`:

```jsonc
{
  "label": "pill",
  "url": "/pill",
  "width": 80,
  "height": 220,
  "resizable": false,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "shadow": false,
  "focus": false,
  "visible": false,
  "backgroundThrottling": "disabled",
  "title": "muesly recording"
}
```

**Research insights (framework verification):**
- All keys above are valid camelCase `WindowConfig` fields in `tauri-utils` 2.6.2. `focus`
  defaults to `true`, so `focus:false` is necessary; `show()` does not call `set_focus()`, so
  revealing the pre-warmed pill will not steal focus (do **not** call `set_focus()` in
  `pill_window::show`).
- Do **not** copy `titleBarStyle`/`hiddenTitle`/`theme` from the `main` entry to the pill
  (irrelevant for a `decorations:false` window).
- `transparent:true` requires `macOSPrivateApi` (already `true`, `tauri.conf.json:26`) and the
  `macos-private-api` crate feature (present, `Cargo.toml:160,175`). On Windows transparency
  comes from WebView2; `shadow:false` removes the square OS shadow so the CSS rounded shape +
  box-shadow is the only visible chrome.
- `width:80,height:220` are logical px sized for 44px hit targets (see UI section).

Add a dedicated, **trimmed** capability block to `app.security.capabilities`
(`tauri.conf.json:40-80`) scoped to `windows: ["pill"]`. Capabilities gate only frontend JS
IPC, never Rust calls, so the Rust `show/hide/set_always_on_top/set_position` need no
permissions:

```jsonc
{
  "identifier": "pill",
  "description": "Floating recording pill window",
  "windows": ["pill"],
  "permissions": [
    "core:event:default",               // listen to recording-* events (allow-listen)
    "core:window:default",              // read own size/monitor (query-only)
    "core:window:allow-start-dragging", // data-tauri-drag-region -> startDragging IPC
    "core:path:default"                 // appDataDir() for stop_recording save_path
  ]
}
```

**Research insights (capability verification):** `core:window:default` is query-only and does
**not** include `allow-start-dragging`, so it must be listed explicitly (verified against the
ACL manifests). Drop `core:window:allow-set-position` and `core:app:default` from the first
draft (positioning is Rust-side; `appDataDir()` is gated by `core:path:*`, not `core:app:*`).
Custom app commands (`stop_recording`, `pause_recording`, `get_recording_state`) are not
ACL-gated, so they need no permission entries.

### 2. SvelteKit layout isolation (route group, mandatory)

The root layout `app/src-svelte/src/routes/+layout.svelte` mounts the **entire app shell**
(`Sidebar`, `MainContent`, onboarding, `bootStores` at `:120`, toasters, dialogs) and imports
`../app.css` at `:2`. Every route inherits it.

**Research insight (corrects the first draft):** a `+page@.svelte` layout reset resets to the
**root** layout, it does not escape it. Because the shell is in the root layout, only moving
the shell out works. The route-group refactor is therefore mandatory:

```
src/routes/
  +layout.ts                     # unchanged: ssr=false, prerender=false
  +layout.svelte                 # NEW minimal: import '../app.css'; apply theme to <html>; {@render children()}
  (app)/
    +layout.svelte               # MOVED shell; DROP its `import '../app.css'` (root now owns it)
    +page.svelte                 # MOVED (URL stays "/")
    settings/+page.svelte        # MOVED (URL stays "/settings")
    meeting-details/+page.svelte # MOVED (URL stays "/meeting-details")
  pill/
    +page.svelte                 # NEW bare pill page; inherits only the minimal root layout
```

**Research insights (feasibility-verified):**
- Route groups do not change URLs; all `goto()`/tray targets are absolute (`/`, `/settings`,
  `/meeting-details`) and unaffected. `$lib` imports are alias-based and unaffected.
- **Build-breaker to avoid:** the moved `(app)/+layout.svelte` must **drop** `import '../app.css'`
  (it would resolve to the non-existent `src/routes/app.css`). The minimal root keeps the
  single import; CSS cascades to children.
- The minimal root layout must keep applying the `theme` store class to `<html>` (so the pill
  renders the warm-paper tokens, including dark mode) but must run **no** `bootStores`/global
  side effects, that is the whole point of moving them into `(app)/`.

**Transparent body for `/pill` only** (window transparency does not stop the DOM painting
`html`/`body` backgrounds; `app.css:87-88` sets an opaque `body` background):

```svelte
<!-- src/routes/pill/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  onMount(() => {
    document.documentElement.classList.add('pill-route');
    return () => document.documentElement.classList.remove('pill-route');
  });
</script>

<RecordingPill />

<style>
  :global(html.pill-route), :global(html.pill-route body) { background: transparent !important; }
</style>
```

> SPA serving of `/pill` is verified in Tauri source (`get_asset` falls back to `index.html`,
> then the client router resolves `/pill`); works in `tauri:dev` (`localhost:1420/pill`) and a
> bundled build. `fallback:'index.html'` is discouraged by SvelteKit but already ships and
> works; only switch to `200.html` if `/pill` ever 404s in a bundled build.

### 3. The vertical pill component (`app/src-svelte/src/lib/components/RecordingPill.svelte`)

A **new** component (do not parametrize `RecordingControls.svelte`, which is 60%+ start-flow
code, device-error modal, and main-window listeners), derived only from the active branch of
`RecordingControls.svelte:246-309`, laid out vertically:

- Full-surface **drag underlay** so the whole pill drags except the buttons (Tauri v2 drag
  regions do not propagate to children, so use an absolute underlay + `relative` children):

```svelte
<div class="relative flex h-screen w-screen items-center justify-center bg-transparent">
  <div class="relative flex flex-col items-center gap-3 rounded-[2rem] border border-border
              bg-card px-3 py-4 shadow-[0_8px_30px_rgb(0,0,0,0.18)]">
    <div data-tauri-drag-region class="absolute inset-0 rounded-[2rem]" style="-webkit-user-select:none"></div>
    <span class="relative text-xs tabular-nums text-muted-foreground" aria-live="polite">{elapsed}</span>
    <button class="relative size-11 rounded-full ..." aria-label={isPaused ? 'Resume recording' : 'Pause recording'} onclick={togglePause}>…</button>
    <button class="relative size-11 rounded-full bg-destructive ..." aria-label="Stop recording" onclick={stop}>…</button>
    <div class="relative flex flex-col items-center gap-1" aria-hidden="true">{#each bars …}{/each}</div>
  </div>
</div>
```

- **State:** reuse `recordingState` (`recording-state.svelte.ts`); the pill webview
  self-initializes via `recordingState.start()` and additionally calls `get_recording_state()`
  on `show`/`visibilitychange` to self-heal if it missed the `recording-started` broadcast
  (events are not replayed).
- **Actions:** call shared `recordingState.stop()/pause()/resume()` (extracted from
  `RecordingControls.svelte:95-154`, including the `appDataDir()` + ISO-timestamp `save_path`
  shape and the re-entrancy/idempotency guards) so the two surfaces cannot drift.
- **Sizing (UX-research):** 44px (`size-11`) hit targets, `gap-3` (12px), `tabular-nums`
  timer, ~80×220 logical window.
- **Bars:** local `Math.random()` loop; under `prefers-reduced-motion: reduce` show **static**
  bars + a steady "Recording" cue and replace enter/exit motion with a short opacity fade.

### 4. Rust: `pill_window` module (`app/src-tauri/src/pill_window.rs`)

A small module (justified, the surface is non-trivial: positioning, macOS AppKit, the
`set_recording_active` seam) following the `get_webview_window` show/hide precedent in
`tray.rs:394-414`:

```rust
// app/src-tauri/src/pill_window.rs (sketch)
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window("pill") else { return; };
    let _ = w.set_always_on_top(true);
    position_default(&w);                 // cursor-monitor work-area bottom-center, clamped
    let _ = w.show();
    #[cfg(target_os = "macos")]
    raise_above_fullscreen(&w);           // run_on_main_thread: NSWindow level + collectionBehavior
}
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("pill") { let _ = w.hide(); }
}
```

`set_recording_active(app, active)` toggles `IS_RECORDING` and calls `show`/`hide`, and is
invoked wherever the flag changes today: set true at `recording_commands/mod.rs:368` and the
devices-path equivalent near `:611`; set false at `:996`, the early-`Ok` no-op at `:644`, the
`Err` exit at `:683`, and the `recording-error` paths at `:345`/`:539`. Call `hide()` **before**
`app.emit("recording-stopped")` to avoid a teardown flicker in the pill webview.

**Research insights (Rust API + macOS, verified):**
- `get_webview_window` returns `Option`; `show/hide/set_always_on_top/set_position/
  set_visible_on_all_workspaces` are synchronous, return `Result<()>`, and are event-loop
  dispatched, so they are safe from command threads (matches `tray.rs`). Never panic; log and
  continue so recording is never blocked.
- **Float-above-fullscreen (required for Granola parity):** `set_always_on_top` and
  `set_visible_on_all_workspaces` alone do not clear fullscreen apps (Tauri #11488/#5793). In
  `raise_above_fullscreen`, via `run_on_main_thread` + `sync_channel` (the pattern in
  `dictation/inject.rs`), set the `NSWindow` level high (around `NSScreenSaverWindowLevel`,
  tune if too aggressive) and `collectionBehavior = CanJoinAllSpaces | FullScreenAuxiliary |
  Stationary`. Re-assert on every `show()`. Do **not** use app-wide
  `ActivationPolicy::Accessory` (it removes the Dock icon). **Verify in a bundled build**, not
  `pnpm tauri:dev`.
- **Positioning:** prefer the cursor's monitor (`monitor_from_point` + cursor position, fall
  back to `primary_monitor`); compute bottom-center from the monitor **work area** in logical
  coordinates using `scale_factor` (Tauri #7890/#7139 DPI bugs); call monitor APIs on the main
  thread (#15170 off-main-thread crash); clamp to a connected monitor so a stale/off-screen
  position falls back to default. MVP-minimum is primary-monitor work-area bottom-center.
- **Windows ex-styles (Phase 3):** add `WS_EX_TOOLWINDOW` (absent from taskbar **and** Alt+Tab,
  `skipTaskbar` is not enough) and `WS_EX_NOACTIVATE` (clicking pause/stop must not steal
  foreground), via `windows-rs`/`SetWindowLongPtr` on the `HWND`.

### 5. Lifecycle plumbing in `lib.rs`

- **Pill `CloseRequested` guard (must-fix):** extend the handler at `lib.rs:1219-1230` so
  `window.label() == "pill"` also `prevent_close()` + `hide()`. Otherwise a stray `Cmd+W`
  destroys the window and `pill_window::show()` no-ops forever (silent permanent breakage).
- **App-launched-while-recording:** after building windows in setup, if `IS_RECORDING` is true,
  call `pill_window::show(&app)` once so a relaunch mid-recording still shows the pill.
- **Global shortcut backstop (accessibility):** register pause/stop via the already-present
  `tauri-plugin-global-shortcut`, because a `focus:false` pill is not keyboard-reachable.

### 6. Main-window pill gating (`app/src-svelte/src/routes/+page.svelte`)

Per D4, render the in-app `RecordingControls` for the idle/start state and suppress it while
`recordingState.isRecording` (adjust the guard around `+page.svelte:78-82,281`). Starting a
recording still happens from the idle pill; on start, the in-app pill disappears and the
floating pill takes over.

### 7. `recording-error` handling (fixes a pre-existing silent failure)

`recording-error` (`recording_commands/mod.rs:345,539`, with a `user_message()`) currently has
**no frontend listener** (verified: zero matches in `app/src-svelte/src`), violating the
"never swallow errors" rule. Add a listener in the `(app)` shell that toasts `user_message()`
and drives the state machine out of the active state; the `set_recording_active(app,false)` on
the error path hides the pill so it can never orphan over other apps.

## Implementation Phases

### Phase 1: Window + route plumbing (foundation)
- `tauri.conf.json`: add the `pill` window (`visible:false`, `backgroundThrottling:"disabled"`)
  and trimmed `pill` capability; give `main` an explicit label.
- Route-group refactor: minimal root `+layout.svelte` (keeps the single `app.css` import),
  move shell into `(app)/` (drop its `app.css` import), add bare `pill/+page.svelte` with the
  transparent-body class.
- `pill_window.rs`: `show`/`hide` + `set_recording_active`; wire into the `IS_RECORDING`
  transitions; add the pill `CloseRequested` guard and the launched-while-recording check.
- **Verify:** start a recording → an empty transparent always-on-top window appears and
  disappears on stop; `/settings` and `/meeting-details` still navigate; tray still
  shows/hides main; `Cmd+W` on the pill hides (does not destroy) it.

### Phase 2: Vertical pill UI + correctness (core)
- Build `RecordingPill.svelte` (vertical, elapsed time, pause/resume, stop, animated bars,
  drag underlay, aria labels/live).
- Extract `recordingState.stop()/pause()/resume()`; wire both surfaces to them.
- `get_recording_state()` self-heal on show/visibilitychange.
- D4 in-app gating; D5 "Saving…" terminal state; `recording-error` listener + toast.
- **Verify:** during recording the floating pill shows live elapsed time; pause/stop sync
  across both windows and the tray; stopping shows "Saving…" then hides on completion; a
  forced `recording-error` hides the pill and toasts.

### Phase 3: Cross-platform + polish
- macOS: `raise_above_fullscreen` (NSWindow level + collectionBehavior via main-thread
  pattern); verify float above a fullscreen app and across Spaces in a **bundled build**.
- Windows: `WS_EX_TOOLWINDOW` + `WS_EX_NOACTIVATE`; verify transparency, no square shadow, no
  taskbar/Alt+Tab entry, no focus steal.
- Positioning: cursor-monitor work-area bottom-center, logical coords + scale_factor, clamp to
  connected monitor, main-thread monitor calls, never panic.
- Reduced-motion (static bars + fade); global pause/stop shortcut.
- **Post-MVP (deferred):** persist last dragged position and restore on show (strong
  convention, but non-blocking); re-assert always-on-top after OS wake.

## Alternative Approaches Considered

- **Dynamic window creation on record start.** Rejected (D1): more Rust, first-paint lag,
  off-main-thread AppKit creation risk.
- **Frontend-driven show/hide command.** Rejected (D2): couples visibility to a webview's
  liveness and inherits the same emit-coverage gap; the `IS_RECORDING` transition is the
  authoritative seam.
- **`+page@.svelte` layout reset / pathname conditional.** Rejected (D3): a reset still passes
  through the root layout where the shell lives; only the route-group refactor isolates.
- **Parametrize `RecordingControls.svelte` with a `vertical` prop.** Rejected (D8): it would
  force every main-window-only prop optional and dead-branch half the file; two focused
  components are simpler.
- **App-wide `ActivationPolicy::Accessory` for fullscreen float.** Rejected: removes the Dock
  icon for the whole app.
- **OS menu-bar/tray indicator only** (`TODOs.md:181-182`). Does not meet the floating,
  always-on-top, with-controls requirement.

## System-Wide Impact

### Interaction graph
`start_recording*` → `set_recording_active(app,true)` (flips `IS_RECORDING`, shows pill) →
emits `recording-started` → main webview hides in-app pill, pill webview renders controls
(or self-heals via `get_recording_state`). `stop_recording` / tray stop →
`set_recording_active(app,false)` (after the pill shows "Saving…") → window hides; both
webviews + tray update. `recording-error` → `set_recording_active(app,false)` + frontend toast.

### Error & failure propagation
Command boundaries stay `Result<_, String>` per `CLAUDE.md`. `pill_window` helpers return `()`
and log on failure (never panic, never block recording). Missing pill window → no-op, but the
`CloseRequested` guard makes "missing because closed" unreachable. `recording-error` is now
surfaced (was silently swallowed).

### State lifecycle risks
Two webviews each hold their own `recordingState`, reading one global Rust state via 500ms
`get_recording_state` polling + broadcast events + the on-show self-heal. Stop is idempotent
(shared `recordingState.stop()` mirrors the `RecordingControls.svelte:115-117` guard; note the
guard string is brittle because the Rust early-return returns `Ok(())`, the shared helper
centralizes this). Rapid start/stop is serialized by `IS_RECORDING` + the recording-manager
mutex; Tauri `show/hide` are idempotent.

### API surface parity
Both control surfaces invoke the shared `recordingState` action methods, so a future control
is added once. The tray remains a third surface calling the same commands.

### Integration test scenarios
1. Start → pill appears; tab to another app → pill stays on top; stop from pill → "Saving…" →
   pill hides.
2. Pause from pill → main + tray reflect paused; resume from main → pill reflects recording.
3. Hide main window to tray mid-recording → pill remains visible and functional; stop from
   tray → pill hides.
4. macOS fullscreen Space → pill floats above a fullscreen app (bundled build).
5. `recording-error` mid-recording → pill hides and an error toast appears.
6. `Cmd+W` on the pill → pill hides, reappears on next recording.
7. Idle app for 6+ minutes, then record → pill shows correct live state (throttling/self-heal).
8. Monitor the pill is on disconnects mid-recording → pill relocates to a connected display.

## Acceptance Criteria

### Functional
- [ ] A separate OS window shows the recording pill **only** while a recording is active
      (recording or paused, plus the brief "Saving…" state), and is hidden otherwise.
- [ ] The pill floats above all other OS windows, including across macOS Spaces and above
      fullscreen apps (verified in a bundled build).
- [ ] The pill window is frameless, transparent-background, and absent from the taskbar/dock
      **and** Alt+Tab (Windows).
- [ ] The pill is laid out **vertically** with ≥44px control hit targets.
- [ ] Pause/resume and stop work from the pill and stay in sync with the main window and tray.
- [ ] The in-app pill is suppressed during active recording (D4); starting is still possible.
- [ ] On stop, the pill shows a non-interactive "Saving…" state and hides on session
      completion, not on raw `recording-stopped`.
- [ ] Stop is idempotent across pill, main window, and tray (no double-stop error shown).
- [ ] On `recording-error`, the pill hides and the error `user_message()` is surfaced.
- [ ] Exactly one pill window exists; concurrent start attempts are rejected idempotently and
      never create a second pill.
- [ ] The pill never appears before onboarding completes, nor for dictation bursts (D7).
- [ ] A stray close (`Cmd+W`) hides the pill; it reappears on the next recording.

### Non-functional
- [ ] Showing or clicking the pill never steals focus from the foreground app
      (`focus:false` + Windows `WS_EX_NOACTIVATE`).
- [ ] Pause/stop are reachable via a global keyboard shortcut while recording (the pill is
      non-focusable); buttons have `aria-label`s and the timer is `aria-live`.
- [ ] Bars and enter/exit transitions degrade to static + fade under `prefers-reduced-motion`.
- [ ] On show, the pill is positioned within a connected monitor's work area; a stale
      off-screen position falls back to default.
- [ ] No regression to existing main-window recording, tray, or navigation flows.

### Quality gates
- [ ] `pnpm -C src-svelte check` passes (svelte-check + TS).
- [ ] `cargo check` and `cargo test` pass from repo root.
- [ ] Manual verification on macOS (and Windows if available) per the integration scenarios.
- [ ] Docs updated: `CLAUDE.md` (multi-window pattern + `pill` window/capability + the
      `set_recording_active` seam), `docs/architecture.md` window/module map.

## Risk Analysis & Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| macOS not floating above fullscreen with Tauri built-ins | High | Raw `NSWindow` level + `CanJoinAllSpaces\|FullScreenAuxiliary\|Stationary` via `run_on_main_thread`, re-asserted on each show; verify in bundled build |
| Hidden pill webview throttled/unloaded before first record | High | `backgroundThrottling:"disabled"` + `get_recording_state()` self-heal on show/visibilitychange |
| Pill orphaned by stop error / `recording-error` / stray close | Med-High | Bind hide to `IS_RECORDING` transition (covers all paths); pill `CloseRequested` guard; `recording-error` listener |
| `(app)/+layout.svelte` `app.css` import breaks build after move | High (if copied) | Drop the import from the moved file; minimal root keeps the single import |
| Off-main-thread monitor/AppKit crash (#15170) | Med | All monitor + AppKit calls on the main thread; fall back to primary monitor; never panic |
| DPI mis-positioning on mixed-DPI multi-monitor (#7890/#7139) | Med | Position in logical coords using `scale_factor` + monitor `work_area` |
| Windows: pill in Alt+Tab or steals focus | Med | `WS_EX_TOOLWINDOW` + `WS_EX_NOACTIVATE` |
| Drag vs button hit-testing in an 80px pill | Med | Absolute drag underlay + `relative` interactive children; verify drag-from-unfocused (#11605) |
| Pill/in-app/tray state drift | Low | Single Rust state + broadcast + on-show self-heal + shared `recordingState` action methods |
| Jarring stop→processing gap | Low | D5 "Saving…" terminal state |

## Documentation Plan
- `CLAUDE.md`: document the `pill` window, its capability, the `set_recording_active` seam,
  and the macOS float-above-fullscreen gotcha under Architecture Notes / Gotchas.
- `docs/architecture.md`: add the second window to the window/module map.
- Update this plan's status to `done` on merge.

## Sources & References

### Internal references
- In-app pill: `app/src-svelte/src/lib/components/RecordingControls.svelte:204-337`
  (row `:205-206`; idle `:213-245`; active `:246-309`; actions `:95-154`,
  commands `:101-103,136,148`; idempotency guard `:115-117`)
- Pill visibility/render/bars: `app/src-svelte/src/routes/+page.svelte:78-82,281-305,34,143-154`
- Recording state store + poll gate: `app/src-svelte/src/lib/stores/recording-state.svelte.ts:69,73-98`
- Recording event service: `app/src-svelte/src/lib/services/recording.ts:108-167`
- Root layout (shell + `app.css` import) / SPA config: `app/src-svelte/src/routes/+layout.svelte:2,120`,
  `app/src-svelte/src/routes/+layout.ts`, `app/src-svelte/svelte.config.js`, `app/src-svelte/src/app.css:87-88`
- Long stop/processing/saving flow: `app/src-svelte/src/lib/hooks/use-recording-stop.svelte.ts`
- Design tokens: `app/src-svelte/src/app.css:5-35`
- Window config + capabilities + `macOSPrivateApi`: `app/src-tauri/tauri.conf.json:13-25,26,40-80`
- Tauri version/features: `app/src-tauri/Cargo.toml:160,175` (tauri 2.6.2, `macos-private-api`)
- Recording flag/emit/error sites: `app/src-tauri/src/audio/recording_commands/mod.rs`
  (`IS_RECORDING` true `:368`, started emits `:418,:611`, stop early-`Ok` `:644`, stop `Err`
  `:683`, `IS_RECORDING` false `:996`, stopped `:1024`, paused `:1058`, resumed `:1093`,
  error `:345,:539`, second-start guard `:460`)
- Window accessor / show-hide precedent: `app/src-tauri/src/tray.rs:79,152,394-414`
- `CloseRequested` + builder + command registration: `app/src-tauri/src/lib.rs:764-983,1219-1230`
- macOS main-thread AppKit pattern (critical):
  `docs/solutions/runtime-errors/appkit-off-main-thread-crash-meeting-detection-20260620.md`;
  example `app/src-tauri/src/dictation/inject.rs`
- Dictation lifecycle (D7 boundary): `app/src-tauri/src/dictation/commands.rs`
- Prior indicator discussion: `docs/plans/2026-06-18-001-feat-dual-mode-and-prior-art-expansion-plan.md` (U7),
  `TODOs.md:181-182`

### External references
- Tauri v2 config (`WindowConfig` keys, `macOSPrivateApi`, `backgroundThrottling`):
  https://v2.tauri.app/reference/config/ and
  https://docs.rs/tauri-utils/2.6.2/tauri_utils/config/struct.WindowConfig.html
- Tauri `WebviewWindow` API: https://docs.rs/tauri/2.6.2/tauri/webview/struct.WebviewWindow.html
- Tauri capabilities/permissions: https://v2.tauri.app/security/capabilities/ ,
  https://v2.tauri.app/reference/acl/core-permissions/
- Window customization / `data-tauri-drag-region`: https://v2.tauri.app/learn/window-customization/
- Float above fullscreen: Tauri #11488 https://github.com/tauri-apps/tauri/issues/11488 ,
  #5793 https://github.com/tauri-apps/tauri/issues/5793
- Drag-region caveats: #9901 https://github.com/tauri-apps/tauri/issues/9901 ,
  #11605 https://github.com/tauri-apps/tauri/issues/11605
- Monitor/DPI: #3057 https://github.com/tauri-apps/tauri/issues/3057 ,
  #7890 https://github.com/tauri-apps/tauri/issues/7890 ,
  #15170 https://github.com/tauri-apps/tauri/issues/15170
- AppKit collection behavior: https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct
- Win32 extended styles (`WS_EX_TOOLWINDOW`/`NOACTIVATE`):
  https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles
- SvelteKit advanced routing (route groups, `@` reset): https://svelte.dev/docs/kit/advanced-routing
- SvelteKit SPA / adapter-static: https://svelte.dev/docs/kit/single-page-apps ,
  https://svelte.dev/docs/kit/adapter-static
- WCAG target size (44px): https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html
- prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
