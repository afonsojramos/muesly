# Residual Review Findings — Transcript timestamps toggle & copy

Source: ce-code-review autofix run `20260717-005419-b62acf89` on the transcript-timestamps feature (commits `82c2a1d..54ebaa6`, plan `docs/plans/2026-07-17-001-feat-transcript-timestamps-copy-plan.md`). Recorded 2026-07-17. This branch has no open PR (main-only workflow), so this file is the durable record.

## Residual Review Findings

- **P2** `app/src-svelte/src/lib/components/ChatBar/TranscriptDropup.svelte:105` — Overlapping transcript-copy invocations have no in-flight guard, so a slower earlier click's stale clipboard write/toast can land after a fresher one (newly relevant now that the timestamps preference changes what each copy produces). Validated by independent re-verification. Filed: [afonsojramos/muesly#4](https://github.com/afonsojramos/muesly/issues/4). Suggested direction: monotonic request token matching the file's existing `refreshToken` staleness pattern, or a disabled/busy state on the copy button while a copy is in flight.
