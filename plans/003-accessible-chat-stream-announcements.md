# Plan 003: Announce completed chat responses accessibly

> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/components/ChatBar/ChatSurface.svelte`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-chat-mention-characterization-tests.md`
- **Category**: bug
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

The entire message list is currently `aria-live="polite"` while assistant content
changes token by token. Screen readers can announce fragments continuously and then
repeat the final answer. Visual streaming should remain, but assistive output should
announce concise state and the completed response once.

## Current state

- `ChatSurface.svelte:158-164` reacts to every last-message content change.
- `ChatSurface.svelte:281` places the complete list inside `aria-live="polite" aria-atomic="false"`.
- `controller.isStreaming` is already available and distinguishes progress from completion.

## Scope

**In scope**: `ChatSurface.svelte` and a focused helper/test if needed.

**Out of scope**: changing visible streaming, stores, or backend events.

## Git workflow

- Work on `main`.
- Commit: `fix(app): announce chat responses accessibly`
- Do not push.

## Steps

1. Remove live-region semantics from the token-mutating conversation container.
2. Add a visually hidden status region that announces `Thinking…` once when streaming
   starts and a concise completion message when it ends. If announcing full completed
   content, do so once and avoid duplicating user turns.
3. Preserve visible thinking/empty labels and auto-scroll.

**Verify**: `nub --cwd app/src-svelte run test && nub --cwd app/src-svelte run check && nub --cwd app/src-svelte run lint && nub --cwd app/src-svelte run format:check` exits 0.

## Test plan

Extend Plan 001 helpers/tests with idle → streaming → done and idle → streaming →
error transitions. Assert token events do not create announcement changes.

## Done criteria

- [ ] No token-mutating container has `aria-live`.
- [ ] Streaming start and terminal state have accessible announcements.
- [ ] Visible chat behavior is unchanged.
- [ ] All frontend gates pass.

## STOP conditions

- Meeting/global chat expose insufficient terminal state to distinguish completion
  from cancellation; report the smallest store API required before changing it.

## Maintenance notes

Test with VoiceOver on macOS during a long local-model response before release.

