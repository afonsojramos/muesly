---
title: "feat: Transcript timestamp display toggle and copy with/without timestamps"
type: feat
status: completed
date: 2026-07-17
---

# feat: Transcript timestamp display toggle and copy with/without timestamps

## Summary

Add a persistent show/hide toggle for the timestamp gutter in the transcript view (the gutter already renders; this makes it a user preference, default ON), and add the ability to copy the transcript with or without timestamps. The with/without option is implemented once in the shared markdown formatter and threaded through both copy paths: the transcript panel's copy button follows the display preference (copy what you see), and the meeting actions menu offers both variants explicitly.

---

## Problem Frame

Transcripts always render and copy with `[mm:ss]` timestamps today. Users who want a clean prose transcript (to paste into notes, emails, or docs) have no way to hide the gutter or strip the time prefixes from copied text.

---

## Assumptions

*This plan was authored in pipeline mode without synchronous user confirmation. The items below are agent inferences that fill gaps in the input — review them as bets, not authoritative decisions.*

- "Show timestamps" is interpreted as a show/hide preference for the existing timestamp gutter (timestamps already display today; default ON preserves current behavior).
- Copy semantics: the transcript panel's copy button follows the visible display preference (the toggle sits right next to it); the meeting actions menu gets two explicit items ("Copy transcript with timestamps" / "Copy transcript without timestamps") since no toggle is visible there.
- Markdown file export keeps timestamps unconditionally — the user asked about copying, not export.
- The toggle lives only in the transcript panel header, not in the settings page — it sits directly adjacent to the content it controls, matching the copy button's placement. (Note: `showConfidenceIndicator` is not a usable precedent for discoverability — it is vestigial; its only consumer is the unimported `TranscriptView.svelte` and its toggle setter has no UI. The placement decision stands on its own merits.)

---

## Requirements

- R1. Users can show or hide timestamps in the transcript view (live and saved meetings), and the choice persists across app restarts.
- R2. Users can copy the transcript with timestamps (current output shape preserved).
- R3. Users can copy the transcript without timestamps — all time prefixes stripped, including the wall-clock fallback used by legacy rows that lack `audio_start_time`.
- R4. Defaults preserve current behavior: timestamps shown, copy output unchanged when timestamps are on, markdown export output byte-identical.
- R5. Copy feedback (toasts) and analytics are preserved; the success toast names the mode when timestamps are stripped, and analytics gain a `timestamps: on|off` property so the split is measurable.

---

## Scope Boundaries

- Markdown file export keeps timestamps unconditionally — no export-format option.
- No settings-page entry for the preference; the panel-header toggle is the only control.
- No change to `format-transcript-for-llm.ts` (it already has its own `includeTimestamps` option for chat prompts).
- No keyboard shortcuts for the copy variants.
- Pre-existing divergences stay as-is (out of scope): the drop-up's saved-mode copy uses the 10000-row fetch while the actions-menu copy fetches all rows; legacy rows display `[00:00]` in the view (`audio_start_time ?? 0`) but fall back to wall-clock in copy; display-side stop-word cleaning is not applied to copied text.

---

## Context & Research

### Relevant Code and Patterns

- `app/src-svelte/src/lib/components/VirtualizedTranscriptView.svelte` — the single transcript renderer for live and saved meetings (verified: its only host is `TranscriptDropup`). Already renders the timestamp gutter: a `<span>` with `formatRecordingTime(segment.timestamp)` that is also the `Tooltip.Trigger` for the confidence indicator.
- `app/src-svelte/src/lib/components/ChatBar/TranscriptDropup.svelte` — hosts the view; header has the copy button (Tooltip + ghost `Button` `size="icon-sm"` snippet pattern to mirror for the new toggle). Saved-mode copy uses `transcriptMarkdownBody`; live mode delegates to the live store.
- `app/src-svelte/src/lib/format-transcript-markdown.ts` + `format-transcript-markdown.test.ts` — shared pure formatter used by copy-transcript AND markdown export; injected `formatTime(start, wallClock)` handles the legacy wall-clock fallback. This is where the `timestamps` option belongs (parity precedent from the speaker-labels-in-export plan, which explicitly rejected parallel formatters).
- `app/src-svelte/src/lib/hooks/use-copy-operations.svelte.ts` — `handleCopyTranscript`, `transcriptMarkdownBody`, `fetchAllTranscripts`, `fetchSpeakerContext`; used by the MeetingDetailsView actions menu and export.
- `app/src-svelte/src/lib/stores/transcript.svelte.ts` — live store; `copyTranscript()` (line ~118) has its own duplicate `[MM:SS] text` line builder.
- `app/src-svelte/src/lib/stores/config.svelte.ts` — localStorage-backed boolean preference pattern: `showConfidenceIndicator = $state(readLocalBoolean(...))` + `toggleConfidenceIndicator` setter with `writeLocalBoolean`.
- `app/src-svelte/src/lib/components/MeetingDetails/MeetingDetailsView.svelte` — actions `DropdownMenu` with the "Copy transcript" item (line ~633).
- `app/src-svelte/src/lib/utils/format-time.ts` — `formatRecordingTimestamp(seconds)`, the canonical `[MM:SS]` formatter.
- Precedent for an optional-timestamps flag: `app/src-svelte/src/lib/format-transcript-for-llm.ts` (`includeTimestamps?: boolean`).

### Institutional Learnings

- Speaker-labels-in-export plan (`docs/plans/2026-07-11-003-feat-speaker-labels-in-export-plan.md`, shipped): keep one shared pure formatter tested with vitest; the wall-clock fallback is load-bearing (was a review finding); don't introduce ad-hoc segment mappings (a past `speaker_id` regression came from one).
- Residual review findings (`docs/residual-review-findings/named-speaker-attribution.md`): the meeting-details page refetches transcripts on `diarization-complete`/`retranscription-complete` — display state must be store-owned to survive refetch. No frontend component-test harness exists; only pure logic gets vitest coverage.
- WKWebView gotcha (project memory): never use opacity transitions for reveals; verify compositing-sensitive CSS in the real app.
- bits-ui gotcha (project memory): controlling open state requires `bind:open`; composing Tooltip with menu triggers needs care.

### External References

- None — strong local patterns exist; external research skipped.

---

## Key Technical Decisions

- **The toggle is a persistent user preference, not a rollout flag**: localStorage-backed in `config.svelte.ts` like `showConfidenceIndicator`, default `true`. The repo's "ship it on, no flags" convention targets staged rollouts, not genuine user preferences.
- **One formatter option, defaulting to `true`**: `timestamps?: boolean` on `FormatTranscriptMarkdownOptions`. Default-true protects the markdown export (which shares `transcriptMarkdownBody`) from silently losing timestamps; an explicit test pins this.
- **"Without timestamps" strips every time form**: both the `audio_start_time`-derived `[mm:ss]` and the wall-clock fallback string. Line building branches inside the formatter (not via an empty `formatTime`) so no leading-space artifacts.
- **Copy-what-you-see in the panel, explicit variants in the menu**: the panel copy button follows the display preference (the toggle is adjacent, and native text selection already copies what's rendered); the actions menu — where no toggle is visible — offers both variants with self-describing labels. The panel button's tooltip reflects the current mode (e.g. "Copy transcript (without timestamps)").
- **Hide by conditional render (`{#if}`), not CSS**: keeps native selection-copy consistent with what's visible and sidesteps known WKWebView compositing quirks.
- **Confidence tooltip is unavailable while timestamps are hidden — accepted**: the timestamp span is the sole trigger for the confidence tooltip. Hiding the gutter hides it. Documented in a code comment so it isn't rediscovered as a bug.
- **No window CustomEvent for the new preference**: `toggleConfidenceIndicator` dispatches a React-era `confidenceIndicatorChanged` event; runes reactivity makes that unnecessary. Don't copy that part of the pattern.

---

## Open Questions

### Resolved During Planning

- Should copy respect the display toggle or be an explicit choice? — Both, by surface: panel copy follows the toggle; actions menu offers both variants explicitly.
- Does hiding timestamps lose the confidence tooltip? — Yes; accepted and documented (it is the app's only confidence surface, but its only live consumer today is this tooltip).
- Where does the with/without logic live? — In the shared pure formatter, so copy and export cannot drift.

### Deferred to Implementation

- Exact tooltip wording for the toggle and the state-aware copy button.

---

## Implementation Units

### U1. Add a `timestamps` option to the shared markdown formatter

**Goal:** `formatTranscriptMarkdown` and `transcriptMarkdownBody` accept `timestamps?: boolean` (default `true`); when `false`, lines carry no time prefix of any form.

**Requirements:** R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `app/src-svelte/src/lib/format-transcript-markdown.ts`
- Modify: `app/src-svelte/src/lib/hooks/use-copy-operations.svelte.ts` (thread the option through `transcriptMarkdownBody`)
- Test: `app/src-svelte/src/lib/format-transcript-markdown.test.ts`

**Approach:**
- Add `timestamps?: boolean` to `FormatTranscriptMarkdownOptions`, defaulting to `true`. When `false`, push `row.text.trimEnd()` without calling `formatTime` — branch inside the formatter so there is no leading-space artifact.
- Speaker turn labels (`**Label**` lines) are unaffected by the option.
- `transcriptMarkdownBody(rows, ctx, options?)` forwards the option; existing callers (export) stay untouched and keep timestamps by default.

**Patterns to follow:**
- `format-transcript-for-llm.ts` `includeTimestamps` option shape; existing exact-string test style in `format-transcript-markdown.test.ts`.

**Test scenarios:**
- Happy path: default options → output identical to today's shape (`[mm:ss] text` lines, `**Label**` turn lines) — pins R4.
- Happy path: `timestamps: false` with speaker context → label lines intact, body lines are bare text with no leading space.
- Edge case: `timestamps: false` with no speaker data → plain text lines only.
- Edge case: `timestamps: false` on a legacy row (`audio_start_time` undefined, wall-clock `timestamp` set) → wall-clock string does NOT appear — pins R3.
- Edge case: empty rows array → empty string (both option values).
- Integration/regression: `transcriptMarkdownBody` called without options (the export path) emits timestamps — pins "export unchanged".

**Verification:**
- `nub --cwd app/src-svelte run test` passes; the default-options snapshot test proves existing copy/export output is unchanged.

---

### U2. Optional timestamps in the live-transcript copy

**Goal:** The live store's `copyTranscript` can emit lines without the `[MM:SS]` prefix.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Create: `app/src-svelte/src/lib/format-live-transcript.ts` (small pure line builder)
- Modify: `app/src-svelte/src/lib/stores/transcript.svelte.ts`
- Test: `app/src-svelte/src/lib/format-live-transcript.test.ts`

**Approach:**
- Extract the live copy's line building into a pure function (rows + `timestamps: boolean` → text) so it is vitest-testable without compiling `.svelte` modules. Preserve current semantics exactly when timestamps are on: `formatRecordingTimestamp(audio_start_time)` with the `[--:--]` fallback for undefined.
- `copyTranscript(options?: { timestamps?: boolean })` delegates to it; default `true`.
- Keep relying on the drop-up's disabled button for the empty case (no new empty-guard).

**Patterns to follow:**
- `app/src-svelte/src/lib/utils/format-time.ts` for the canonical formatter; colocated `*.test.ts` convention.

**Test scenarios:**
- Happy path: timestamps on → `[MM:SS] text` lines joined with newlines (today's shape).
- Happy path: timestamps off → bare text lines, no leading space.
- Edge case: row with undefined `audio_start_time`, timestamps on → `[--:--]` prefix; timestamps off → no prefix.

**Verification:**
- `nub --cwd app/src-svelte run test` passes; live copy output with timestamps on is byte-identical to before the change.

---

### U3. Persisted `showTranscriptTimestamps` preference

**Goal:** A store-owned, localStorage-persisted boolean preference, default `true`.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `app/src-svelte/src/lib/stores/config.svelte.ts`

**Approach:**
- `showTranscriptTimestamps = $state(readLocalBoolean('showTranscriptTimestamps', true))` plus a `toggleTranscriptTimestamps(checked)` setter that writes via `writeLocalBoolean` — mirroring `showConfidenceIndicator`/`toggleConfidenceIndicator`, but without the legacy window CustomEvent dispatch.

**Patterns to follow:**
- `showConfidenceIndicator` in the same file.

**Test scenarios:**
- Test expectation: none — mirrors the existing `readLocalBoolean`/`writeLocalBoolean` pattern with no behavioral logic beyond assignment; covered by manual verification in U4.

**Verification:**
- Preference round-trips through localStorage (toggle, reload app, state preserved) — verified manually as part of U4.

---

### U4. Timestamp gutter toggle in the transcript panel

**Goal:** A toggle button in the transcript drop-up header shows/hides the timestamp gutter for both live and saved transcripts.

**Requirements:** R1

**Dependencies:** U3

**Files:**
- Modify: `app/src-svelte/src/lib/components/VirtualizedTranscriptView.svelte`
- Modify: `app/src-svelte/src/lib/components/ChatBar/TranscriptDropup.svelte`

**Approach:**
- `VirtualizedTranscriptView` gains a `showTimestamps` prop (default `true`). The gutter block (the `Tooltip.Provider` wrapping the timestamp span) is conditionally rendered with `{#if showTimestamps}` — conditional render, not CSS hiding, so native selection-copy matches what's visible. Add a code comment noting the confidence tooltip is intentionally unavailable while timestamps are hidden.
- `TranscriptDropup` renders the toggle in the header's `ml-auto` cluster next to the copy button, following the existing Tooltip + snippet-child pattern, with a proper `aria-label`, wired to `config.showTranscriptTimestamps` / `toggleTranscriptTimestamps`. Pass `showTimestamps={config.showTranscriptTimestamps}` to the view.
- Use the `ui/toggle` primitive (not a plain ghost `Button`) so the on state gets its built-in pressed styling (`data-[state=on]` background), making the current mode legible at a glance without hovering the tooltip. Pair it with a clock icon (e.g. lucide `Clock`), keeping the same icon-button sizing as the adjacent copy button.
- Store-owned state survives the `diarization-complete`/`retranscription-complete` refetch remounts by construction. The toggle stays enabled during recording (mid-recording toggle is a pure render change; windowing and auto-scroll are unaffected).

**Patterns to follow:**
- The copy button's Tooltip + `Button variant="ghost" size="icon-sm"` snippet pattern in the same header; semantic tokens only; `cn()` for conditional classes.

**Test scenarios:**
- Test expectation: none — UI glue with no component-test harness in this repo; behavior is covered by the manual verification below.

**Verification:**
- Manual, in the real app (WKWebView, not just Chromium): gutter hides/shows instantly in live and saved modes; preference survives drop-up close/reopen and app restart; toggling mid-recording doesn't break auto-scroll or windowing; summary-chip timestamp jump still scrolls and highlights the target segment with the gutter hidden; mic-row right-alignment shift on toggle is acceptable.

---

### U5. Copy surfaces: follow the preference, offer explicit variants

**Goal:** The panel copy button copies according to the display preference; the meeting actions menu offers explicit with/without items; analytics record the mode.

**Requirements:** R2, R3, R5

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `app/src-svelte/src/lib/components/ChatBar/TranscriptDropup.svelte`
- Modify: `app/src-svelte/src/lib/hooks/use-copy-operations.svelte.ts`
- Modify: `app/src-svelte/src/lib/components/MeetingDetails/MeetingDetailsView.svelte`
- Modify: `app/src-svelte/src/lib/analytics.ts` (optional properties parameter on `trackButtonClick`)

**Approach:**
- `TranscriptDropup.copyTranscript()`: saved mode passes `{ timestamps: config.showTranscriptTimestamps }` to `transcriptMarkdownBody`; live mode passes the same option to `liveTranscripts.copyTranscript`. The button's tooltip (and `aria-label`) reflects the mode, e.g. "Copy transcript" vs "Copy transcript (without timestamps)".
- `handleCopyTranscript(options?: { timestamps?: boolean })` in `use-copy-operations.svelte.ts` threads the option to `transcriptMarkdownBody`; default `true`.
- `MeetingDetailsView` actions menu: replace the single "Copy transcript" item with "Copy transcript with timestamps" and "Copy transcript without timestamps". "Copy transcript with timestamps" keeps the original item's list position (preserving today's muscle-memory click), with the "without" variant immediately below it. Both are self-describing since no toggle is visible in that menu.
- Analytics: `Analytics.trackButtonClick` in `app/src-svelte/src/lib/analytics.ts` currently accepts no properties object, so extend it with an optional third parameter (extra properties merged into the tracked event); the drop-up passes `{ timestamps: 'on' | 'off' }` for both live and saved copies. The hook's `Analytics.track('copy', ...)` gains the same property directly.
- Toasts: the success toast states the mode when timestamps are stripped — "Transcript copied (without timestamps)" — and stays "Transcript copied to clipboard" for timestamped copies, so a misclick on the adjacent menu item is catchable. Toasts remain dismissible per repo convention.

**Patterns to follow:**
- Existing `DropdownMenu.Item onSelect` items with lucide icons in `MeetingDetailsView.svelte`; the bits-ui `bind:open` gotcha if any new overlay composition is introduced (prefer not to introduce any).

**Test scenarios:**
- Formatter-level behavior is covered by U1/U2 tests. UI wiring below is manual:
- Happy path: panel copy with preference ON → clipboard matches today's output; preference OFF → no time prefixes anywhere in the clipboard text.
- Happy path: menu "with timestamps" → header + dated, timestamped body; "without timestamps" → same header, body without any time prefix.
- Edge case: meeting with legacy rows (no `audio_start_time`) copied without timestamps → no wall-clock strings in the body.
- Integration: markdown export after all changes → file still contains timestamps.

**Verification:**
- Manual clipboard inspection for the four paths above in the real app; `nub --cwd app/src-svelte run check`, `lint`, and `test` all pass.

---

## System-Wide Impact

- **Interaction graph:** `VirtualizedTranscriptView` has exactly one host (`TranscriptDropup`), so the header toggle covers every transcript render. `transcriptMarkdownBody` is shared by drop-up copy, menu copy, and markdown export — the default-true option plus the U1 regression test protect the export path.
- **Error propagation:** unchanged — transcript-fetch failures already surface via error toasts ("Failed to fetch transcripts"); clipboard writes themselves are currently unguarded (pre-existing, fire-and-forget), and this plan does not change that. No new failure modes introduced.
- **State lifecycle risks:** the preference is store-owned (config store), so it survives transcript refetches triggered by `diarization-complete`/`retranscription-complete` and view remounts.
- **API surface parity:** the live store's copy is a separate formatter — U2 threads the same option so the two paths don't diverge in capability. `format-transcript-for-llm.ts` is intentionally untouched.
- **Integration coverage:** the export-keeps-timestamps scenario is the one cross-surface behavior unit tests must pin (U1).
- **Unchanged invariants:** markdown export output; LLM prompt formatting; transcript-link pool in MeetingDetailsView; summary-chip → segment jump behavior; copy toasts.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Shared-formatter option silently changes markdown export | Option defaults to `true`; explicit no-options regression test in U1 |
| "Copy transcript" meaning differs between panel (preference-driven) and menu (explicit) | State-aware tooltip on the panel button; both menu items self-describing |
| WKWebView rendering quirks on show/hide | Conditional render (`{#if}`), no opacity transitions; manual verification in the real app |
| Hiding the gutter removes the confidence tooltip (its only trigger) | Accepted deliberately; code comment documents it |

---

## Documentation / Operational Notes

- No existing docs describe transcript copy behavior (verified by search), so no doc updates are required. `docs/transcription-flows.md` covers pipelines, not view-level display, and is unaffected.

---

## Sources & References

- Related code: `app/src-svelte/src/lib/format-transcript-markdown.ts`, `app/src-svelte/src/lib/components/VirtualizedTranscriptView.svelte`, `app/src-svelte/src/lib/components/ChatBar/TranscriptDropup.svelte`, `app/src-svelte/src/lib/hooks/use-copy-operations.svelte.ts`, `app/src-svelte/src/lib/stores/transcript.svelte.ts`, `app/src-svelte/src/lib/stores/config.svelte.ts`, `app/src-svelte/src/lib/components/MeetingDetails/MeetingDetailsView.svelte`
- Prior art: `docs/plans/2026-07-11-003-feat-speaker-labels-in-export-plan.md` (shipped; established the shared formatter and its parity rationale)
- Institutional learnings: `docs/residual-review-findings/named-speaker-attribution.md`
