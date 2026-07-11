---
date: 2026-07-11
status: active
type: feat
topic: eval-real-transcription-run
---

# feat: Eval Harness Step 2 — Score a Real Transcription Run

## Summary

Extend the eval harness from static text fixtures to a real end-to-end run: a checked-in audio fixture is transcribed by the actual Whisper engine on the developer's machine, and the resulting hypothesis is scored with the existing `wer.mjs` against a checked-in golden reference. Dev-machine-only by design; CI keeps its current dry-run.

---

## Problem Frame

The harness today (`app/scripts/eval/`) scores *pre-written* hypothesis text against references — it proves the scoring scripts work, not that the app transcribes well. A decode-quality regression (e.g. in the new temperature-ladder work in `whisper_engine/decode_policy.rs`) would sail through. Research confirmed there is currently **no headless path into the engine**: no CLI, no cargo example, no audio fixture in the repo — the only offline transcription route is a Tauri command. The missing piece is a thin, runtime-free entry point plus one curated audio+golden pair.

## Requirements

- R1. A single command (root `pnpm eval:real`) transcribes the checked-in audio fixture with the real Whisper engine and prints/gates its WER against the checked-in golden.
- R2. The audio fixture and golden reference are versioned in the repo; the fixture is small (≤ ~1 MB) and redistributable without license risk.
- R3. The model is fetched automatically on first run (the engine's existing headless downloader), into a gitignored location; no manual setup beyond having Rust toolchain + node.
- R4. The WER gate is a regression tripwire, not a quality bar: the threshold is calibrated from the first real runs and recorded next to the fixture.
- R5. CI is *not* wired to this path; the README states the boundary (CI = script dry-run; real run = dev machines) and why (model download size, hardware variance).

## Scope Boundaries

- Whisper only. Parakeet's ONNX sidecar setup is heavier; deferred.
- One fixture. A fixture *suite* (accents, noise, overlap) comes later once the pipeline exists.
- No diarization/speaker scoring — WER on the flat transcript only.
- No summary-rubric step-2 (scoring a real LLM summary); separate effort.

## Key Technical Decisions

- **Entry point: a cargo example (`examples/transcribe-fixture.rs`) in the muesly crate**, not a new `[[bin]]` and not an `#[ignore]`d test. An example inherits the library's deps without touching the shipping binary surface, is discoverable (`cargo run -p muesly --example`), and produces plain stdout/file output a script can consume. It composes existing pieces: `decode_audio_file` → whisper format conversion → `WhisperEngine::new_with_models_dir` → transcribe → print text. It must not require a Tauri runtime — if any engine path turns out to demand an `AppHandle`, that discovery routes back here as a plan revision, not a workaround hack.
- **Model: `tiny` (or `base`) via the engine's existing `download_model`** (HuggingFace URLs, atomic rename), targeted at an explicit models dir under the repo-local dev models location the engine already uses in debug builds. First run downloads (~75 MB); later runs reuse.
- **Fixture sourcing: public-domain speech (LibriVox/LibriSpeech excerpt) or a self-recorded clip**, 15–30 s, mono 16 kHz WAV, ≤ ~1 MB, with a hand-verified reference transcript. Exact clip selection is execution-time; the licensing constraint (public domain or own recording — nothing merely "free for research") is not.
- **Orchestration in node (`app/scripts/eval/real-run.mjs`)**, matching the harness's existing zero-dependency style: run the cargo example, capture the hypothesis, invoke the existing `wer.mjs` logic (import its `wer()` export rather than shelling out), print and gate. Root `package.json` gains `eval:real`.
- **GPU/CPU variance accepted, absorbed by the threshold only.** Metal/CoreML are hardwired into the macOS target dependency in `Cargo.toml` (not gated behind removable cargo features — features are additive, and examples can't carve them out), so there is no "pin to CPU" build fallback (review finding). If the engine exposes a runtime `use_gpu=false` context knob, that becomes the flakiness escape hatch; otherwise the calibrated threshold (R4) is the whole mitigation, and that is acceptable for a tripwire.
- **Build preconditions are real and must be handled, not assumed away** (review finding): building the `muesly` crate runs `build.rs`, which downloads an FFmpeg binary (network, tens of MB) and requires the `llama-helper`/`diarization-helper` sidecar binaries to exist — CI stubs them for exactly this reason. The orchestrator must create the same stubs when missing (mirroring `.github/workflows/rust-check.yml`) before invoking cargo, and the README must state the first-run costs (workspace compile + FFmpeg + ~75 MB model).

## Implementation Units

### U1. Audio fixture + golden reference

**Goal:** A versioned audio+truth pair the run can score against.

**Requirements:** R2

**Dependencies:** none

**Files:**
- `app/scripts/eval/fixtures/real-speech.wav` (new)
- `app/scripts/eval/fixtures/real-speech-ref.txt` (new)
- `app/scripts/eval/README.md` (provenance note)

**Approach:** Select/record the clip per the licensing + size constraints; downsample to mono 16 kHz WAV; hand-verify the reference text against the audio; record provenance (source, license, any processing) in the README.

**Test scenarios:** `Test expectation: none — data fixture. Its correctness is exercised by U3's end-to-end gate.`

**Verification:** file plays, is ≤ ~1 MB, and the reference reads back accurately against the audio.

---

### U2. `transcribe-fixture` cargo example

**Goal:** Headless file-in, text-out transcription using the real engine.

**Requirements:** R1, R3

**Dependencies:** none (parallel with U1)

**Files:**
- `app/src-tauri/examples/transcribe-fixture.rs` (new)

**Approach:** Args: audio path, optional model name (default `tiny`), optional models dir (default the engine's debug-mode dev dir). Flow: ensure model present (`download_model` with a plain progress print) → **`load_model`** (transcription errors with "No model loaded" without it — review finding) → `decode_audio_file` → convert to whisper input format → transcribe → print the joined transcript text to stdout (and nothing else on stdout; logs to stderr) so the orchestrator can capture it cleanly.

**Patterns to follow:** `audio/retranscription.rs` for the decode→transcribe composition; `whisper_engine/engine.rs` model download + `new_with_models_dir`.

**Test scenarios:** `Test expectation: none as unit tests — this is a dev tool binary; it is exercised end-to-end by U3 on developer machines. Rust unit coverage for decode/transcribe already exists in the library.`

**Verification:** `cargo run -p muesly --example transcribe-fixture -- app/scripts/eval/fixtures/real-speech.wav` prints a plausible transcript on a dev machine; first run downloads the model, second run doesn't.

---

### U3. `real-run.mjs` orchestrator + root script + threshold calibration

**Goal:** One command runs U2 over U1 and gates WER.

**Requirements:** R1, R4

**Dependencies:** U1, U2

**Files:**
- `app/scripts/eval/real-run.mjs` (new)
- `app/scripts/eval/wer.mjs` (**guard the CLI block**: `wer()` is already exported, but the file runs an unguarded top-level CLI that parses `process.argv` and `process.exit(2)`s on import — importing it as-is kills the orchestrator at import time (review finding). Wrap the CLI in an `import.meta.url === pathToFileURL(process.argv[1]).href` check.)
- `package.json` (root: `eval:real` script)

**Approach:** Ensure the sidecar stubs exist (mirror the rust-check workflow's stub step), spawn the cargo example, capture stdout as the hypothesis, compute WER via the imported `wer()`, print `WER: x.xx%`, exit non-zero above threshold. Threshold: run 3× on at least one machine, set the gate at ~2× observed WER (regression tripwire per R4), record the calibration numbers in the README.

**Patterns to follow:** `wer.mjs` CLI structure (zero-dep node, `process.exit(1)` gating).

**Test scenarios:**
- Happy path: full run on a dev machine prints WER and exits 0 under threshold.
- Gate: `--max-wer 0` forces a failing exit on any imperfect hypothesis (proves the gate wires through).
- Missing fixture / cargo failure → non-zero exit with a clear message, not a zero-WER false pass.
- Import safety: importing `wer.mjs` from another module does not execute the CLI (no usage print, no exit) — `pnpm eval` still works standalone after the guard.

**Verification:** `pnpm eval:real` works from the repo root given the Rust toolchain and network (the orchestrator stubs missing sidecars itself; first run pays workspace compile + FFmpeg + model download); threshold and calibration notes committed.

---

### U4. Documentation and CI boundary

**Goal:** README explains the two tiers; CI untouched.

**Requirements:** R5

**Dependencies:** U3

**Files:**
- `app/scripts/eval/README.md`
- (verify-only) `.github/workflows/eval-harness.yml` — confirm its path triggers don't start running `eval:real`

**Approach:** Document: what `pnpm eval` (dry-run, CI) vs `pnpm eval:real` (real engine, dev-only) cover, the model/cache location, the calibrated threshold and how to re-calibrate, and the explicit rationale for keeping CI dry-run. The workflow file only runs the existing scripts; adding `real-run.mjs` under `app/scripts/eval/**` will *trigger* the workflow on the PR touching it, but the workflow's steps don't invoke it — verify that stays true.

**Test scenarios:** `Test expectation: none — documentation. The CI-boundary claim is verified by reading the workflow steps.`

**Verification:** README accurate; eval-harness workflow green on the PR that adds these files.

---

## System-Wide Impact

- No shipping-code changes: an example binary, scripts, fixtures, docs. Zero effect on the app bundle.
- Repo grows by ≤ ~1 MB (the WAV). Accepted once; a fixture *suite* would revisit storage (e.g. LFS) — deferred.
- Developer surface: first `eval:real` run compiles the workspace and downloads ~75 MB of model — must be stated in the README so it isn't mistaken for a hang.

## Risk Analysis & Mitigation

- **Engine constructibility without Tauri: CONFIRMED at review time.** `new_with_models_dir` is Tauri-free; `transcribe_audio`'s only globals are the vocabulary LazyLock (defaults empty) and hardware detection — both harmless headless. Residual risk is low; if an engine path surprises anyway, revise the plan rather than hack around it.
- **Threshold flakiness across hardware/backends.** Mitigation: generous calibrated threshold (R4). There is no CPU-pin build fallback on macOS (Metal is hardwired in the target deps); a runtime `use_gpu` knob is the only possible escape hatch if one exists.
- **Build preconditions** (sidecar stubs, FFmpeg build-download). Mitigation: orchestrator stubs sidecars automatically; README states first-run costs.
- **Fixture licensing.** Mitigation: hard constraint to public domain or self-recorded; provenance recorded in README.

## Deferred to Follow-Up Work

- Parakeet engine run; fixture suite (noise/accents/long-form); diarization accuracy scoring (DER) against a labeled fixture; real summary-rubric runs; optional nightly CI job on a self-hosted runner if the team ever wants automated real runs.
