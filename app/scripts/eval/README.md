# Eval harness

Offline checks for ASR/summary quality so model and pipeline changes are measurable.
Two tiers:

- **Dry-run** (`nub run eval`, CI): scores pre-written hypothesis text against golden
  references — proves the scoring scripts, not the engine.
- **Real run** (`nub run eval:real`, dev machines only): transcribes a validated corpus
  manifest with a real local ASR engine and records quality and resource metrics.

## Layout

```
app/scripts/eval/
  corpus-manifest.json # consent/provenance and grouping metadata for every fixture
  corpus-targets.json  # private meeting-corpus coverage floor
  corpus.ts            # manifest validation and language normalization
  corpus-prepare.ts    # scaffold the next private consented collection session
  corpus-intake.ts     # consent-gated, atomic local corpus intake
  corpus-withdraw.ts   # confirmed session withdrawal and result invalidation
  corpus-result.ts     # private, corpus-bound result writes
  evaluator-revision.ts           # clean source/toolchain provenance
  benchmark-executable.ts         # exact build, hardware probe, and binary identity
  model-artifact.ts     # exact evaluated-model artifact fingerprinting
  coverage.ts          # coverage gate across language/noise/model/backend cells
  fixtures/            # golden transcripts + repository-safe audio
  wer.ts               # word error rate vs golden (importable `wer()` + CLI)
  summary-rubric.ts    # checklist scoring of a summary markdown file
  real-run.ts          # real-engine run: cargo example -> WER gate
  report.ts            # aggregate run reports by corpus and hardware dimensions
```

## Usage

```bash
# From the repo root:
nub run eval              # multi-utterance golden (clean + noisy hyp)
nub run eval:wer app/scripts/eval/fixtures/sample-ref.txt \
  app/scripts/eval/fixtures/sample-hyp.txt

# Or call nub directly; --max-wer <pct> makes the run fail above a threshold:
nub app/scripts/eval/wer.ts \
  app/scripts/eval/fixtures/meeting-golden-ref.txt \
  app/scripts/eval/fixtures/meeting-golden-hyp.txt \
  --max-wer 0

# Rubric: counts required sections in a summary markdown
nub run eval:rubric path/to/summary.md
```

## Real run (`nub run eval:real`)

Runs the `transcribe-fixture` cargo example (`app/src-tauri/examples/`) over
every sample in a validated corpus manifest and gates the results. The default
manifest is `corpus-manifest.json`; use `--manifest <path>` for a local
participant-consented corpus. Every checked-in WAV must have a manifest entry.
The private intake and withdrawal procedure is in [CONSENTED_CORPUS.md](CONSENTED_CORPUS.md).

Prepare the next underfilled language/noise cell before recruiting or recording:

```bash
MUESLY_CORPUS_CONSENT_RECORDS_DIR=/approved/encrypted/muesly-consent-records \
  nub run eval:corpus:prepare
```

This creates a gitignored, private-permission session folder, an opaque consent record in the
explicitly selected external encrypted records directory, a blank reference transcript, and an
exact single-line intake command for Bash/zsh and Windows PowerShell. It refuses repository-local
consent storage, never creates fake audio, and never marks consent as granted.

- A non-empty reference is a WER run (gated by `--max-wer`, default 10).
- An empty reference is a hallucination check: the engine should produce
  (near-)nothing (gated by `--max-hallucinated-words`, default 2).
  `silence.wav` is 20 s of deterministic ~-60 dBFS noise for exactly this.
- `--provider whisper|parakeet` (default `whisper`) and `--model <name>` A/B engines
  and artifacts on the same fixtures. Parakeet defaults to `parakeet-tdt-0.6b-v3-int8`.
- `--backend cpu|metal|coreml|cuda|vulkan|openblas|hipblas` selects the compiled Whisper
  backend (default `cpu`). The macOS `coreml` option reports the canonical backend name
  `coreml-metal`. Parakeet currently uses ONNX Runtime CPU and accepts only `cpu`. CPU and
  OpenBLAS runs explicitly disable GPU execution; GPU runs fail instead of silently falling
  back when the requested backend cannot initialize.
- `--accelerator <stable-model-or-device-id>` identifies the measured GPU for CUDA,
  Vulkan, HIP, and Intel Mac GPU runs. Apple Silicon Metal and Core ML runs derive their
  integrated GPU identity from the SoC automatically. Ambiguous GPU runs fail before compilation.
- `--models-dir <path>` reuses an existing app model directory instead of downloading
  another copy into the development directory.
- `--output <path>` writes a transcript-free JSON report containing WER or hallucination
  count, inference RTF, model-load/inference timings, peak RSS, OS, architecture, machine profile,
  active accelerator identity, backend, and SHA-256 fingerprints of the exact model artifact and
  benchmark executable bytes. Local-corpus outputs must be direct files in the manifest-adjacent
  `results/` directory so consent withdrawal can quarantine them.
- `--fixture <sample-id>` limits the run to one uniquely named manifest sample.
- The real run uses the same long-pause VAD segmentation and segment-quality filter as
  the post-meeting production pass, so it catches pipeline regressions as well as model ones.
- The selected provider/backend example is built once in the release profile and that exact
  executable is probed, prepares the requested model, and is then invoked in a fresh process for
  every selected sample. This resets process-local engine state, but does not claim a cold host:
  operating-system file caches and accelerator/runtime caches may remain warm between samples.
  Per-sample metrics must match the probe's backend, platform, hardware profile, accelerator, and
  executable digest.
- The benchmark forwards only an allowlisted, benchmark-relevant runtime environment. It removes
  overrides such as `MEMORY_GB` and operational logging, hashes the remaining ambient inputs, and
  includes that digest in the hardware profile. The requested CPU/GPU policy and accelerator
  identity are bound separately so comparable backends on one machine retain the same profile.
  The prepared provider/model artifact set is SHA-256 fingerprinted before transcription and
  again after the final sample; a report is refused if those bytes changed during the run.
- Writing a report requires a clean Git worktree. Run schema 9 records a versioned evaluator
  revision containing the Git commit, `Cargo.lock` digest, full `rustc -vV`, release profile,
  target triple, exact Cargo features, and a digest of the allowlisted build environment. The
  revision is checked before and after the run so source or toolchain drift cannot be mislabeled.
- BCP-47 locales are reduced to their primary language for Whisper (`en-US` → `en`).
  Set `whisper_language` in the manifest when an explicit mapping is needed; unsupported
  Whisper codes fail before inference.
- WER uses Unicode-aware NFKC tokenization: meaningful letters and diacritics remain distinct,
  while compatibility forms, apostrophe variants, and common dash variants are normalized
  consistently across English, Spanish, Portuguese, French, and German references.

Aggregate one or more run reports into transcript-free JSON and Markdown summaries:

```bash
nub run eval:report app/scripts/eval/results/whisper-metal.json \
  app/scripts/eval/results/parakeet-cpu.json \
  --manifest app/scripts/eval/corpus-local.json \
  --json app/scripts/eval/results/aggregate.json \
  --markdown app/scripts/eval/results/aggregate.md
```

Reports contain micro-averaged WER (total word errors divided by total reference words),
duration-weighted inference RTF, peak RSS, and silence hallucinations. They group those metrics by
language, noise condition, hardware backend, provider/model, and the combined
language/noise/backend matrix. This avoids treating a five-word clip as equally important
as a five-minute meeting. Inputs must use run-report schema 9 with metrics schema 5, name the
same corpus revision, and use identical pass thresholds and OS/architecture. Within each
provider/model, all reports must fingerprint identical model bytes; different provider/model
variants retain their own artifact fingerprints. The aggregator rejects comparisons that would
lose that artifact, machine-profile, accelerator, evaluator-revision, or executable context.
Schema 9 records the versioned WER scorer
(`muesly-wer-unicode-v1`);
coverage and aggregation reject reports with missing or different scoring semantics. CPU and GPU
reports from one machine can be combined; reports using different accelerators for the same
backend cannot.
Aggregate schema 5 records the common evaluator inputs plus the full evaluator revision and exact
benchmark-executable digest for every backend. Coverage schema 8 similarly records the corpus
fingerprint, verified model-artifact map, evaluator-revision digest by backend, and executable
digest by backend, so a saved completeness result remains bound to the exact corpus revision,
evaluated bytes, source/toolchain inputs, and binary.
Measurement completeness requires one compatible hardware cohort to satisfy the session floor
across the entire requested matrix. The operating system, architecture, and machine profile must
match for every cell, with one consistent accelerator identity per backend. Coverage schema 8
retains raw cross-machine counts and the largest compatible count per cell for diagnostics, then
enumerates matrix-wide cohorts separately. A matrix assembled from individually complete cells on
different machines or accelerators remains incomplete.

Metrics schema 5 reports source-audio duration, decode, VAD, model-download, model-load, inference,
and measured-total timings; inference RTF is inference seconds divided by source-audio seconds.
Memory is the evaluator process's host RSS sampled every 10 ms from immediately before model load
through the end of inference, reported as baseline, peak, and peak-minus-baseline MiB. It is not
accelerator VRAM. Model preparation happens before the measured sample processes, so
`model_download_seconds` ordinarily records zero while `model_load_seconds` still measures each
fresh process's engine/model initialization.

Baseline (2026-07-12, Apple Silicon, Metal, `tiny`): `real-speech` 0.00% WER,
`silence` 1 hallucinated word. Re-measure after any decode-path change.

Cross-engine spot check (2026-07-16, checked-in fixture, production VAD/filter path):
`large-v3-turbo-q5_0` scored 0.00% WER; `parakeet-tdt-0.6b-v3-int8` scored 1.85%
WER (one substitution) and emitted nothing for the silence fixture. This single clean
English clip is a regression check, not a general accuracy ranking.

- **First-run costs:** compiles the Rust workspace in the release profile, downloads FFmpeg during the
  build, and fetches the `tiny` model (~75 MB) into the gitignored dev models
  dir. Later runs reuse everything. Missing Tauri sidecar binaries are stubbed
  automatically (same approach as CI's rust-check).
- **Threshold:** default `--max-wer 10`. Calibration (2026-07-11, Apple Silicon,
  Metal): 3 consecutive runs of `tiny` on the fixture scored 0.00% WER, so 10%
  is a regression tripwire, not a quality bar. Re-calibrate by running it a few
  times after intentional decode changes and updating the default in
  `real-run.ts`.
- **Backend variance:** backend selection is explicit. Compare the same artifact and corpus
  across backends; small hardware-dependent drift is absorbed by the threshold.
- **Fixture provenance:** `real-speech.wav` is a 27 s excerpt (16 kHz mono,
  ~0.9 MB) of the LibriVox recording of Lincoln's Gettysburg Address read by
  John Greenman (archive.org item `gettysburg_johng_librivox`, public domain).
  The reference is the canonical Bliss-copy text of the excerpt, cross-checked
  against `tiny` and `base` transcriptions. Additional clips require a validated
  manifest entry; meeting recordings require an opaque consent-record ID and explicit
  `asr-benchmarking` consent.

Fixtures:

| File                                      | Role                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `sample-*.txt`                            | Single-utterance smoke                         |
| `meeting-golden-ref.txt`                  | Multi-utterance sprint-planning reference      |
| `meeting-golden-hyp.txt`                  | Clean hypothesis (expect ~0% WER)              |
| `meeting-golden-hyp-noisy.txt`            | ASR-like errors (non-zero WER)                 |
| `real-speech.wav` + `real-speech-ref.txt` | Audio + golden for the real-engine run         |
| `silence.wav` + empty `silence-ref.txt`   | Near-silence audio for the hallucination check |

Add more fixtures under `fixtures/` as real meetings are curated.

CI: `.github/workflows/eval-harness.yml` runs corpus custody, campaign-safety,
evaluator-provenance, report/coverage, WER (short + multi-utterance), and rubric dry-run tests on
changes to `app/scripts/eval/**`. Fixture WER is asserted with `--max-wer` (0% for clean
hypotheses, 10% for the noisy one); fixtures are fixed files, so the thresholds are deterministic.
`rust-check.yml` also runs the CPU-only `transcribe-fixture` example tests with no default
features as a blocking gate. **CI never runs live `eval:real` inference** — that needs a release
build, a model download, and hardware-dependent execution, so it stays a dev-machine check by
design.
