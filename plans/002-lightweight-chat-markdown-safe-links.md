# Plan 002: Replace chat TipTap rendering and secure external links

> **Executor instructions**: Follow every step and verification gate. Stop on a
> listed condition. Mark this plan DONE in `plans/README.md` when complete.
>
> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/components/ChatBar/ChatSurface.svelte app/src-svelte/src/lib/components/Editor.svelte app/src-svelte/package.json app/src-svelte/pnpm-lock.yaml`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-chat-mention-characterization-tests.md`
- **Category**: perf, security, bug
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

`ChatSurface.svelte` renders every assistant bubble with a full read-only TipTap
`Editor`. While streaming, each token updates `value`; `Editor.svelte` calls
`setContent` with the entire accumulated response, repeatedly reparsing a growing
document. Markdown links also use native anchors instead of the existing validated
`open_external_url` OS-browser path.

## Current state

- `ChatSurface.svelte:315`: `<Editor value={message.content} editable={false} compact />`.
- `Editor.svelte:239-243`: every changed `value` calls `loadContent(value)` and TipTap `setContent`.
- `chat.svelte.ts:89-95` and `global-chat.svelte.ts:85-90` append each token then replace with authoritative full text.
- `app/src-tauri/src/api/meetings.rs:799-804` validates HTTP(S) URLs and opens them through the OS.
- UI conditionals must use `cn()` and semantic tokens; reuse `Button` only for actual controls.

## Scope

**In scope**:
- `app/src-svelte/src/lib/components/ChatBar/ChatSurface.svelte`
- New `app/src-svelte/src/lib/components/MarkdownContent.svelte`
- New Markdown parsing/sanitizing helper and tests under `app/src-svelte/src/lib/`
- `app/src-svelte/package.json` and its lockfile only if a parser is genuinely required
- `app/src-svelte/src/lib/components/Editor.svelte` only to remove chat-only `compact` support if unused afterward

**Out of scope**:
- Changing editable notes/summary behavior
- Rendering raw HTML from Markdown
- Supporting non-HTTP URL schemes
- Rust changes to the external URL validator

## Git workflow

- Work on `main`; preserve unrelated edits.
- Commit: `perf(app): render chat markdown without tiptap`
- Do not push.

## Steps

### Step 1: Build a read-only Markdown surface

Create `MarkdownContent.svelte` with typography matching the compact TipTap prose
(headings, paragraphs, ordered/unordered lists, strong/emphasis, blockquotes,
inline/fenced code, and links). Prefer an already-transitive, maintained parser only
if it has a direct import contract; otherwise add one small parser with nub. Disable
raw HTML or sanitize to a strict element/attribute allowlist. Never use an unsanitized
`{@html}` sink.

**Verify**: unit tests prove literal HTML/script input is rendered as text or removed,
and common Markdown structures produce the expected safe output.

### Step 2: Intercept links through the validated command

Prevent native navigation. For an HTTP(S) Markdown link, call
`commands.openExternalUrl(url)` and show a dismissible error toast on rejection,
matching `EventRow.svelte:onJoin`. Reject/leave inert every other scheme.

**Verify**: tests cover HTTPS, HTTP, relative, `javascript:`, and malformed links.

### Step 3: Switch assistant bubbles and remove chat-only TipTap mode

Render assistant content with `MarkdownContent`. Keep user messages plain text.
Remove `compact` from `Editor.svelte` if no remaining caller uses it. Preserve copy,
rerun, streaming, bubble width, and semantic color tokens.

**Verify**: `rg -n "editable=\{false\} compact|tiptap-prose-compact" app/src-svelte/src` returns no matches.

### Step 4: Run gates

**Verify**: frontend test, check, lint, and format:check commands all exit 0.

## Test plan

- Parser tests: paragraphs, nested emphasis, ordered/unordered lists, fenced code,
  links, escaped HTML, malformed/incomplete streaming Markdown.
- Link tests: only HTTP(S) reaches the command boundary.
- Extend Plan 001 chat tests to ensure partial Markdown does not crash rendering logic.

## Done criteria

- [ ] Chat no longer instantiates TipTap per assistant message.
- [ ] No unsanitized model output reaches `{@html}`.
- [ ] Links cannot navigate the webview and use the validated OS-browser command.
- [ ] Streaming and final authoritative replacement still work.
- [ ] All frontend gates pass.

## STOP conditions

- The proposed parser enables raw HTML by default and cannot disable it.
- Safe rendering requires a broad sanitizer/runtime dependency without review.
- Any editable Editor behavior would need to change beyond removing `compact`.

## Maintenance notes

Plan 006 will add timestamp actions to this component. Keep its API extensible with
a narrow optional callback rather than embedding meeting-store knowledge.

