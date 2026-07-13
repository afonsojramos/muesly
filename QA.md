# Manual QA — Floating recording pill window

The floating pill is a native, always-on-top, transparent OS window. It cannot be
exercised by the unit/type/lint checks or by browser automation, so it needs a real
**bundled build** (`nub run tauri:build`, or `nub run tauri:dev` for most checks) on a machine
with a display and microphone/screen-recording permissions granted.

> macOS gotcha (from CLAUDE.md): `nub run tauri:dev` binaries attribute TCC permissions to the
> terminal, and the float-above-fullscreen behaviour only re-asserts reliably in a bundled
> build. Verify the fullscreen/Spaces items (✱) on a bundled build, not just dev.

Tick each item. File a bug for anything that fails.

## Core behaviour
- [ ] Idle (not recording): no floating pill is visible anywhere on screen.
- [ ] Start a recording from the main window → the floating pill appears (bottom-center).
- [ ] The pill is laid out **vertically**: elapsed timer on top, then pause/resume, then stop, then level bars.
- [ ] The elapsed timer counts up and matches the recording duration (±1s).
- [ ] Level bars animate while recording and go flat/steady when paused.
- [ ] Stop the recording from the pill → the pill disappears.

## "Only visible when active" + in-app handoff (D4)
- [ ] While recording, the in-app bottom pill in the main window is hidden (the floating pill is the control surface).
- [ ] After stopping, the main window's idle/start pill returns.
- [ ] The pill is never visible during onboarding (start is unreachable pre-onboarding).
- [ ] A dictation / hold-to-talk burst does **not** show the pill (it is meeting-recording only).

## Always-on-top / float (the headline behaviour)
- [ ] Tab to another app (e.g. your meeting app) → the pill stays visible on top.
- [ ] ✱ macOS: put another app into **fullscreen** → the pill still floats above it.
- [ ] ✱ macOS: swipe between **Spaces** → the pill is present on each Space and stays put (does not slide).
- [ ] The main app still shows its **Dock icon** (we did not switch to accessory activation).
- [ ] Windows: the pill is **absent from the taskbar** (known gap: it may still appear in Alt+Tab — `WS_EX_TOOLWINDOW` is a TODO).

## Controls sync across surfaces (the P1 area)
- [ ] **Stop from the pill saves the meeting**: stop from the pill, then confirm the meeting is saved (appears in the sidebar / SQLite) and the main window navigates to it / shows the success toast — even if the main window was hidden to the tray.
- [ ] Pause from the pill → the main window and tray menu reflect "paused".
- [ ] Resume from the main window (or tray) → the pill reflects "recording".
- [ ] Stop from the **tray** while the pill is up → the pill disappears and the meeting saves.
- [ ] Global shortcut `Cmd/Ctrl+Shift+Space` toggles pause/resume while recording (and does nothing when not recording).
- [ ] There is no global stop shortcut (intentional): stop is only via the pill button or the tray.

## Interaction / appearance
- [ ] The pill background is transparent (only the rounded pill shape is visible, no square OS shadow behind it).
- [ ] Drag the pill body → it moves; the pause/stop buttons remain clickable (not swallowed by the drag region).
- [ ] Showing or clicking the pill does **not** steal keyboard focus from the foreground app.
- [ ] Buttons are comfortable to hit (≈44px) and have correct tooltips/aria labels.
- [ ] With **Reduce Motion** enabled (System Settings): bars are static and a "Recording"/"Paused" label shows instead of the animation; the pill fades rather than slides.

## Robustness / edge cases
- [ ] **Stray close**: focus the pill and press `Cmd+W` → the pill hides (is not destroyed) and reappears on the next recording.
- [ ] **Idle-then-record**: leave the app idle 6+ minutes, then start a recording → the pill shows the correct live state immediately (no blank/stale pill; background-throttle self-heal works).
- [ ] **Recording error**: if a recording fails mid-session (e.g. device unplugged), the pill disappears and an error toast appears in the main window.
- [ ] **Multi-monitor**: the pill appears on the monitor under the cursor, anchored above the Dock/taskbar (not flush, not off-screen).
- [ ] **Monitor disconnect**: disconnect the display the pill is on mid-recording → it returns on a connected display on the next show (best-effort).
- [ ] **Quit mid-recording**: quitting the app during a recording leaves no orphaned pill window.
- [ ] Rapid start/stop a few times → exactly one pill window exists; no duplicates, no flicker-stuck pill.

## Cross-cutting regression
- [ ] Main-window recording, transcript panel, and saving still work exactly as before.
- [ ] Tray show/hide of the main window still works; `/settings` and `/meeting-details` still navigate (route-group refactor did not break routing).
- [ ] Dark mode: the pill renders with the warm-paper tokens (not a broken/transparent-text look).

## Known follow-ups (not blockers, track separately)
- Windows `WS_EX_TOOLWINDOW` / `WS_EX_NOACTIVATE` (out of Alt+Tab, no focus steal) — currently a no-op stub.
- Persist the pill's last dragged position across recordings.
- Tune the macOS window level if it overlaps the menu bar / is undesirable in screenshots.
- Optional: a brief "Saving…" pill state between stop and save-complete (deferred; main window shows status today).
