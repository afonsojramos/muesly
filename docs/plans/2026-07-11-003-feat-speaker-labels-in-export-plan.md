---
date: 2026-07-11
status: active
type: feat
topic: speaker-labels-in-export
---

# feat: Speaker Labels in Markdown Export and Copy

## Summary

Carry the named-speaker labels into the text that leaves the app: the copy-transcript action gains turn-grouped `**You** / **Ana** / **Speaker 2**` labels, and the markdown export gains a labeled `## Transcript` section after the summary. One shared pure formatter keeps the exported labels identical to the UI's.

---

## Problem Frame

Research established the current state precisely: `handleExportMarkdown` (`MeetingDetailsView.svelte`) exports **title + AI summary only** — no transcript at all; `handleCopyTranscript` (`use-copy-operations.svelte.ts`) copies `[mm:ss] text` lines with **no speaker labels**; the live store's `copyTranscript` likewise. Meanwhile the chat feature already built `format-transcript-for-llm.ts`, which resolves labels — but with LLM-oriented fallbacks ("Me"/"Them") that don't match the UI ("You"/"Speaker N"). So today, a beautifully attributed transcript degrades to anonymous text the moment it's copied or exported.

**Prerequisite:** the uncommitted polish batch (which includes `format-transcript-for-llm.ts` changes) should land first to avoid edit collisions.

## Requirements

- R1. Copy-transcript output labels speech by speaker, grouped by turn (label shown at speaker changes, not on every line), with timestamps preserved.
- R2. "Export as Markdown" includes a `## Transcript` section with the same turn-grouped labels, after the summary.
- R3. Exported/copied labels are byte-identical to the UI's labels: self name or "You"; assigned name; else "Speaker N" with the UI's contiguous numbering; undiarized system speech gets no label but keeps its text.
- R4. Meetings with no speaker data degrade to today's output shape (timestamped lines, no labels) — never `undefined` or empty labels.

## Scope Boundaries

- The LLM formatter (`format-transcript-for-llm.ts`) is not changed — chat prompts keep their "Me"/"Them" vocabulary; export mirrors the UI instead. Unifying the two formatters is deferred.
- No export-format settings/toggles (per repo convention: ship it on, no flags).
- The live-recording store's `copyTranscript` is out of scope — during recording there are no diarized labels yet, only me/them, and that surface is transient.
- No PDF/HTML export.

## Key Technical Decisions

- **New pure formatter `format-transcript-markdown.ts` built on `speakerLabelFor`/`buildSpeakerRows`** rather than extending the LLM formatter. Rationale: R3 demands UI parity, and the LLM formatter cannot deliver it even with parameterization — it prints raw, non-contiguous, 0-based `Speaker ${speaker_id}`, which can never match the UI's contiguous 1-based numbering from `buildDisplayIndex`; changing that would alter chat-prompt output. `speaker-label.ts` is the single source of truth the UI already uses.
- **Timestamp fallback is preserved.** Today's copy path prints the wall-clock string when `audio_start_time` is missing (`formatTime(t.audio_start_time, t.timestamp)`). The new formatter's injected `formatTime` receives `(startSeconds, wallClockFallback)` so legacy segments keep printing their wall-clock time instead of degrading to `[00:00]` (review finding). The segment mapping therefore carries the wall-clock string alongside the numeric timestamp.
- **The segment mapping must include `speaker_id`.** The copy path's own fetch returns full backend rows including it; the identical mapping in `use-paginated-transcripts.svelte.ts` already forgot this field once (live regression, fixed by the talk-time plan's U1). Prefer sharing one `transcriptToSegment` helper with that fix rather than writing a third ad-hoc mapping.
- **One quirk of `buildSpeakerRows` is intentional-by-parity:** an undiarized segment resets the previous-label tracker, so a speaker resuming after an unlabeled interruption re-shows their label. This matches the rendered UI; tests must encode it, and the implementer must not "fix" it here.
- **Turn-grouped markdown shape** (directional, not prescriptive): a bold label line at each speaker change (`**Ana** [03:12]`), followed by that turn's lines; unlabeled turns fall back to the bare `[mm:ss] text` form. Exact spacing is an execution-time detail.
- **Export fetches what the copy path fetches.** `handleExportMarkdown` currently only gathers the summary; it will reuse the same full-segment fetch (`api_get_meeting_transcripts` paging loop) and speaker context (`getMeetingSpeakers`, already called in the same component for attendee chips) that the copy path uses.

## Implementation Units

### U1. `format-transcript-markdown.ts` pure formatter

**Goal:** Turn segments + `SpeakerContext` into labeled, turn-grouped markdown text.

**Requirements:** R1, R3, R4

**Dependencies:** none

**Files:**
- `app/src-svelte/src/lib/format-transcript-markdown.ts` (new)
- `app/src-svelte/src/lib/format-transcript-markdown.test.ts` (new)

**Approach:** `formatTranscriptMarkdown(segments, ctx, { formatTime }) -> string`. Reuse `buildSpeakerRows` for the turn boundaries and labels; emit a label line at each `show` row, plain timestamped lines within a turn. With an empty context (no names, no clusters), every row is unlabeled → output is the legacy `[mm:ss] text` list (R4).

**Patterns to follow:** `app/src-svelte/src/lib/format-transcript-for-llm.ts` (sibling formatter, same input shapes); `speaker-label.ts` helpers for resolution.

**Test scenarios:**
- Turn grouping: mic, mic, system(0), mic → three label lines, second mic line unlabeled beneath the first.
- Label parity: assigned name overrides; sparse cluster ids render contiguous "Speaker N" matching `buildDisplayIndex`.
- R4 degradation: no speaker data at all → pure `[mm:ss] text` lines, no bold labels, no blank label artifacts.
- Undiarized system turn between labeled turns keeps its text without inventing a label — and the next labeled turn re-shows its label even when it's the same speaker (parity with `buildSpeakerRows`' actual reset behavior).
- Empty segments → empty string.
- Timestamps flow through the injected `formatTime(startSeconds, wallClockFallback)`; a legacy segment with no `audio_start_time` prints its wall-clock string, not `[00:00]`.

**Verification:** vitest passes; output for a diarized fixture visually matches the UI's labeling when pasted.

---

### U2. Wire into copy-transcript

**Goal:** `handleCopyTranscript` emits the labeled format.

**Requirements:** R1, R4

**Dependencies:** U1

**Files:**
- `app/src-svelte/src/lib/hooks/use-copy-operations.svelte.ts`

**Approach:** After the existing full-segment fetch, also fetch `getMeetingSpeakers(meetingId)` (tolerating failure → empty context, R4), map segments to `TranscriptSegmentData`, and delegate the body to `formatTranscriptMarkdown`, keeping the existing header (`# Transcript of the Meeting…`, date).

**Patterns to follow:** the hook's existing fetch/format structure; `use-speaker-context.svelte.ts` for the `MeetingSpeakers → SpeakerContext` mapping (extract that small mapping into `speaker-label.ts` if it would otherwise be duplicated — implementer's judgment).

**Test scenarios:**
- Covers R4. Speaker fetch fails or returns empty → copied text equals today's unlabeled shape (assert via the pure formatter's empty-context path; the hook itself is IPC glue).

**Verification:** copying a diarized meeting yields labeled turns; copying an undiarized meeting is unchanged; `pnpm check`/`lint` clean.

---

### U3. Add labeled `## Transcript` section to markdown export

**Goal:** Exported `.md` = title + summary + labeled transcript.

**Requirements:** R2, R3

**Dependencies:** U1

**Files:**
- `app/src-svelte/src/lib/components/MeetingDetails/MeetingDetailsView.svelte` (`handleExportMarkdown`)

**Approach:** Extend the contents assembly: after `summaryMarkdown`, append `\n\n## Transcript\n\n` + `formatTranscriptMarkdown(...)` when segments exist. Fetch segments with the same paging loop the copy hook uses (share the fetch helper rather than duplicating it — extraction location is an execution-time choice). A meeting with zero segments exports summary-only, exactly as today.

**Patterns to follow:** `handleExportMarkdown`'s current structure; `use-copy-operations.svelte.ts` for the full-fetch loop.

**Test scenarios:**
- Zero-segment meeting exports byte-identically to today's output (no empty `## Transcript` heading).
- (Manual) exported file for a diarized meeting shows summary then labeled transcript; file still saves via the native dialog path.

**Verification:** `pnpm check`/`lint` clean; manual export of one diarized and one summary-only meeting.

---

## System-Wide Impact

- Frontend-only; the backend `api_export_meeting_markdown` save helper is untouched (it just writes the string it's given).
- Export output grows for long meetings (full transcript). Accepted: export is user-initiated and markdown compresses well; no size gate.
- Copy-transcript output format changes for consumers who paste into other tools — the new shape is a superset (labels added, timestamps kept).

## Deferred to Follow-Up Work

- Unify `format-transcript-for-llm.ts` and the new formatter behind one resolution core once both are stable.
- A talk-time summary line in the export header (consume `computeTalkTime` from the talk-time plan when both have landed).
- Export-time inclusion toggles (transcript on/off) if users ask; not before.
