---
date: 2026-07-11
status: active
type: feat
topic: people-speech-linkage
---

# feat: Link Named Speakers to the People Page

## Summary

Make the People page reflect what each person *said*, not just which meetings they attended: per-person total speaking time and per-meeting speech minutes, joined from the per-meeting `speaker_names` assignments to the attendee-derived people groups by display name. Adds speech aggregation to the existing `api_list_people` pipeline and surfaces it on the person cards.

---

## Problem Frame

The People page (`api_list_people` → `/people`) groups meetings by calendar-attendee display name — attendance only. Separately, diarization + naming stores `(meeting_id, speaker_id, name)` in `speaker_names`, and every `system` transcript segment carries a `speaker_id` and a `duration`. The two are unlinked: a person's page can't say "Ana spoke for 14 minutes across these 3 meetings," even though both halves of that sentence are already in SQLite.

## Requirements

- R1. Each person on the People page shows their total speaking time when any of their meetings has named-speaker data.
- R2. A person's expanded meeting list shows per-meeting speech time next to meetings where they spoke.
- R3. Persons with no speech data (never diarized, name never assigned, or name mismatch) render exactly as today — no zeros, no empty widgets.
- R4. Linkage is by exact display-name match between `speaker_names.name` and the attendee name, case-insensitive and trimmed.

## Scope Boundaries

- No persisted person entity / person_id. People remain computed on the fly; this plan joins two existing tables at query time.
- No fuzzy/nickname matching. The naming picker sources names *from* the attendee shortlist, so exact match covers the dominant path; free-text renames that diverge from the calendar name simply don't link (R3 keeps that graceful).
- No talk-*share* (percent) at the People level — share needs the meeting's full speech total; only absolute time is shown here.
- The mic side ("You") is not a person — People already excludes `is_self` attendees; your own speech is out of scope.

## Key Technical Decisions

- **Aggregate in SQL, merge in `aggregate_people`.** One extra query summing `transcripts.duration` joined through `speaker_names` on `(meeting_id, speaker_id)` for `speaker = 'system'`, grouped by `(meeting_id, lower(trim(name)))`. The Rust merge keys people by the same normalized name. Keeps the existing single-pass `aggregate_people` structure and its tests intact.
- **Extend the existing structs additively:** `PersonGroup.speech_seconds: Option<f64>` (total) and `PersonMeetingRef.speech_seconds: Option<f64>`. `None` (not `0`) when no data — this is what lets the UI honor R3 without heuristics. Bindings regenerate via the specta export test.
- **`transcripts.duration` is the time source** (persisted per segment at save time); fall back to `audio_end_time - audio_start_time` when duration is NULL **or ≤ 0**, inside the SQL expression. The `≤ 0` clause matters: the legacy chunk path wrote `duration = 0.0` with zeroed times — those rows must contribute nothing, not a valid zero (review finding).
- **Known quirk, accepted:** `attendees_from_json` dedupes attendees by *exact* name, so a meeting whose attendee list contains case-variant duplicates ("Ana" and "ana") yields two person groups whose normalized keys both match the same speech entry — the seconds appear in both groups. Rare (same-source attendee lists are consistently cased) and self-inflicted by the existing People grouping; documented with a test rather than special-cased.
- **Case-insensitive match uses SQLite `lower(trim(...))`** on the speaker side and the same normalization in Rust on the attendee side. ASCII-only case folding is an accepted limitation (SQLite `lower()` is ASCII); non-ASCII names still match when stored verbatim from the same shortlist, which is the normal path.

## Implementation Units

### U1. Speech aggregation query + merge into people groups

**Goal:** `api_list_people` returns speech totals per person and per meeting.

**Requirements:** R1, R2, R3, R4

**Dependencies:** none (after the uncommitted People batch lands)

**Files:**
- `app/src-tauri/src/api/people.rs` (query + merge + tests)

**Approach:** Add a second query: sum of speech seconds per `(meeting_id, normalized_name)` from `speaker_names` joined to `transcripts` on `(meeting_id, speaker_id)` filtered to `speaker = 'system'`. Feed the result map into `aggregate_people` (new parameter), which sets `PersonMeetingRef.speech_seconds` on name-matched meetings and sums into `PersonGroup.speech_seconds`. A person with zero matches keeps both fields `None`.

**Patterns to follow:** the existing `api_list_people` query + `aggregate_people` pure-function-with-tests structure in the same file; in-memory-pool integration tests as in `database/repositories/speaker_names.rs`.

**Test scenarios:**
- Happy path: meeting with attendee "Ana", `speaker_names` row ("Ana", cluster 0), two system segments with durations 30 and 90 → Ana's group has `speech_seconds = 120` and the meeting ref carries 120.
- Case/whitespace: attendee "ana " matches speaker name "Ana" (R4).
- No diarization data for a meeting → that meeting ref has `None`; a person with no matches anywhere has group-level `None` (R3).
- Name mismatch ("Ana Ramos" attendee vs "Ana" speaker) → no link, no error.
- Two people with the same name in different meetings aggregate under the one existing name-keyed group (documents current People-page semantics; no behavior change).
- Duration fallback: segment with NULL `duration` but valid start/end contributes `end - start`; a legacy row with `duration = 0.0` and zeroed times contributes nothing.
- Case-variant duplicate attendees in one meeting ("Ana"/"ana") each show the same speech seconds — documents the accepted quirk.
- Mic segments never contribute (filter on `speaker = 'system'`).

**Verification:** Rust integration tests pass against a real in-memory pool with migrations.

---

### U2. Regenerate bindings

**Goal:** Expose the new optional fields to the frontend.

**Requirements:** enables R1, R2

**Dependencies:** U1

**Files:**
- `app/src-svelte/src/lib/bindings.ts` (generated)

**Approach:** run the `specta_bindings` export test; confirm `PersonGroup`/`PersonMeetingRef` gain `speech_seconds: number | null`.

**Test scenarios:** `Test expectation: none — generated artifact, covered by the export test compiling.`

**Verification:** export test passes; fields present.

---

### U3. Surface speech time on the People page

**Goal:** Show total and per-meeting speaking time.

**Requirements:** R1, R2, R3

**Dependencies:** U2

**Files:**
- `app/src-svelte/src/routes/(app)/people/+page.svelte`
- (reuse) `app/src-svelte/src/lib/talk-time.ts` `formatSeconds` if the talk-time plan has landed; otherwise a local formatter — implementer's choice at execution time.

**Approach:** On the person card, next to `{meeting_count} meetings`, append `· spoke {formatted}` when `speech_seconds != null`. In the expanded meeting list, append a muted `{formatted}` suffix on rows whose ref carries a value. No layout restructuring; text-level additions using semantic tokens.

**Patterns to follow:** existing card/expanded-list markup in the same file.

**Test scenarios:** `Test expectation: none — text-level presentation over already-tested data; verified manually.` (The null-hiding behavior R3 is enforced by U1's `Option` contract and its tests.)

**Verification:** `pnpm check`/`lint` clean; a person with diarized meetings shows totals, a person without renders exactly as before.

---

## System-Wide Impact

- `api_list_people` gains one aggregate query per page load — bounded by meetings×speakers, trivially indexed by the `speaker_names` PK and the existing transcripts meeting-id index.
- Additive struct fields; no schema change, no migration.
- Cross-feature: strengthens the case for keeping speaker names sourced from the attendee shortlist (exact-match linkage is the reward).

## Deferred to Follow-Up Work

- A persisted person identity (person_id) unifying nicknames/renames across meetings — the durable fix for name-mismatch, deliberately out of scope.
- Per-person talk-share percentages and trends over time.
- Linking a person row to a filtered meetings view (`/people` → filtered sidebar).
