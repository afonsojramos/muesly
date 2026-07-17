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
  corpus-benchmark-lock.ts        # exclusive local benchmark ownership
  corpus-benchmark-checkpoints.ts # bounded, alias-safe checkpoint discovery
  corpus-benchmark-options.ts     # strict campaign-option parsing
  corpus-benchmark-plan.ts        # deterministic per-sample campaign planning
  corpus-benchmark-run.ts         # resumable consented-corpus campaign runner
  evaluator-revision.ts           # clean source/toolchain provenance
  benchmark-executable.ts         # exact build, hardware probe, and binary identity
  model-artifact.ts     # exact evaluated-model artifact fingerprinting
  coverage.ts          # coverage gate across language/noise/model/backend cells
  fixtures/            # golden transcripts + repository-safe audio
  wer.ts               # word error rate vs golden (importable `wer()` + CLI)
  summary-rubric.ts    # checklist scoring of a summary markdown file
  real-run.ts          # thin real-engine CLI
  real-run-session.ts  # prepared artifact session + per-sample WER gate
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
One invocation builds, probes, prepares, and snapshots the selected executable/runtime/model
artifacts once, then runs each selected sample in a fresh process against those immutable private
snapshots.

Prepare the next underfilled language/noise cell before recruiting or recording:

```bash
MUESLY_CORPUS_CONSENT_RECORDS_DIR=/approved/encrypted/muesly-consent-records \
  nub run eval:corpus:prepare
```

This creates a gitignored, private-permission session folder, an opaque consent record in the
explicitly selected external encrypted records directory, a blank reference transcript, and an
exact single-line intake command for Bash/zsh and Windows PowerShell. It refuses repository-local
consent storage, never creates fake audio, and never marks consent as granted.

Plan the complete benchmark campaign without running inference:

```bash
nub run eval:corpus:benchmark \
  --manifest app/scripts/eval/corpus-local.json
```

Add `--run` to execute every pending sample and `--require-complete` to apply the full corpus and
matrix-wide hardware coverage gate after the campaign:

```bash
nub run eval:corpus:benchmark \
  --manifest app/scripts/eval/corpus-local.json \
  --run --require-complete
```

Campaign runs prepare one immutable real-run session per provider/model/backend variant, execute
each sample in a fresh child process, attest its leased audio/reference before and after inference,
and checkpoint immediately without a full-corpus reload per sample.

The runner coordinates its benchmark lock with the corpus mutation lock, refuses to start while a
withdrawal is pending, and blocks intake, withdrawal, or unrelated result writes until the
campaign releases ownership. It validates the corpus and target matrix, builds and probes each
selected provider/model/backend, and writes a private atomic checkpoint after every sample.
Rust CI binds the committed target's exact CPU/Metal Whisper recommendation and ONNX-CPU Parakeet
default to the shipped catalogs and integrity pins. At run time the staged evaluator reports the
expected product-pin digest, then the runner independently hashes both the source artifact and its
private snapshot against that digest. An unknown pin or byte mismatch fails without deleting the
operator's model files.
Re-running the same command resumes only exact completed task, model, evaluator, executable, and
hardware identities. `--variant provider/model/backend` limits execution to a repeatable subset. Use
`--accelerator backend=stable-device-id` where an explicit GPU identity is required. A failed
quality threshold is checkpointed for diagnosis and makes the command exit non-zero; interruption
keeps completed checkpoints and exits with status 130. `--require-complete` always certifies the
full target matrix and therefore cannot be combined with `--variant`.
Supported corpus mutations reclaim only provably dead campaign locks, preserving private stale
evidence and failing closed when process identity is uncertain. Before installing a mutation lock,
commands enforce pending-withdrawal authorization and check campaign ownership; they repeat both
checks after installation. Rejected campaigns therefore cannot hold the lock or run recovery, and
owner checkpoint writes retry only the remaining brief race window. Final verification compares
each checkpoint's exact name, identity, and content digest.

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
  another copy into the development directory. Existing canonical-target files must match the
  product download pins; replace or re-download a mismatched file before benchmarking it.
- `--output <path>` writes a transcript-free JSON report containing WER or hallucination
  count, source-audio and model-input inference RTF, model-load/inference timings, peak RSS, OS,
  architecture, machine profile,
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
  Git, Cargo, and rustc command launchers are resolved only through absolute entries in the
  recorded command environment; relative/current-directory entries are removed, Windows
  shell-script shims are refused, and each launcher's canonical path and bytes are rechecked
  around every invocation. Full `rustc -vV` output binds the selected Rust toolchain identity;
  when rustup provides the launcher, this attests the rustup shim rather than claiming the
  selected compiler's internal binary bytes. `RUSTC_WRAPPER` and `RUSTC_WORKSPACE_WRAPPER` must
  be unset or empty, and highest-precedence Cargo CLI configuration forces both wrapper settings
  empty so parent or `CARGO_HOME` configuration cannot interpose on measured builds.
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
duration-weighted source-audio and model-input inference RTF, sampled evaluator-process host RSS,
and silence hallucinations. Aggregate schema 7 treats provider, model, and reported backend as one
indivisible variant. Diagnostic summaries retain every observed sample but are isolated by exact
variant, with overall, language, noise-condition, and language/noise dimensions. The report emits
cross-variant tables only when at least two supplied variants contain the identical set of sample
IDs. Equal counts are not enough, and unequal cohorts are not reduced to a post-hoc intersection:
missing measurements may be failures, so that would introduce survivorship bias. Instead, partial
runs retain clearly labelled per-variant diagnostics plus observed/common/missing counts.

Comparison rows preserve the full provider/model/backend identity in the variant,
language/variant, noise-condition/variant, and language/noise/variant dimensions. The comparison
scope covers only supplied variants and does not certify the target matrix; use
`eval:coverage --require-complete` for that gate. Inputs must use run-report schema 9 with metrics
schema 7, name the same corpus revision, and use identical pass thresholds and OS/architecture.
Within each provider/model, all reports must fingerprint identical model bytes; different
provider/model variants retain their own artifact fingerprints. The aggregator also requires
matching sample identity, scorer, machine profile, accelerator, evaluator revision, and executable
context before comparison.
Schema 9 records the versioned WER scorer
(`muesly-wer-unicode-v1`);
coverage and aggregation reject reports with missing or different scoring semantics. CPU and GPU
reports from one machine can be combined; reports using different accelerators for the same
backend cannot.
Aggregate schema 7 records both RTF definitions, measurement and distinct-sample counts, the
comparison status, the common evaluator inputs, the full evaluator
revision, and exact benchmark-executable digest for every backend. Coverage schema 8 similarly
records the corpus
fingerprint, verified model-artifact map, evaluator-revision digest by backend, and executable
digest by backend, so a saved completeness result remains bound to the exact corpus revision,
evaluated bytes, source/toolchain inputs, and binary.
Measurement completeness requires one compatible hardware cohort to satisfy the session floor
across the entire requested matrix. The operating system, architecture, and machine profile must
match for every cell, with one consistent accelerator identity per backend. Coverage schema 8
retains raw cross-machine counts and the largest compatible count per cell for diagnostics, then
enumerates matrix-wide cohorts separately. A matrix assembled from individually complete cells on
different machines or accelerators remains incomplete.

Metrics schema 7 reports source-audio duration, exact ASR-input audio duration, decode, VAD,
model-download, model-load, inference, and measured-total timings. `inference_rtf` remains the
product-oriented source-audio RTF: inference seconds divided by the original audio duration.
`model_inference_rtf` is inference seconds divided by `inference_audio_seconds`, the exact number
of 16 kHz samples passed to the ASR engine after VAD and the minimum-segment gate. It is `null` when
VAD sends no audio to the model. The VAD flush may pad its final processing block, so ASR-input
duration can exceed source duration by at most one 30 ms block.
Memory is the evaluator process's host RSS sampled every 10 ms from immediately before model load
through the end of inference, reported as baseline, sampled peak, and peak-minus-baseline MiB. The
aggregate labels both the absolute sampled host RSS and its increase from the pre-model-load
baseline; neither is model-only memory, and sampling may miss shorter peaks. It excludes accelerator
VRAM. Model preparation happens before the measured sample processes, so
`model_download_seconds` ordinarily records zero while `model_load_seconds` still measures each
fresh process's engine/model initialization.

The corpus campaign runner creates one transcript-free checkpoint per sample. Use `eval:report`
afterward when a JSON/Markdown aggregate is needed; the runner's `--require-complete` option uses
the same coverage evaluator as `eval:coverage`, including distinct-session floors and one
compatible matrix-wide hardware cohort.

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
