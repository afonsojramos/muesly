---
date: 2026-07-10
status: completed
type: feat
topic: named-speaker-attribution
origin: docs/brainstorms/2026-07-10-named-speaker-attribution-requirements.md
---

# feat: Named Speaker Attribution

## Summary

Turn muesly's existing anonymous diarization into **named, in-meeting speaker attribution**. Remote speakers are split into distinct labels, seeded from the meeting's calendar attendees, auto-filled only in the unambiguous one-remote-attendee case, and correctable inline. Your own mic side always reads "You." Diarization auto-runs after recordings tied to a calendar event with attendees (when the model is already present); the manual "Identify speakers" button stays as the fallback. Names are scoped to the meeting and persist across reopens. No voiceprints, no cross-meeting identity.

This builds almost entirely on machinery that already exists (per-source mic/system attribution, the `sherpa-onnx` diarization sidecar, the `speaker`/`speaker_id` columns, the Granola-style transcript layout). The work is closing the last mile: restricting cluster labels to the "them" side, naming clusters, rendering names, and wiring the auto-trigger.

---

## Problem Frame

muesly already separates "me vs everyone else" for free and renders it Granola-style (your mic right, others left). It also already has a full clustering diarizer behind a manual button. But the last mile is missing: the diarized cluster label only renders on *your* mic segments (`VirtualizedTranscriptView.svelte`), never on the "them" side where multiple speakers actually matter; clusters read "Speaker 2" not "Ana"; and diarization is opt-in. Reviewing a multi-person call still means reconstructing who said what from memory. This plan closes that gap.

See origin: `docs/brainstorms/2026-07-10-named-speaker-attribution-requirements.md`.

---

## Scope Boundaries

- No cross-meeting voice identity, enrollment, or voiceprints (origin: "Outside" scope).
- No live/in-progress naming of remote speakers. During recording only the existing me-vs-them split shows; named remote speakers appear post-recording.
- No meeting-platform APIs (Zoom/Meet active-speaker). Attribution stays audio-only, on-device.
- No attendee email capture. The names-only calendar invariant is preserved; the only new attendee field is a boolean `is_self` flag (no PII).
- Not building a new diarization engine. Reuses the existing `sherpa-onnx` sidecar and `speaker_id` column.

### Deferred to Follow-Up Work

- **System-only audio persistence (U-deferred).** For maximal cluster purity, persist a system-only audio file at record time (tap `DeviceType::System` before `mix_windows` in `app/src-tauri/src/audio/pipeline.rs`) and diarize that instead of the mixed file. This plan instead restricts *labeling* to system segments (see Key Technical Decisions), which delivers the same user-facing outcome on all existing recordings without touching the delicate record path. Revisit if cluster quality on overlap-heavy calls proves insufficient.
- **Persisting the local user's real display name for the mic side.** This plan labels the mic side "You" (literal) unless a self attendee name is cheaply available via the new `is_self` flag. A guaranteed real-name label for every provider is deferred.
- **Grouping/merging consecutive same-speaker segments into a single bubble** (Granola-style turn blocks). This plan shows the label only when the speaker changes from the previous segment, which gets most of the visual benefit; full bubble-merging is deferred.

---

## Key Technical Decisions

- **Restrict cluster labels to system segments; never cluster-label the mic side (Option B).** The stored `audio.mp4` is a pre-mixed mono mixdown (mic+system); no system-only stream exists on disk and recovering one is an invasive record-path change (see Deferred). Because every transcript segment already carries `speaker = "mic" | "system"`, we keep clustering on the mixed file but only write `speaker_id` onto `system` segments, and force mic segments to render "You". This fully removes the origin decision's primary risk (you being mislabeled as a remote "Speaker N") and works retroactively on all recordings. It does not achieve the origin's literal "cluster only remote audio" purity — that is the deferred system-only-file enhancement. *This is a deliberate deviation from the origin Key Decision, made on plan-time discovery that the system channel is not persisted; the user-facing outcome (R1's success criterion "the local user is never shown as a remote Speaker N") is preserved.*
- **Persist an `is_self` boolean per attendee.** Needed to (a) exclude the local user from the naming shortlist and (b) enable R4's one-remote-attendee auto-fill. Populated from the Google API's `is_self`; EventKit sets `false` (graceful: those meetings get the manual picker, no auto-fill). Old rows without the field parse as `false` via serde default. Still names-only, no email.
- **Store assigned names in a dedicated `speaker_names` table keyed on `(meeting_id, speaker_id)`.** Survives reopens, relabels every segment of a cluster, and is naturally per-meeting (R6). Cleared and recomputed on re-diarization because cluster numbering is not stable across runs.
- **Auto-fill is conservative (strict 1:1 only).** Auto-assign a name only when there is exactly one non-self attendee and exactly one distinct system cluster. Every other case shows "Speaker N" plus a one-tap attendee picker. Never guess (R4).
- **Auto-run trigger: attendee meetings, models-ready only.** After the post-stop calendar attach, if the attached event has attendees AND the diarization model is already downloaded, run diarization in the background. If the model is absent, do nothing (no silent ~35 MB download mid-flow); the manual button still offers the download. *Resolves the origin's one open question in favor of the conservative option.*
- **Display renumbering happens in the frontend.** The backend stores raw cluster ids; the view maps the distinct system cluster ids (by first appearance) to contiguous "Speaker 1..k" for display, with assigned names overriding. Keeps backend dumb and avoids renumber-on-rename churn.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

Data flow, recording stop → labeled transcript:

```
recording stop
  └─ use-recording-stop: saveMeeting → calendarAttachEvent
       └─ get_meeting_speakers(meetingId)      // returns attendee shortlist (+ self name)
            └─ if shortlist non-empty && diarizationModelsReady:
                 diarize_meeting(meetingId)  ── background
                   ├─ cluster MIXED audio via sherpa-onnx sidecar   (unchanged)
                   ├─ reconcile turns → segments, BUT set speaker_id
                   │     only where speaker == "system"   (mic → left as You)
                   ├─ clear speaker_names(meeting)         (fresh run)
                   └─ auto-fill: 1 non-self attendee & 1 cluster → set_speaker_name
       └─ transcript reload → render
```

Naming resolution per segment (view layer):

```
speaker == "mic"            → self name if known, else "You"
speaker == "system":
   speaker_id has a name    → that name
   speaker_id, no name      → "Speaker {display-index}"
   no speaker_id            → no label
```

Auto-fill decision matrix (inputs → outcome), computed in `diarize_meeting`:

| non-self attendees | distinct system clusters | outcome |
|---|---|---|
| 1 | 1 | auto-assign the attendee's name to that cluster |
| any other | any other | leave clusters unnamed ("Speaker N" + picker) |
| 0 (no calendar / EventKit self-less) | any | leave unnamed, picker uses free-text only |

---

## Implementation Units

### U1. Restrict diarization labeling to system segments

**Goal:** `diarize_meeting` writes `speaker_id` only onto `system` segments; mic segments are never cluster-labeled (and any stale `speaker_id` on them is cleared).

**Requirements:** R1, R8 (success criterion: user never shown as remote Speaker N)

**Dependencies:** none

**Files:**
- `app/src-tauri/src/database/repositories/transcript.rs` — extend `segments_for_diarization` to also return `speaker`.
- `app/src-tauri/src/diarization/commands.rs` — filter reconciliation to `speaker == "system"`; clear `speaker_id` on mic segments.
- `app/src-tauri/src/diarization/reconcile.rs` — no change expected; verify `speaker_for_segment` stays source-agnostic.
- Test: `app/src-tauri/src/diarization/commands.rs` (or a `#[cfg(test)]` module / `app/src-tauri/tests/`) using the sqlx transaction-isolation helper.

**Approach:** `segments_for_diarization` currently returns `(id, start, end)`; add `speaker`. In `diarize_meeting`, after obtaining `turns`, iterate segments: for `system` segments assign the max-overlap cluster; for `mic` segments call `set_segment_speaker_id(id, None)` to guarantee they carry no cluster. Return count of *system* segments labeled.

**Patterns to follow:** existing `diarize_meeting` reconcile loop; existing repository query style in `transcript.rs`.

**Test scenarios:**
- Covers AE1. Given a meeting with mixed mic/system segments and diarizer turns, when `diarize_meeting` runs, then only `system` segments get a non-null `speaker_id` and all `mic` segments have `speaker_id == None`.
- A mic segment that overlaps a diarizer turn is still left `None`.
- Return value equals the number of system segments that received a cluster.
- Re-running on a meeting with pre-existing stale `speaker_id` on a mic segment clears it.

**Verification:** unit/integration test passes; manually diarizing a two-person call shows clusters only on the left/system side.

---

### U2. `speaker_names` table + repository

**Goal:** Persist and read per-meeting cluster→name assignments.

**Requirements:** R5, R6

**Dependencies:** none

**Files:**
- `app/src-tauri/migrations/20260710000000_add_speaker_names.sql` (new) — `CREATE TABLE speaker_names (meeting_id TEXT NOT NULL, speaker_id INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (meeting_id, speaker_id), FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE)`.
- `app/src-tauri/src/database/setup.rs` — ensure the new migration is picked up (mirror how existing migrations register).
- `app/src-tauri/src/database/models.rs` — `SpeakerName { meeting_id, speaker_id, name }` struct.
- `app/src-tauri/src/database/repositories/speaker_names.rs` (new) + module registration in the repositories `mod`.
- Test: repository integration test with the transaction-isolation helper.

**Approach:** repo methods: `get_for_meeting(pool, meeting_id) -> Vec<SpeakerName>`, `upsert(pool, meeting_id, speaker_id, name)` (`INSERT ... ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET name = excluded.name`), `clear_for_meeting(pool, meeting_id)`. Follow the sqlx repository conventions and migration numbering already in `app/src-tauri/migrations/`.

**Patterns to follow:** `app/src-tauri/src/database/repositories/calendar.rs` (get/upsert/delete shape); existing migration files for column/table style.

**Test scenarios:**
- Covers AE5. `upsert` then `get_for_meeting` returns the name; a second `upsert` on the same `(meeting_id, speaker_id)` overwrites rather than duplicating.
- `get_for_meeting` scopes to the meeting (a name in meeting A never appears for meeting B) — enforces R6.
- `clear_for_meeting` removes only that meeting's rows.
- Deleting the meeting cascades (row gone).

**Verification:** migration applies cleanly on a fresh DB and on an upgrade; repo tests pass.

---

### U3. Persist `is_self` on attendees

**Goal:** Record which attendee is the local user so the shortlist can exclude them and auto-fill can identify the single remote attendee.

**Requirements:** R3, R4

**Dependencies:** none

**Files:**
- `app/src-tauri/src/calendar/service.rs` — add `is_self: bool` to `AttendeePayload` (serialized into `attendees_json`).
- `app/src-tauri/src/calendar/context.rs` — add `is_self` (with `#[serde(default)]`) to the read-side `AttendeeEntry`.
- `app/src-tauri/src/calendar/google.rs` — populate `is_self` from the Google DTO's `is_self` when building the persisted attendee.
- `app/src-tauri/src/calendar/eventkit.rs` — set `is_self = false` (EventKit does not expose it).
- `app/src-tauri/src/calendar/matching.rs` — add `is_self` to the domain `Attendee` if it flows through this layer.
- Test: `app/src-tauri/src/calendar/` serialization round-trip test.

**Approach:** additive, backward-compatible field. `#[serde(default)]` makes pre-existing `attendees_json` rows (no `is_self`) deserialize as `false`. No email is added — the field is a plain boolean.

**Patterns to follow:** existing `AttendeePayload`/`AttendeeEntry` serialization in `service.rs`/`context.rs`.

**Test scenarios:**
- A Google attendee with `is_self = true` round-trips through `attendees_json` as `is_self: true`.
- An old-format `attendees_json` value (`[{"name":"Ana","status":"accepted"}]`) deserializes with `is_self == false` (no error).
- An EventKit attendee serializes with `is_self == false`.

**Verification:** round-trip tests pass; no regression in existing calendar tests.

---

### U4. Naming command layer + auto-fill

**Goal:** Backend commands to read a meeting's speakers (clusters + shortlist + self name) and set a cluster's name, plus the conservative 1:1 auto-fill inside `diarize_meeting`.

**Requirements:** R3, R4, R5

**Dependencies:** U1, U2, U3

**Files:**
- `app/src-tauri/src/diarization/commands.rs` — new commands `get_meeting_speakers(meeting_id)` and `set_speaker_name(meeting_id, speaker_id, name)`; add auto-fill + `clear_for_meeting` calls into `diarize_meeting`.
- `app/src-tauri/src/database/repositories/speaker_names.rs` — used here.
- `app/src-tauri/src/database/repositories/calendar.rs` — read the attached event's attendees (`CalendarEventsRepository::get`).
- `app/src-tauri/src/database/repositories/transcript.rs` — expose the set of distinct system `speaker_id`s for a meeting (new helper) for shortlist/auto-fill.
- Test: command-level integration tests with the transaction-isolation helper.

**Approach:**
- `get_meeting_speakers` returns a struct: `{ speakers: Vec<{ speaker_id, name: Option<String> }>, shortlist: Vec<String> (non-self attendee names), self_name: Option<String> }`. `speakers` = distinct system cluster ids present in the transcript, joined with any stored name.
- `set_speaker_name` upserts into `speaker_names`.
- Auto-fill (inside `diarize_meeting`, after U1 reconciliation): `clear_for_meeting`; load attendees; `remote = attendees.filter(!is_self)`; `clusters = distinct system speaker_ids`; if `remote.len() == 1 && clusters.len() == 1` → `upsert(meeting, cluster, remote[0].name)`.

**Patterns to follow:** existing `diarize_meeting` structure; Tauri command signatures in `diarization/commands.rs` (`AppHandle`, `State<AppState>`, `Result<_, String>`).

**Test scenarios:**
- Covers AE3. One non-self attendee "Ana" + exactly one system cluster → after `diarize_meeting`, that cluster's stored name is "Ana".
- Covers AE4. Three non-self attendees + three clusters → no names auto-assigned; `get_meeting_speakers` returns all three names in `shortlist` and three unnamed speakers.
- `set_speaker_name` then `get_meeting_speakers` reflects the new name.
- `self_name` is the `is_self` attendee's name; that name is absent from `shortlist`.
- Re-running `diarize_meeting` clears prior names before auto-fill (no stale carry-over).
- Meeting with no calendar event → `shortlist` empty, `self_name` None, no auto-fill, no error.

**Verification:** integration tests pass for each matrix row.

---

### U5. Register commands + regenerate specta bindings

**Goal:** Expose the new commands to the frontend and regenerate typed bindings.

**Requirements:** enables R3, R4, R5 on the frontend

**Dependencies:** U4

**Files:**
- `app/src-tauri/src/lib.rs` — add `get_meeting_speakers` and `set_speaker_name` to `collect_commands!` in `make_specta_builder`.
- `app/src-svelte/src/lib/bindings.ts` — regenerated (not hand-edited) by running the specta export test.
- Test: the existing `specta_bindings_tests::exports_typescript_bindings` test regenerates and must pass.

**Approach:** mechanical wiring. Run the Rust test suite (specta export test) to regenerate `bindings.ts`; verify the new commands appear with correct signatures.

**Patterns to follow:** existing diarization command registration at `lib.rs` `make_specta_builder`.

**Test scenarios:** `Test expectation: none — scaffolding/registration. Covered by the specta export test compiling and emitting the two new command bindings.`

**Verification:** `cargo test` specta binding test passes; `bindings.ts` contains `getMeetingSpeakers` and `setSpeakerName`.

---

### U6. Frontend speaker store + label derivation

**Goal:** Load per-meeting speaker names, expose a names map, and derive each segment's display label; update on rename.

**Requirements:** R3, R7, R8

**Dependencies:** U5

**Files:**
- `app/src-svelte/src/lib/stores/transcript.svelte.ts` — load `get_meeting_speakers` on meeting open; hold `{ names: Map<number,string>, selfName?: string, shortlist: string[] }`; expose an `assignName(speakerId, name)` action that calls `set_speaker_name` and updates local state.
- `app/src-svelte/src/lib/speaker-label.ts` (new) — pure `speakerLabelFor(segment, ctx)` returning the display string, plus a helper mapping distinct system `speaker_id`s → contiguous 1-based display indices.
- `app/src-svelte/src/lib/types.ts` — types for the speaker context if needed.
- Test: `app/src-svelte/src/lib/speaker-label.test.ts` (vitest) for the pure functions.

**Approach:** keep label logic pure and unit-tested (mirrors the existing `coming-up.ts` + `coming-up.test.ts` split). Renumbering: collect distinct system `speaker_id`s in first-appearance order → index+1.

**Patterns to follow:** `app/src-svelte/src/lib/coming-up.ts` (pure helper + colocated vitest); existing store patterns in `transcript.svelte.ts`.

**Test scenarios:**
- `mic` segment → "You" when no self name; → self name when provided (R3).
- `system` segment with a stored name → that name.
- `system` segment with a cluster but no name → "Speaker N" using the contiguous display index, not the raw `speaker_id` (e.g. raw ids {1,2} render "Speaker 1"/"Speaker 2").
- `system` segment with no `speaker_id` → empty label.
- `assignName` updates the map so the same cluster's other segments resolve to the new name.

**Verification:** vitest passes; opening a diarized meeting shows names/Speaker N on the correct sides.

---

### U7. Render labels on the "them" side + rename/assign picker

**Goal:** Show the speaker label on the system side (fixing the mis-gated label), and let the user assign/rename a cluster inline from the attendee shortlist or free text.

**Requirements:** R4, R5, R7, R8

**Dependencies:** U6

**Files:**
- `app/src-svelte/src/lib/components/VirtualizedTranscriptView.svelte` — render the label for the non-me side; show it only when the speaker changes from the previous segment; preserve the me-right/them-left layout.
- `app/src-svelte/src/lib/components/SpeakerLabel.svelte` (new) — the label plus a `Popover` + `Command` combobox listing the shortlist and a free-text create option; on select calls the store's `assignName`.
- Test: `app/src-svelte/src/lib/components/` — light component/interaction test where practical; the option-computation logic is covered by U6's pure tests.

**Approach:** reuse the existing `Popover` + `Command` combobox pattern already used in `EventRow.svelte` (folder picker) for the attendee shortlist + create-new. Gate the click affordance to system segments with a `speaker_id`. Keep the mic side non-interactive ("You").

**Patterns to follow:** `app/src-svelte/src/lib/components/home/EventRow.svelte` (Popover + Command picker with a free-text create item); shadcn primitives under `app/src-svelte/src/lib/components/ui/{popover,command}`.

**Test scenarios:**
- Covers AE5. Assigning "Bruno" to a "Speaker 2" cluster relabels every segment of that cluster and persists across a store reload.
- The label renders on the left (system) side and not repeated on consecutive same-speaker segments.
- The mic side shows "You" and exposes no picker.
- The picker lists the shortlist names and offers a free-text "create" for a name not in the list.

**Verification:** `pnpm check` + `pnpm lint` clean; manual walkthrough in dev shows inline rename working and persisting.

---

### U8. Auto-run diarization for attendee meetings

**Goal:** After a recording tied to a calendar event with attendees stops, run diarization in the background when the model is already present.

**Requirements:** R2

**Dependencies:** U5 (needs `get_meeting_speakers`), U4

**Files:**
- `app/src-svelte/src/lib/hooks/use-recording-stop.svelte.ts` — after `calendarAttachEvent`, call `get_meeting_speakers`; if `shortlist` non-empty and `diarizationModelsReady()` is true, fire `diarizeMeeting` in the background (best-effort, non-blocking) and refresh the transcript on completion.
- Test: covered by manual/e2e verification (hook orchestration); the gating decision is simple enough to assert via a small extracted predicate if practical.

**Approach:** best-effort side effect; never block the stop flow or surface a hard error if diarization fails. Skip silently when the model is absent (the manual button still offers the download). Reuse the existing post-attach side-effect block.

**Patterns to follow:** the existing post-save side effects in `use-recording-stop.svelte.ts` (the `calendarGetContextEnabled` → `calendarAttachEvent` block).

**Test scenarios:**
- Covers AE1. Recording tied to an event with attendees + models ready → `diarizeMeeting` is invoked after attach.
- Covers AE2. Solo recording with no attendees → `diarizeMeeting` is not invoked; manual path still available.
- Models not ready → no invocation, no download prompt, no error surfaced.

**Verification:** manual: record a short attendee-linked call with models present → reopening shows split, labeled speakers without pressing the button; a solo note does not auto-diarize.

---

## System-Wide Impact

- **Audio record path:** untouched (deliberate — Option B). Removes the largest risk surface.
- **Database:** one additive migration (`speaker_names`) + one additive JSON field (`is_self`) with backward-compatible defaults.
- **Backend commands:** two new Tauri commands; `diarize_meeting` behavior changes (system-only labeling + auto-fill). Bindings regenerated.
- **Calendar layer:** attendee persistence gains `is_self`; no email, invariant preserved.
- **Frontend:** transcript store + view changes; one new label/picker component. Existing me/them layout preserved.
- **Actors (origin):** local user (A1) reviews/corrects; remote participants (A2) are the clusters named; calendar integration (A4) supplies the shortlist; diarization sidecar (A3) unchanged.

---

## Risk Analysis & Mitigation

- **Cluster pollution from the mic voice in the mixed file** (residual of Option B). Mitigation: labels only ever land on system segments, so the worst case is a slightly noisier cluster count, never a mislabeled "You." Full purity is the deferred system-only-file enhancement.
- **Re-diarization invalidates manual names** (cluster ids renumber). Mitigation: `clear_for_meeting` on each run is intentional and documented; manual re-diarize is a reset. A future stable-id scheme is out of scope.
- **EventKit meetings lack `is_self`.** Mitigation: graceful degradation — no auto-fill, mic shows "You", manual picker still works.
- **Auto-run compute on every attendee call.** Mitigation: gated to models-ready + attendee-linked meetings, backgrounded, best-effort; never blocks stop.
- **Backward-compatible attendee JSON.** Mitigation: `#[serde(default)]` on `is_self`; explicit test for old-format rows.

---

## Requirements Traceability

| Origin | Covered by |
|---|---|
| R1 (system-only labeling) | U1 (+ deferred system-only file) |
| R2 (auto-run attendee meetings) | U8 |
| R3 (mic → You / self name) | U3, U6 |
| R4 (shortlist + 1:1 auto-fill + picker) | U3, U4, U7 |
| R5 (inline rename persists, relabels cluster) | U2, U4, U7 |
| R6 (per-meeting scope) | U2 |
| R7 (labels on them-side) | U7 |
| R8 (name or Speaker N fallback, layout preserved) | U6, U7 |
| AE1 | U1, U8 |
| AE2 | U8 |
| AE3, AE4 | U4 |
| AE5 | U2, U7 |

---

## Testing Strategy

- **Rust:** integration tests using the sqlx transaction-isolation helper for U1, U2, U4 (never mock the DB); serialization tests for U3; the specta export test for U5.
- **Frontend:** vitest for the pure `speaker-label.ts` helpers (U6); `pnpm check`/`pnpm lint`/`pnpm format` clean across U6–U8.
- **Manual/e2e:** a two-person attendee-linked call auto-diarizes on stop, renders named speakers on the them-side, and an inline rename persists across reopen; a solo note does not auto-diarize.

---

## Deferred / Open Implementation Notes

- Exact repository method names and the precise `get_meeting_speakers` return shape may adjust once the code is touched — the contract (distinct system clusters + non-self shortlist + self name) is fixed, the field names are not.
- Whether `get_meeting_speakers` reads distinct clusters from `transcripts` or from a small aggregate query is an execution-time choice.
- The exact placement of the click affordance in `VirtualizedTranscriptView.svelte` (on the label vs a hover control) is a UX detail to settle during U7.
