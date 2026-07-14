# Plan 005: Keep the inline participant mention menu visible

> **Drift check (run first)**: `git diff --stat 01dc01a..HEAD -- app/src-svelte/src/lib/components/Editor.svelte app/src-svelte/src/routes/'(app)'/note/+page.svelte`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-chat-mention-characterization-tests.md`
- **Category**: bug
- **Planned at**: commit `01dc01a`, 2026-07-14

## Why this matters

The mention picker is absolutely positioned below the caret with a fixed width. The
notes page scrolls inside an overflow container, so mentions near the bottom or right
edge can be clipped. The menu should flip above the caret and clamp horizontally while
retaining keyboard focus in the editor.

## Current state

- `Editor.svelte:131-136` computes only a below-caret `top` and clamps width against the editor.
- `Editor.svelte:290-319` renders a `w-64` absolute listbox.
- `note/+page.svelte:90` is the nearest scrolling viewport.
- Existing keyboard behavior supports arrows, Enter/Tab, Escape, and mouse down.

## Scope

**In scope**: `Editor.svelte`, the Plan 001 mention-position helper/tests, and no other UI.

**Out of scope**: portaling, adding Floating UI, changing mention Markdown format, or redesigning the list.

## Git workflow

- Work on `main`.
- Commit: `fix(app): keep participant mention menu in view`
- Do not push.

## Steps

1. Extract/test a pure placement function accepting caret, menu dimensions, viewport,
   and margin. Prefer below; flip above when below lacks room; clamp left/right.
2. Measure the actual menu after render using Svelte lifecycle (`tick`) or a bound element.
   Recompute on query changes and relevant scroll/resize events; clean listeners on destroy.
3. Preserve editor focus and the 40px option hit area. Add `aria-activedescendant` wiring
   between the editor/listbox and active option if feasible without changing TipTap semantics.

**Verify**: all frontend test/check/lint/format gates exit 0.

## Test plan

Pure placement tests: below, flip-above, right clamp, left clamp, very small viewport.
Retain all Plan 001 mention matching/navigation tests.

## Done criteria

- [ ] Menu remains within the visible scroll viewport with an 8px margin.
- [ ] Placement updates during scroll/resize and cleans listeners.
- [ ] Keyboard and mouse mention insertion remain unchanged.
- [ ] All frontend gates pass.

## STOP conditions

- Correct placement cannot be achieved without a portal because an ancestor clips both
  above and below; report evidence before adding a portal/dependency.

## Maintenance notes

If other TipTap suggestion menus are added, promote the placement helper into a shared primitive.

