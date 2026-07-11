# Residual Review Findings — Named Speaker Attribution

Source: multi-agent review of the named-speaker-attribution feature. Plan: `docs/plans/2026-07-10-001-feat-named-speaker-attribution-plan.md`.

## Update (2026-07-10, follow-up pass)

All four deferrals from the original review were resolved:

- **Re-diarize wipes manual names** → RESOLVED. `DiarizationControl.svelte` now checks for assigned names before running and shows a confirmation dialog ("Re-identify speakers?") when re-running would clear them.
- **Auto-run result invisible until reopen** → RESOLVED. `diarize_meeting` emits `diarization-complete` with the meeting id; the meeting-details page listens and refetches the transcript, so labels appear live.
- **`diarize_meeting` not transactional** → RESOLVED. `apply_diarization` wraps clear-names + segment relabeling + auto-fill in a single transaction (repo methods are now generic over the sqlx executor). A partial failure can no longer leave a half-relabeled transcript or stale names.
- **`PRAGMA foreign_keys` presumed off in production** → RESOLVED as a false premise. sqlx's `SqliteConnectOptions` enables foreign keys by default; a pinning test (`manager.rs::production_style_pool_enforces_foreign_keys`) now guards that guarantee, and the hard-delete test proves the explicit `speaker_names` cleanup works even with FK off.

## Remaining (accepted, low priority)

- **No frontend hook/component test harness.** `use-speaker-context.svelte.ts` (effect + stale-response guard) and the `SpeakerLabel`/`DiarizationControl` dialogs are untested at the component level; the repo has no `@testing-library/svelte`. All pure logic in `speaker-label.ts` is covered by vitest.
- **`shouldAutoDiarize` gating is inline** in `use-recording-stop.svelte.ts` (attendees present AND models ready). Simple boolean logic, judged not worth extracting.
- **Concurrent manual re-run during auto-run** now fails fast with "diarization is already in progress for this meeting" (per-meeting in-flight guard) — accurate but a plain error toast; could be softened to a friendlier notice if it comes up in practice.
