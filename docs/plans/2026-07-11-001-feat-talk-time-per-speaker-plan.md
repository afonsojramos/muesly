---
date: 2026-07-11
status: active
type: feat
topic: talk-time-per-speaker
reviewed: 2026-07-11
---

# feat: Talk-Time per Speaker

## Summary

Show a per-meeting "who spoke how much" breakdown: a compact stacked bar plus a legend (name, minutes, percent) at the top of the transcript tab. Speech totals are aggregated **in SQL on the backend** (durations are persisted per segment), so the result is complete regardless of how many transcript pages the UI has loaded; the frontend resolves bucket labels through the same `SpeakerContext` the transcript labels use. Also fixes a live regression this plan's review uncovered: the paginated saved-meeting view drops `speaker_id`, which currently disables named-speaker labels there.

---

## Problem Frame

Every transcript segment persists `duration` (and start/end times) plus a speaker (`mic` = you; `system` + diarized `speaker_id` = a remote cluster, named via `speaker_names`). The UI shows *who said what*, but nothing aggregates *who dominated the conversation* — a headline insight in Granola-class tools that the data model already pays for.

A frontend-only aggregation was considered and rejected by review: the saved-meeting view loads segments in pages of 100 on scroll (`use-paginated-transcripts.svelte.ts`), so any computation over loaded segments is silently partial for exactly the meetings where talk-time matters. Aggregate where the data lives.

## Requirements

- R1. A talk-time breakdown is visible on a saved meeting's transcript tab, showing each speaker's share (visual bar) and absolute speaking time, computed over the **entire** meeting regardless of transcript pagination state.
- R2. Buckets are: "You" (mic side, or the self name when known), each named/`Speaker N` cluster, and one "Other participants" bucket for undiarized system speech. Labels must match the transcript's labels exactly (same names, same contiguous Speaker numbering).
- R3. The breakdown hides when it carries no signal: while recording, when there is no timed speech, or when only a single bucket has speech.
- R4. Renames update the breakdown immediately (label resolution stays frontend-side over the same `SpeakerContext`).
- R5. The paginated saved-meeting view carries `speaker_id` on its segments, restoring named-speaker labels and the assign picker there (regression fix; independent of the new feature but a precondition for R2's "match the transcript" to be meaningful).

## Scope Boundaries

- No persistence of computed stats — the SQL aggregate runs per open.
- No cross-meeting aggregation (People-linkage plan's territory).
- No live (during-recording) talk-time; post-meeting only, matching the labels.
- No per-speaker drill-down interactions (click-to-filter transcript) — display only.

## Key Technical Decisions

- **Backend SQL aggregate, frontend labeling.** New command returns, per `(speaker, speaker_id)` group: total speech seconds and the group's first `audio_start_time`. Grouping in SQL over indexed columns (`idx_transcripts_meeting_id`) is O(segments) once; the payload is a handful of rows. Labels are NOT resolved backend-side — the frontend maps groups through `SpeakerContext` so renames apply instantly (R4) and numbering matches `buildDisplayIndex` semantics.
- **Display numbering from `first_start` ordering.** The transcript numbers clusters by first appearance in segment order; the aggregate's `MIN(audio_start_time)` per cluster reproduces exactly that ordering without shipping segments to the frontend. The pure helper sorts by `first_start` to assign `Speaker N` indices.
- **Duration source: `duration`, falling back to `end − start` when duration is NULL or ≤ 0** (legacy chunk rows wrote `duration = 0.0` with zeroed times — review finding; the CASE expression treats those as no-signal rather than valid zeros).
- **Bar colors: one accent hue, stepped opacity.** CLAUDE.md forbids raw palette colors and the semantic token set has too few distinct tones for N speakers. Decision: "You" = `bg-accent`, remote buckets = `bg-accent` at a stepped opacity ramp (e.g. /70, /50, /35, /25), "Other participants" = `bg-muted-foreground/30`. Distinguishability beyond ~5 speakers is accepted as degraded (legend carries the precision).
- **Pure helper + colocated vitest** (`speaker-label.ts` pattern) for the stats→buckets mapping; the component stays dumb.

## Implementation Units

### U1. Fix `speaker_id` loss in the paginated segments mapping

**Goal:** The saved-meeting view's segments carry `speaker_id`, restoring named labels and the assign picker there.

**Requirements:** R5

**Dependencies:** none

**Files:**
- `app/src-svelte/src/lib/hooks/use-paginated-transcripts.svelte.ts` (`toSegments`)
- `app/src-svelte/src/lib/hooks/use-paginated-transcripts.test.ts` (new, or extend if one exists)

**Approach:** Add the missing `speaker_id: t.speaker_id` to the mapping (the backend rows already include it). Add a regression test pinning the full field mapping so the next added field can't silently vanish the same way.

**Patterns to follow:** existing hook structure; vitest colocated-test convention.

**Test scenarios:**
- A `Transcript` row with `speaker: 'system', speaker_id: 2` maps to a segment carrying both.
- A row with `speaker_id: null`/absent maps without inventing a value.

**Verification:** vitest passes; opening a diarized meeting shows named labels and the picker again (they are currently dead in this view).

---

### U2. Backend talk-time aggregate command

**Goal:** Return complete per-speaker-group speech totals for a meeting.

**Requirements:** R1

**Dependencies:** none

**Files:**
- `app/src-tauri/src/database/repositories/transcript.rs` (aggregate query)
- `app/src-tauri/src/api/meetings.rs` or `app/src-tauri/src/diarization/commands.rs` (command — implementer picks the module that reads better; the data is transcript-shaped, the consumer is speaker UI)
- `app/src-tauri/src/lib.rs` (register)
- `app/src-svelte/src/lib/bindings.ts` (regenerated)

**Approach:** Repository method returning rows of `{ speaker: Option<String>, speaker_id: Option<i64>, seconds: f64, first_start: Option<f64> }` grouped by `(speaker, speaker_id)` for one meeting, using the duration CASE fallback from Key Technical Decisions. Thin `#[tauri::command]` wrapper (`Result<_, String>` at the boundary) returning a specta-typed struct list. Regenerate bindings via the export test.

**Patterns to follow:** `distinct_speaker_ids` in the same repository (query shape, doc comment); `get_meeting_speakers` for command/struct/specta conventions.

**Test scenarios:**
- Happy path: mic 30 s + cluster 0 90 s + cluster 1 10 s → three groups with correct seconds and `first_start` reflecting first appearance order.
- Duration fallback: NULL duration with valid start/end contributes `end − start`; `duration = 0.0` with zeroed times contributes nothing.
- Undiarized system speech groups under `(system, NULL)`.
- Empty meeting → empty list.
- Segments with no timing at all are excluded rather than poisoning totals.

**Verification:** Rust integration tests (in-memory pool + real migrations) pass; export test regenerates bindings containing the new command.

---

### U3. `talk-time.ts` pure helper

**Goal:** Map backend groups + `SpeakerContext` to labeled, sorted buckets.

**Requirements:** R2, R4

**Dependencies:** U2 (types)

**Files:**
- `app/src-svelte/src/lib/talk-time.ts` (new)
- `app/src-svelte/src/lib/talk-time.test.ts` (new)

**Approach:** `buildTalkTimeBuckets(groups, ctx) -> { label, seconds, fraction }[]`: mic group → self label ("You"/self name); system groups with a cluster → assigned name from `ctx.names`, else `Speaker N` with N assigned by ascending `first_start` (mirroring `buildDisplayIndex` semantics); `(system, NULL)` → "Other participants". Sort buckets by seconds desc; `fraction` = seconds / total. Export `formatSeconds` for the legend.

**Patterns to follow:** `app/src-svelte/src/lib/speaker-label.ts` + test file.

**Test scenarios:**
- Label parity: sparse cluster ids `{1,3}` with first_starts ordering `3 before 1` → "Speaker 1" is cluster 3 (first appearance), matching transcript numbering.
- Assigned name overrides the `Speaker N` fallback; rename reflected by passing an updated ctx.
- Self name present → that name; absent → "You".
- "Other participants" bucket appears only when the NULL-cluster group has seconds.
- Fractions sum to ~1; empty input → empty output; single bucket returned as-is (hiding is the component's call).
- `formatSeconds`: 0s, 59s, 60s, 3599s, 2h-scale.

**Verification:** vitest passes.

---

### U4. `TalkTimeBar.svelte` + SidePanel mount

**Goal:** Render the breakdown on the transcript tab.

**Requirements:** R1, R3, R4

**Dependencies:** U2, U3

**Files:**
- `app/src-svelte/src/lib/components/MeetingDetails/TalkTimeBar.svelte` (new)
- `app/src-svelte/src/lib/components/MeetingDetails/SidePanel.svelte` (mount)

**Approach:** Component takes `meetingId` and `speakerContext`; fetches the aggregate via the new command on mount / meetingId change (and re-fetches when the transcript's cluster signature changes, same trigger the speaker context uses); derives buckets via U3. Renders the stacked bar (color scheme per Key Technical Decisions) + legend chips `name · 12m · 43%`, with a tooltip carrying exact seconds. Hide per R3: `!isRecording`, ≥ 2 buckets, total seconds > 0. Mount above `TranscriptButtonGroup` in the transcript tab block.

**Patterns to follow:** `use-speaker-context.svelte.ts` for the fetch-on-meeting-change + stale-guard shape (reuse its genId pattern if extracted, otherwise keep the component's fetch trivially guarded); semantic tokens + `cn()`.

**Test scenarios:** bucket logic is U3-tested; fetch wiring is IPC glue. `Test expectation: none beyond U3 — presentation + fetch glue; verified manually on a diarized meeting.`

**Verification:** `pnpm check`/`lint` clean; a >100-segment diarized meeting shows a complete bar immediately on open (no scrolling required — the R1 regression the review caught); renames relabel the legend instantly; hidden while recording and on single-speaker notes.

---

## System-Wide Impact

- One new read-only IPC command + repository method; no schema change.
- U1's regression fix restores existing shipped behavior (named labels in saved view) — flag it in the commit message as a fix, not part of the feature.
- SidePanel gains a component mount; no layout restructuring.

## Deferred to Follow-Up Work

- Cross-meeting talk-time per person (People-linkage plan).
- Talk-time line in markdown export (export plan may consume U3 once both land).
- Interruption/overlap analytics (needs turn-taking analysis).
- Click-a-bucket to filter/jump the transcript.
