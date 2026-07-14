# Plan 001: Add chat and mention characterization tests

> **Executor instructions**: Follow every step and verification gate. If a STOP
> condition occurs, report it instead of improvising. When complete, mark this
> plan DONE in `plans/README.md` and commit the implementation.
>
> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/stores/chat.svelte.ts app/src-svelte/src/lib/stores/global-chat.svelte.ts app/src-svelte/src/lib/components/ChatBar/ChatSurface.svelte app/src-svelte/src/lib/components/Editor.svelte`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

Chat streaming, cancellation, persisted-history races, Markdown presentation, and
inline mentions have no frontend regression coverage. These are high-churn stateful
paths; characterization tests must land before the renderer and interaction changes
in later plans.

## Current state

- `app/src-svelte/src/lib/stores/chat.svelte.ts:55-215` owns per-meeting streaming, cancellation, loading, and clearing.
- `app/src-svelte/src/lib/stores/global-chat.svelte.ts:47-135` implements a similar global stream.
- `app/src-svelte/src/lib/components/Editor.svelte:111-172` embeds mention matching, filtering, keyboard selection, and insertion inside the Svelte component.
- Existing pure Vitest patterns live in `app/src-svelte/src/lib/bars/execution.test.ts` and `app/src-svelte/src/lib/speaker-label.test.ts`.
- Frontend verification uses nub: `nub --cwd app/src-svelte run test/check/lint/format:check`.

## Scope

**In scope**:
- `app/src-svelte/src/lib/stores/chat.svelte.ts`
- `app/src-svelte/src/lib/stores/global-chat.svelte.ts`
- `app/src-svelte/src/lib/components/Editor.svelte`
- New pure helper modules under `app/src-svelte/src/lib/chat/` or `app/src-svelte/src/lib/editor/`
- Matching `*.test.ts` files beside those helper modules

**Out of scope**:
- Rust chat commands and migrations
- Visual redesigns
- Installing browser-test libraries or adding dependencies

## Git workflow

- Work on `main`; preserve unrelated working-tree changes.
- Commit: `test(app): cover chat streams and participant mentions`
- Do not push.

## Steps

### Step 1: Extract pure state-transition helpers

Extract only the deterministic pieces needed for testing: chat event reduction,
mention query/range matching, suggestion filtering, and keyboard index movement.
Keep Svelte runes and Tauri Channels in their current owners. The components/stores
must call the extracted helpers so tests exercise production logic, not copies.

**Verify**: `nub --cwd app/src-svelte run check` exits 0 with no diagnostics.

### Step 2: Add focused Vitest coverage

Cover token append, authoritative `done.full`, stale generation rejection, error
preservation, mention activation after `@`, query filtering, Escape, wraparound
ArrowUp/ArrowDown, Enter/Tab selection, and no activation for email-like embedded
`@`. Include an empty-participant case.

**Verify**: `nub --cwd app/src-svelte run test` exits 0 and the new tests pass.

### Step 3: Run complete frontend gates

**Verify**:
- `nub --cwd app/src-svelte run check`
- `nub --cwd app/src-svelte run lint`
- `nub --cwd app/src-svelte run format:check`

All exit 0.

## Done criteria

- [ ] Production chat/mention code consumes the tested pure helpers.
- [ ] Tests cover every named transition and edge case above.
- [ ] No new dependency was added.
- [ ] All frontend gates pass.
- [ ] Only in-scope files plus `plans/README.md` changed.

## STOP conditions

- In-scope code differs materially from the drift excerpts.
- Testing requires DOM emulation or a new dependency; report before adding one.
- Extracting helpers would change public component/store behavior.

## Maintenance notes

Later plans should extend these tests rather than create component-private duplicate
logic. Review especially that the extracted reducers do not mutate stale messages.

