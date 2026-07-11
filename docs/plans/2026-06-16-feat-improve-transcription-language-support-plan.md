---
title: Improve transcription language support
type: feat
status: active
date: 2026-06-16
---

# Improve transcription language support

## Enhancement summary

**Deepened on:** 2026-06-16 (3 research/review agents: code-grounding, rust-principal-engineer, principal-engineer)

The first draft over-scoped and rested on a few premises that are stale against the code on disk. Corrections after grounding:

- **The engine-aware UI already exists.** `LanguageSelection.svelte` filters options to `auto`/`auto-translate` and shows an amber notice when Parakeet is active. The "silent no-op" framing was wrong for the UI; the only real gap is backend honesty (Parakeet is English-only, so `auto-translate` is offered but cannot translate).
- **A detected-language concept already exists**, but heuristic and on a different substrate: the summary pipeline detects language from summary text and persists it to folder metadata (`summary/service.rs`, `summary/processor.rs`), not from Whisper's `lang_id` and not in the DB. Phase 3 is therefore a reconcile, not a greenfield.
- **The one genuinely user-visible bug** is the default mismatch: the backend static defaults to `"auto-translate"` while the frontend defaults to `"auto"`.
- **The persistence claim "every preference lives in the settings DB" is false** (summary language lives in `localStorage`, detected language in folder metadata). That observation must not be used to justify migrating those.

### Key improvements folded in
1. Reduced to a small, correctness-focused first PR; deferred the large per-meeting layer.
2. Pinned the startup-load to `AppState` construction to survive the first-launch DB deferral.
3. Concrete API/column/struct facts so `/work` has an exact target (symbols, not line numbers, since lines drift).

### New considerations discovered
- First-launch path never `manage`s `AppState`, so a naive startup load no-ops.
- Settings tables are single-row (`id='1'`) upserts with `NOT NULL` siblings; a language-only write must not null them.
- `SELECT *` maps into `FromRow` structs, so a new column requires a struct field too.
- Parakeet (`parakeet-tdt-0.6b-v3/v2-int8`) is English-only; `auto-translate` is meaningless for it.

## Overview

The app lets users pick a transcription language (Whisper), but the backend source of truth is a process-global in-memory value (`LANGUAGE_PREFERENCE` in `lib.rs`) seeded with a default that disagrees with the frontend, mirrored through `localStorage` rather than the database, and the language list is duplicated in two files that have drifted. This plan makes the transcription language a durable, consistent setting and fixes the default bug, then leaves a clearly-scoped follow-up for per-meeting language metadata.

Scope is **transcription language** (Whisper/Parakeet input language and Whisper's translate-to-English mode), explicitly not UI string localization. It is separate from the summary output language (the two-pass summary translation in `summary/processor.rs`), though the two interact and that interaction is clarified below.

## Problem statement / motivation

Grounded in the current code:

- **Default mismatch (real bug).** The backend static (`get_language_preference_internal` / `set_language_preference` in `lib.rs`) initializes to `"auto-translate"`, which forces Whisper to translate speech to English. The frontend `config.svelte` store defaults `selectedLanguage` to `"auto"` (original language). Until the frontend syncs the value to the backend at startup, there is a window where transcription would translate to English against the user's expectation.
- **Source of truth is fragile and off-pattern.** The durable copy lives in `localStorage` (`primaryLanguage`) and is pushed to the backend static on startup. It is not in the settings DB where the transcription provider/model config lives, and the static is the authority on the hot path.
- **Duplicated, drifted language list.** `lib/constants/languages.ts` (~38 entries) and the `LANGUAGES` export in `LanguageSelection.svelte` (~99 entries, the fuller and more correct one) have diverged.
- **Parakeet honesty gap.** Both bundled Parakeet models (`parakeet-tdt-0.6b-v3-int8`, `parakeet-tdt-0.6b-v2-int8`) are English-only and the engine takes no language argument. The UI already restricts Parakeet to `auto`/`auto-translate`, but `auto-translate` cannot do anything for an English-only model, so it is misleading.
- **Translate-vs-summary fidelity loss.** When transcription is `auto-translate`, the stored transcript is English; the summary's English base is then built from already-English text, and if the user picks a non-English summary output language the result is English-twice-removed with no original-language transcript to anchor names/quotes. The heuristic summary-language detection also misfires here (it sees English text and reports English even for a non-English meeting).

## Proposed solution

Two deliverables.

**PR 1 (this plan's core): durability + correctness.** One source of truth for transcription language in the settings DB, loaded into the runtime static at `AppState` construction, with the default reconciled to `"auto"`. Dedupe the language list. Make Parakeet's option set honest. Small, low-risk diff that closes the actual bug.

**PR 2 (follow-up, separate proposal): per-meeting language + Whisper-accurate detection.** Capture Whisper's `full_lang_id()` detected language, reconcile it with the existing folder-metadata detection, store the language used per transcription run, display it, and reuse it on re-transcription. This must be designed against the existing metadata-based detection rather than assume a blank slate, so it is deliberately out of PR 1.

## Technical approach (PR 1)

### Single source of truth + startup load
- Add a nullable `transcriptionLanguage TEXT` column to the **`settings`** table (camelCase to match `groqApiKey`, `ollamaEndpoint`). Rationale: transcription language is routed through the global `LANGUAGE_PREFERENCE` and is a single global preference; reusing `SettingsRepository`'s proven `id='1'` singleton-upsert (the `save_api_key`/`get_api_key` shape) is the lowest-risk path. (Alternative `transcript_settings` is conceptually a sibling of transcript provider/model; rejected for PR 1 to reuse the proven write path. Note this decision in the PR.)
- Update the `Setting` `FromRow` struct in `database/models.rs` to add the matching field, because the repository uses `SELECT *`.
- Add `SettingsRepository` get/set for the column, upserting on `id='1'` and supplying the same placeholder `provider`/`model`/`whisperModel` defaults the existing inserts use, so a language-only write never violates `NOT NULL`.
- Keep `LANGUAGE_PREFERENCE` as the runtime cache (read once per chunk on the hot path; do not read the DB per chunk). Change its initializer from `"auto-translate"` to `"auto"` so the worst case during the startup window is the correct default.
- Load the persisted value into the static at **`AppState` construction**, not in `setup()`: do it in both the normal-launch branch of `database/setup.rs` (after `app.manage(AppState{..})`) and at the point the first-launch flow finishes DB creation and manages state. Fall back to `"auto"` on any read error; never block or fail launch.
- Make `set_language_preference` write through: update the static first (so the live worker reflects the change immediately), then best-effort persist to the DB; a transient DB error logs but does not make the in-session change appear to fail.
- Invert the frontend startup sync: DB is the source of truth, `localStorage` becomes a read-through cache reconciled from the DB. One-time migration: if the DB has no `transcriptionLanguage` but `localStorage` has a legacy `primaryLanguage`, write it through once (the "is the DB value set" check is the idempotency guard, so no marker is needed). Map/validate legacy codes; unknown codes fall back to `"auto"` at the backend boundary.

### Dedupe the language list
- Move the fuller `LANGUAGES` list out of `LanguageSelection.svelte` into the shared `lib/constants/languages.ts` (seed from the component's complete ~99-entry list, not the shorter file), point both consumers at the shared module, after grepping importers of `constants/languages.ts` to confirm nothing relied on the shorter subset/ordering. Keep the shape `{ code, name }`; no capability metadata.

### Parakeet honesty
- For the Parakeet engine, drop `auto-translate` from the offered options (keep `auto`, effectively English), since the model cannot translate. The UI already branches on `provider`/`isParakeet`; this is a small change to that option set plus copy.

## System-wide impact

- **Interaction graph**: language selector -> `config.svelte` setter -> `set_language_preference` command -> `LANGUAGE_PREFERENCE` static (+ DB write-through) -> read by the live worker (`audio/transcription/worker.rs`) and the file/import path (`whisper_engine/commands.rs`, `audio/import.rs`) -> `transcribe_audio*`. PR 1 inserts a DB read at `AppState` construction and a DB write in the setter.
- **API surface parity**: both the live and file/import transcription paths must read the same resolved language. The import path additionally accepts a per-call language override from the import dialog; preserve that behavior.
- **State lifecycle**: the legacy `localStorage` value reconciles into the DB exactly once; subsequent launches read DB -> static -> localStorage cache, never the reverse, so there is no cross-launch clobber.
- **Error propagation**: command boundaries use `Result<_, String>`; startup load degrades to the default and never blocks launch.

## Acceptance criteria (PR 1)

### Functional
- [x] Selecting a transcription language and restarting the app preserves the choice, sourced from the settings DB.
- [x] Backend and frontend agree on a single default of `"auto"`.
- [x] Exactly one language list exists; `LanguageSelection.svelte` consumes the shared module.
- [x] Parakeet no longer offers `auto-translate` (it cannot translate); selecting Parakeet does not present a meaningless option.
- [x] Both live recording and file/import transcription honor the same resolved language; the import per-call override still works.

### Non-functional / quality gates
- [x] App launch never blocks or fails if the preference cannot be read; it falls back to `"auto"`.
- [x] One additive, nullable (no default) sqlx migration in a new file; the squashed baseline is not edited; the `Setting` `FromRow` struct gains the field so `SELECT *` still deserializes.
- [x] The `settings` write upserts on `id='1'` and does not null `provider`/`model`/`whisperModel`.
- [x] `cargo test` and `pnpm -C src-svelte check` pass; a Rust repository test against a real in-memory SQLite pool covers write -> reload -> read-back (no mocks).

## Deferred to PR 2 (per-meeting language + accurate detection)

- Capture Whisper's detected language via `WhisperState::full_lang_id()` mapped through `whisper_lang_str` (single shared helper). Introduce a `TranscriptionOutcome { text, confidence, is_partial, detected_language }` struct to absorb the return-type change instead of widening tuples across `run_full_blocking` / `transcribe_audio_with_confidence`. Only do this once a consumer exists.
- Reconcile with the existing heuristic folder-metadata detection (`summary/service.rs`, `summary/processor.rs`); decide whether Whisper's id supersedes the heuristic.
- Store the language used per transcription run (most consistent home: a nullable `transcription_language` on `transcript_chunks`, which already records `model`/`model_name`; no index, no FK). Lock the language at recording start and store the locked value, so a meeting cannot mix languages across chunks.
- [DONE 2026-06-16] UI: inline note where the summary output language is chosen, warning that `auto-translate` transcription stores an English transcript and a non-English summary will be translated from English (fidelity loss). Do not hard-block. Implemented in `SummaryGeneratorButtonGroup.svelte`.

## Risks & edge cases

- First-launch `AppState` absence (addressed by loading at AppState construction on both branches).
- `settings` single-row upsert and `NOT NULL` siblings (addressed by mirroring `save_api_key` defaults).
- `SELECT *` -> `FromRow` struct drift (addressed by adding the field).
- Legacy `localStorage` -> DB migration precedence and unknown-code fallback to `"auto"`.
- Mid-recording language change: resolved in PR 2 by lock-at-start; in PR 1 the static remains the next-recording default.
- `set_language_preference` becoming fallible against the pool: handle the error path in callers, but keep in-session changes feeling instant (static updated first).

## Sources & references (symbols, not line numbers; lines drift)

- Backend language state: `LANGUAGE_PREFERENCE`, `set_language_preference`, `get_language_preference_internal` in `app/src-tauri/src/lib.rs`
- Whisper language logic + detection API: `run_full_blocking`, `transcribe_audio_with_confidence` in `app/src-tauri/src/whisper_engine/whisper_engine.rs`; `WhisperState::full_lang_id()` (whisper-rs 0.13.2)
- Transcription entry points: `app/src-tauri/src/audio/transcription/worker.rs`, `app/src-tauri/src/whisper_engine/commands.rs`, `app/src-tauri/src/audio/import.rs`
- Settings persistence pattern to mirror: `SettingsRepository::save_api_key`/`get_api_key` in `app/src-tauri/src/database/repositories/setting.rs`; `Setting` struct in `app/src-tauri/src/database/models.rs`; `settings` table in `app/src-tauri/migrations/20260616000000_initial_schema.sql`
- Startup ordering: `run()` in `app/src-tauri/src/lib.rs`; `initialize_database_on_startup` in `app/src-tauri/src/database/setup.rs`
- Frontend state/persistence + sync: `selectedLanguage`, the language sync method, and the setter in `app/src-svelte/src/lib/stores/config.svelte.ts`
- Language UI + duplicated list + Parakeet branch: `app/src-svelte/src/lib/components/LanguageSelection.svelte`, `app/src-svelte/src/lib/constants/languages.ts`
- Parakeet (English-only, no language arg): `app/src-tauri/src/parakeet_engine/` (`parakeet-tdt-0.6b-v3-int8`, `parakeet-tdt-0.6b-v2-int8`)
- Summary translation (separate concern): `app/src-tauri/src/summary/processor.rs`, `app/src-tauri/src/summary/service.rs`; summary-language preference in `app/src-svelte/src/lib/stores/summary-language.svelte.ts`
