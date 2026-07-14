# Plan 006: Add clickable transcript citations to chat answers

> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/components/ChatBar app/src-svelte/src/lib/components/MarkdownContent.svelte app/src-svelte/src/lib/transcript-link.ts app/src-tauri/src/summary/chat.rs app/src-tauri/src/summary/global_chat.rs`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-lightweight-chat-markdown-safe-links.md`
- **Category**: direction
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

Meeting chat answers are grounded in transcripts but provide no evidence trail. The
repository already turns `[mm:ss]` tokens into transcript jumps in summaries/notes.
Requiring lightweight timestamp citations makes answers more trustworthy and lets users
jump directly to what was said.

## Current state

- `app/src-svelte/src/lib/transcript-link.ts` links/unlinks `[mm:ss]` Markdown tokens.
- `Editor.svelte` accepts `onTimestampClick` and detects a clicked token.
- `ChatSurface.svelte` is shared by per-meeting and global chat; global answers may span
  meetings and therefore cannot use a single-meeting timestamp without an identity.
- `summary/chat.rs:382-383` builds the per-meeting prompts.

## Scope

**In scope**:
- `app/src-tauri/src/summary/chat.rs` prompt and tests
- Plan 002 `MarkdownContent.svelte` and tests
- Per-meeting `ChatBar.svelte`/`ChatSurface.svelte` callback plumbing
- Existing transcript navigation store/hook used by saved and live views

**Out of scope**:
- Global multi-meeting citations (defer until citations encode meeting id)
- Semantic vector search, source cards, or transcript retrieval changes
- Inventing timestamps when the transcript context lacks them

## Git workflow

- Work on `main`.
- Commit: `feat(app): link chat answers to transcript timestamps`
- Do not push.

## Steps

1. Confirm the transcript text supplied to per-meeting chat includes timestamps. If it does
   not, extend only the context formatter to include recording-relative `[mm:ss]` tokens.
2. Update the per-meeting system/user prompt to request citations for factual claims when a
   supporting timestamp exists, while explicitly allowing uncited conversational answers.
3. Teach `MarkdownContent` to recognize timestamp tokens separately from external links and
   call an optional `onTimestampClick(seconds)` callback.
4. Route the callback through per-meeting ChatBar to the existing transcript jump behavior.
   Do not enable it in GlobalChatBar.

**Verify**:
- `cargo test -p muesly summary::chat` passes.
- Frontend test/check/lint/format gates pass.

## Test plan

- Rust prompt test asserts citation instruction and untrusted-context protection coexist.
- Frontend parser tests cover `[00:05]`, `[12:34]`, invalid seconds, external links, and
  absence of a callback.
- Navigation test/helper asserts the correct seconds value is emitted.

## Done criteria

- [ ] Per-meeting grounded answers can render clickable timestamp citations.
- [ ] Clicking jumps through the existing transcript navigation path.
- [ ] Global chat does not create ambiguous single-meeting timestamp links.
- [ ] Rust and frontend gates pass.

## STOP conditions

- Transcript context has no stable recording-relative timestamps and adding them requires a
  database migration.
- Existing navigation cannot target a timestamp from the shared layout without broad state changes.

## Maintenance notes

Global citations should later use a compound meeting-id + timestamp source identifier, not
reuse the per-meeting token format.

