# Plan 004: Preserve chat when backend clearing fails

> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/stores/chat.svelte.ts app/src-svelte/src/lib/components/ChatBar/ChatBar.svelte`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-chat-mention-characterization-tests.md`
- **Category**: bug
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

`clearThread()` clears memory before awaiting `commands.chatClear`. If deletion fails,
the UI looks successfully cleared even though reopening the meeting restores the old
thread. Cleanup needs an honest pending state and either backend-first mutation or a
rollback snapshot.

## Current state

- `chat.svelte.ts:187-195` invalidates loads, calls `this.clear()`, then invokes the backend.
- `ChatBar.svelte` owns the confirmation dialog and already uses shadcn `Dialog`/`Button`.
- Project feedback convention: acknowledge accepted work, show honest pending state,
  and use dismissible toasts only for errors/background outcomes.

## Scope

**In scope**:
- `app/src-svelte/src/lib/stores/chat.svelte.ts`
- `app/src-svelte/src/lib/components/ChatBar/ChatBar.svelte`
- Plan 001 chat helper/tests

**Out of scope**: database schema, Rust clear command, undo history.

## Git workflow

- Work on `main`.
- Commit: `fix(app): preserve chat when clearing fails`
- Do not push.

## Steps

1. Add a reactive clearing state or make `clearThread` return success while retaining a
   snapshot. Cancel any stream first, disable repeat confirmation, and label the action
   `Clearing…` while pending.
2. Only leave the chat empty after backend success. On failure restore the exact snapshot
   if it was optimistically hidden, show the existing dismissible error toast, and keep
   the dialog/chat state coherent.
3. Guard the existing load generation so a concurrent history response cannot overwrite
   either a successful clear or restored snapshot.

**Verify**: all frontend test/check/lint/format gates exit 0.

## Test plan

Cover successful clear, backend failure rollback, double-submit prevention, stream
cancellation, and stale load completion during clear.

## Done criteria

- [ ] Failed backend deletion never loses the visible thread.
- [ ] Clear action exposes a truthful pending state.
- [ ] Success empties memory and persistence once.
- [ ] All frontend gates pass.

## STOP conditions

- The generated command wrapper can reject outside its typed result instead of returning
  `status: 'error'`; report before adding broad catch behavior.

## Maintenance notes

Any future bulk-delete action should reuse the same pending/rollback convention.

