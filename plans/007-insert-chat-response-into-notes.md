# Plan 007: Insert assistant responses into meeting notes

> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/components/ChatBar app/src-svelte/src/lib/stores/notes.svelte.ts app/src-svelte/src/lib/components/Editor.svelte app/src-svelte/src/routes/'(app)'/note/+page.svelte app/src-svelte/src/lib/components/MeetingDetails/NotesView.svelte`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-lightweight-chat-markdown-safe-links.md`, `plans/004-reliable-chat-clear.md`
- **Category**: direction
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

Assistant answers often contain durable decisions or action items, but the only current
action is copying raw Markdown. “Insert into notes” closes that workflow without clipboard
round-trips and keeps the inserted result editable and exportable.

## Current state

- `ChatSurface.svelte:323-349` renders Copy and optional Rerun actions.
- `app/src-svelte/src/lib/stores/notes.svelte.ts` owns live note Markdown.
- `note/+page.svelte:125-129` renders the live `Editor` from the notes store.
- Saved meeting notes persist through `MeetingDetails/NotesView.svelte` and its `onSave` contract.
- ChatSurface is shared with global chat, where no single target meeting note exists.

## Scope

**In scope**:
- `ChatSurface.svelte` optional action snippet/callback API
- Per-meeting `ChatBar.svelte`
- Live notes store and editor imperative insertion API
- Saved meeting notes component/store callback path
- Focused tests

**Out of scope**:
- Global chat insertion
- Automatic insertion without user action
- Rewriting/summarizing the assistant response
- Database schema changes

## Git workflow

- Work on `main`.
- Commit: `feat(app): insert chat responses into meeting notes`
- Do not push.

## Steps

1. Define an optional per-assistant-message action in ChatSurface, rendered beside Copy using
   the existing shadcn `Button`, semantic tokens, `data-icon`, and a minimum 40px hit area.
   Label it accessibly as “Insert response into notes.” Do not render it in GlobalChatBar.
2. Add one canonical Markdown append/insert operation. Preserve existing note content, insert
   exactly one blank-line boundary, avoid duplicate insertion on double click, and retain the
   assistant Markdown unchanged except any UI-only citation markup defined by Plan 006.
3. For live notes, update the notes store and focused TipTap document without triggering the
   external-value reload loop. For saved notes, use `NotesView`'s existing debounced save path
   and surface pending/error truthfully.
4. Disable the action while insertion/save is pending. Do not show a success toast when the
   visible notes update is the confirmation; use a dismissible toast only on failure.

**Verify**: frontend test/check/lint/format gates all exit 0.

## Test plan

- Empty notes, existing notes, trailing newline normalization, Markdown preservation,
  double-click idempotence, save failure rollback/retry, and global-chat absence.
- Use the Plan 001 pure-helper approach; do not add a browser-test dependency solely for this.

## Done criteria

- [ ] Per-meeting assistant responses have an Insert into notes action.
- [ ] Global chat does not show the action.
- [ ] Live and saved notes visibly update and persist through their existing paths.
- [ ] Failure retains the original notes and permits retry.
- [ ] All frontend gates pass.

## STOP conditions

- Saved and live note insertion require two incompatible public formats.
- Correct saved-note persistence requires bypassing `NotesView`'s save contract.
- Insertion would overwrite concurrent user edits.

## Maintenance notes

Keep the insertion operation Markdown-first. Future structured blocks should migrate both
chat export and notes persistence together rather than special-case this action.

