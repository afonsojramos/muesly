---
date: 2026-07-10
topic: named-speaker-attribution
---

# Named Speaker Attribution ("Who Exactly Is Speaking")

## Summary

Turn muesly's existing anonymous "Speaker 1 / Speaker 2" diarization into **named, in-meeting speaker attribution** - each transcript segment shows a person's name ("Ana", "Bruno", "You") drawn from the meeting's calendar attendees and correctable by hand. Names are scoped to the meeting; there is no cross-meeting voice identity.

---

## Problem Frame

muesly already separates "me vs everyone else" for free: the dual-path pipeline (`app/src-tauri/src/audio/pipeline.rs`) keeps microphone and system audio as separate streams through transcription, stamping every segment `speaker: "mic" | "system"`, and the transcript view renders your mic on the right and others on the left, Granola-style. A `sherpa-onnx` clustering sidecar (`app/src-tauri/src/diarization/`) can further split the "others" into anonymous clusters behind a manual button.

The pain is the last mile. When you review a multi-person call, the "them" side is still an undifferentiated wall (the anonymous cluster label only renders on *your* mic segments today, not on the side where multiple speakers actually matter), and even where clusters do show, they read "Speaker 2" rather than "Ana." The person reviewing the notes then has to reconstruct who said what from memory. Granola's perceived magic - a transcript that reads like a labeled dialogue - is exactly this last mile, and muesly has all the upstream machinery for it already sitting unused.

---

## Actors

- A1. Local user (recorder): runs the recording; their voice is the mic channel; reviews the transcript afterward and corrects any wrong speaker labels.
- A2. Remote participants: their mixed voices arrive on the single system-audio channel; they are the speakers the diarizer must separate and the attendee list must name.
- A3. Diarization sidecar (`diarization-helper`): clusters the system-channel audio into per-speaker turns on device.
- A4. Calendar integration: supplies the attendee **names** (emails deliberately stripped) that seed the naming shortlist for meetings tied to an event.

---

## Key Flows

- F1. Auto-attributed review (calendar meeting)
  - **Trigger:** A recording tied to a calendar event with attendees stops.
  - **Actors:** A1, A3, A4
  - **Steps:** (1) Mic segments are attributed to the local user with no clustering. (2) The system channel is diarized in the background into remote clusters. (3) Clusters are labeled from the attendee shortlist (auto-filled only in the unambiguous 1:1 case, otherwise "Speaker N"). (4) User opens the meeting and sees a labeled dialogue. (5) User taps any wrong/blank label and picks the correct attendee.
  - **Outcome:** Every segment carries a name (or an honest "Speaker N"), corrections persist with the meeting.
  - **Covered by:** R1, R2, R3, R4, R5, R7, R8

- F2. Manual attribution (no calendar / solo escape hatch)
  - **Trigger:** User clicks "Identify speakers" on a meeting that did not auto-diarize (no attendees, or auto-run disabled).
  - **Actors:** A1, A3
  - **Steps:** (1) Diarization runs on demand. (2) Clusters render as "Speaker N" with no attendee shortlist to seed from. (3) User renames clusters inline with free text.
  - **Outcome:** Same labeled transcript, names entered by hand.
  - **Covered by:** R5, R7, R8

---

## Requirements

**Separation and accuracy**
- R1. Diarization runs on the **system channel only**. Mic segments are attributed to the local user without clustering, so the user is never mis-assigned into a remote cluster and remote clustering is not polluted by the user's voice. (Today `diarize_meeting` runs on the decoded mixed file - this is the load-bearing change.)
- R2. When a recording tied to a calendar event **with attendees** stops, diarization runs automatically in the background; recordings with no attendees (or with auto-run disabled) are not auto-diarized. A manual "Identify speakers" action remains available for every meeting. *(Trigger model is an assumption pending user confirmation - see Outstanding Questions.)*

**Naming**
- R3. The local user's (mic) segments are auto-labeled "You", using the calendar `is_self` attendee display name when available, else the literal "You". No user action required.
- R4. Each remote cluster is offered a name from the meeting's attendee shortlist. When there is exactly one remote attendee and exactly one remote cluster, auto-assign that name; otherwise label clusters "Speaker N" and present the attendee list as a one-tap picker. Never guess a name in the ambiguous case.
- R5. The user can assign or rename any cluster inline in the transcript. The assignment persists with the meeting and relabels every segment belonging to that cluster.
- R6. Speaker names are scoped to the single meeting. No voice embeddings are stored and no identity carries across meetings.

**Rendering**
- R7. Diarized labels render on the **system ("them") side**, not only the mic side. (Fixes the current `isMe &&`-gated label in `VirtualizedTranscriptView.svelte`.)
- R8. Each segment shows its assigned name, falling back to "Speaker N" when a cluster is unnamed. The existing me-right / them-left Granola-style layout is preserved.

---

## Acceptance Examples

- AE1. **Covers R2.** Given a recording tied to a calendar event with 2 attendees, when the recording stops, then diarization runs automatically and opening the meeting shows the remote speakers split into distinct labeled rows.
- AE2. **Covers R2.** Given a solo voice note with no calendar event, when the recording stops, then diarization does not auto-run, and the "Identify speakers" action is still available on that meeting.
- AE3. **Covers R4.** Given a call whose calendar event lists exactly one remote attendee "Ana", and the system channel yields exactly one remote cluster, when diarization completes, then that cluster is auto-labeled "Ana".
- AE4. **Covers R4.** Given a call with 3 remote attendees {Ana, Bruno, Carla} and the system channel yields 3 clusters, when diarization completes, then the clusters render "Speaker 1/2/3" and tapping one offers {Ana, Bruno, Carla} as the pick list.
- AE5. **Covers R5, R8.** Given a transcript with a cluster labeled "Speaker 2", when the user assigns it "Bruno", then every "Speaker 2" segment relabels to "Bruno" and the label survives reopening the meeting.

---

## Success Criteria

- On a real multi-person call, a user can open the meeting and read a dialogue where remote speakers are visibly distinct and correctly named after at most a few taps - without replaying audio to reconstruct who spoke.
- The local user is never shown as a remote "Speaker N"; "You" is correct with zero user action.
- A wrong name never appears silently: ambiguous clusters show "Speaker N", not a guess.
- `ce-plan` can proceed without inventing product behavior: the trigger model, the naming rules, the persistence expectation ("names persist with the meeting"), and the rendering target ("them" side) are all pinned here.

---

## Scope Boundaries

- No cross-meeting voice identity, enrollment, or voiceprints. A person named in one meeting is not auto-recognized in the next.
- No live/in-progress naming of remote speakers. During recording, only the existing me-vs-them split is shown; named remote speakers appear post-recording once the full audio can be clustered.
- No use of meeting-platform APIs (Zoom/Meet/Teams active-speaker events). Attribution stays audio-only and on-device, consistent with muesly's local-first stance.
- No attendee email capture. The names-only invariant in the calendar layer is preserved; naming is seeded from display names or entered by hand.
- Not building a new diarization engine. This reuses the existing `sherpa-onnx` sidecar and `speaker_id` column.

---

## Key Decisions

- **Diarize the system channel only, not the mixed file.** The mic is already known to be the local user, so clustering it in adds a mis-attribution risk and degrades remote cluster quality. This also makes the clusterer's job easier (fewer speakers, cleaner audio).
- **Conservative auto-naming.** Auto-assign only the unambiguous 1-attendee-to-1-cluster case; otherwise "Speaker N" plus a picker. Rationale: a confidently-wrong name erodes trust more than an honest anonymous label.
- **Names scoped per meeting, no voiceprints.** Matches the user's explicit choice to skip cross-meeting identity and keeps a local-first app free of stored biometric voiceprints.

---

## Dependencies / Assumptions

- Requires the diarization model and the `diarization-helper` sidecar to be present. Both already exist, with an on-demand model download flow (`download_diarization_models`); this feature does not add a new engine.
- Attendee names are available only for calendar-linked meetings; for everything else, manual naming (R5) is the only path. This is expected, not a gap.
- **[Assumption - confirm]** Trigger model is "auto for attendee-meetings only" (the question that timed out). Alternatives are "auto for every recording" or "manual only." This changes R2 and F1/F2 framing.
- Assumes the existing per-segment recording-relative timestamps (already emitted and persisted) are sufficient to reconcile system-channel diarizer turns onto system-side segments. (Reconciliation logic already exists in `diarization/reconcile.rs`.)

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R2][User decision] Confirm the trigger model: auto-run for attendee meetings only (assumed), auto for every recording, or keep it fully manual?

### Deferred to Planning

- [Affects R1][Technical] How to feed the system channel to the diarizer cleanly - reuse the saved recording and re-derive the system stream, or persist/segment the system channel separately at record time?
- [Affects R4, R5][Technical] Where to persist cluster-to-name assignments (e.g. a per-meeting speaker-label mapping keyed on `meeting_id` + `speaker_id`) so renames survive and relabel all segments.
- [Affects R1][Needs research] Diarizer accuracy and latency on a single mixed remote channel (system audio is already one stream of many voices) - validate cluster quality and whether `num_clusters` auto-detect is good enough, or whether the attendee count should hint it.
- [Affects R3][Technical] Confirm `is_self` attendee display name is reliably present to source the "You" label, with the literal "You" as fallback.
