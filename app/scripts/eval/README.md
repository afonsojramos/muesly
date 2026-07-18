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
  REFERENCE_TRANSCRIPTION.md # versioned private/corrected-reference annotation contract
  PUBLIC_REFERENCE_VERIFICATION.md # exact public upstream-gold verification contract
  corpus.ts            # manifest validation and language normalization
  corpus-targets.ts    # shared target validation and exact sample resolution
  corpus-prepare.ts    # scaffold the next private consented collection session
  corpus-attest.ts     # hash-bound private reference-review acceptance
  corpus-review.ts     # immutable two-review attestation gate
  corpus-prepared-bundle.ts # schema-3 prepared-bundle validation and retirement
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
  model-prepare.ts                  # product-path model download + canonical verification
  public-corpus-sources.json      # immutable source, license, size, and SHA-256 pins
  public-corpus-selection.json    # deterministic 66-sample construction contract
  public-corpus-prepare.ts        # safe download, extraction, and audio derivation
  public-corpus-attest.ts         # reserved local-correction attestation CLI
  public-corpus-finalize.ts       # verified local public-manifest finalization
  public-corpus-validate.ts       # full reconstruction and provenance validation
  public-corpus-campaign.ts       # fixed-suite campaign wrapper
  public-corpus-materialize.ts    # checkpoint-to-evidence materialization
  public-corpus-qualification.ts  # fail-closed policy and retention decisions
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

## Reproducible public ASR corpus

The public workflow constructs 66 local-only samples from immutable, explicitly licensed source
files:

- 60 paired FLEURS samples: five languages, three non-reused clean composites of 120–180 seconds,
  and four conditions (clean, deterministic 10 dB office noise, remote-call degradation, and 25%
  overlap). For these composites, `speakers` records maximum simultaneous speech, not the number
  of distinct source readers. The overlap transform can shorten an output slightly below 120
  seconds;
- three deterministic 180-second natural-meeting excerpts from AMI; and
- three deterministic 180-second natural remote-call excerpts from Earnings-21.

FLEURS and AMI are CC BY 4.0; Earnings-21 is CC BY-SA 4.0. The committed catalog records the exact
revision, URL, size, SHA-256, license, attribution, and local-only redistribution policy. Random
online meetings, podcasts, and videos are not accepted merely because they are publicly reachable.
FLEURS is read speech and must never be described as natural multilingual meeting evidence. The
selected FLEURS speakers are also materially imbalanced by the source test splits: selected
utterances are 28 female/20 male for English, 13/27 for Spanish, 0/33 for Portuguese, 5/36 for
French, and 0/33 for German. Portuguese and German are all-male in the pinned test split, so this
bootstrap cannot support gender-robustness claims. It also uses one pinned locale per language, so
it cannot support accent- or dialect-robustness claims. No sensitive sample-level gender metadata
is added to the manifest. AMI contributes natural meeting content, but the selected
`Mix-Headset.wav` files are close-talk headset mixes rather than room or office microphones. Its
dense 180-second lexical-word windows deliberately overrepresent high speech density rather than
typical pauses and silence. AMI and Earnings-21 are both English-only here;
there is no natural Spanish, Portuguese, French, or German speech in this public bootstrap.
The deterministic selection commits the exact FLEURS member order, AMI windows, FFmpeg executable,
and generated WAV SHA-256 for all 66 samples. For each Earnings-21 call, it also pins Rev's timed
Kaldi output as an alignment hypothesis. The hypothesis contributes timestamps only: preparation
aligns it to Rev's separate public human reference, then slices and renders human-reference tokens.
Those gold references come from Rev's explicitly licensed `transcripts/nlp_references` tree at the
same pinned upstream revision as the timing hypotheses, including upstream transcript corrections.

Prepare the ignored workspace from the repository root. Network access is opt-in, every missing
source is downloaded through a resumable `.part` file, archives are checked for traversal and link
entries before selective extraction, and the command preserves a 20 GiB free-space reserve after
accounting for missing sources and generated output:

```bash
nub run eval:public:prepare --download
```

Preparation rederives exact human-reference bytes from the pinned public artifacts and requires
them to match the reference hashes committed in the selection; it does not create
`corpus-local.json`. FLEURS uses its source transcript field, AMI uses its manual word annotations,
and Earnings-21 slices only Rev's human reference after using the separate timed hypothesis to
locate unique exact boundary contexts. The full fail-closed contract lives in
[PUBLIC_REFERENCE_VERIFICATION.md](PUBLIC_REFERENCE_VERIFICATION.md). When that contract passes,
the references are reproducible upstream human gold and do not need a second local two-person
review.

Do not edit a prepared upstream-gold reference, even by one byte. Preparation and finalization
reject local changes instead of accepting a newly computed hash; restore the exact source-derived
bytes. No corrected-public-reference path is implemented. Locally edited public text is excluded
from these suites until a separately versioned correction protocol, preparation/review workflow,
manifest binding, and fresh measurements exist; the private two-person contract alone does not
make it eligible.

Finalize and revalidate the exact verified projection. Finalization first replays all 66 audio and
reference derivations from the pinned cache with the approved FFmpeg under the shared corpus lock.
Every regenerated artifact must byte-match both the existing prepared file and its committed hash
before `corpus-local.json` can be published:

```bash
nub run eval:public:finalize \
  --affirm-reference-protocol muesly-public-upstream-gold-v1
nub run eval:public:validate
```

Audio, references, verification metadata, the finalized manifest, checkpoints, and reports stay
under the ignored `app/scripts/eval/public-corpus/` workspace. Finalization fails if a source pin,
selection, generated file, duration, reference digest, verification recipe, or manifest field has
drifted.

Every fixed public suite uses coverage-target schema 4 and binds the exact committed source-catalog
SHA-256, selection SHA-256, corpus ID, and finalized corpus fingerprint. Planning, coverage, and
qualification all reject a custom or stale corpus even when its catalog and selection are
self-consistent. Updating the public corpus therefore requires deliberately updating every fixed
binding and rerunning all measurements.

Run a fixed public benchmark suite through the provenance-revalidating campaign wrapper. Omitting
`--run` produces a safe plan; add it only after the required pinned models are present:

```bash
nub run eval:public:campaign \
  --suite automatic-policy \
  --models-dir "$HOME/Library/Application Support/com.muesly/models"
```

- `automatic-policy` measures every verified public sample against the primary non-translation
  tier recommendations, a Turbo CPU comparison, selected higher-capability Whisper fallbacks, and
  the Parakeet fallback. It intentionally keeps the accepted seven-variant policy matrix: 66
  samples × 7 variants = 462 tasks.
- `catalog-audit` runs the remaining shipped Whisper artifacts, including Tiny Q5_1 and other
  fallback-only models, on a fixed ten-sample CPU slice. The slice retains all five languages,
  both natural sources, and all four transformed/read conditions while selecting a distinct source
  session for every sample; paired transformed samples use composite 02 rather than reusing each
  composite 01 clean source. Those audit-only artifacts are not primary Automatic tier
  recommendations and do not expand the policy matrix: 10 samples × 7 variants = 70 tasks.
- `performance` repeats that fixed slice three times against the Automatic-policy matrix: 10
  samples × 7 variants × 3 repeats = 210 tasks.

`automatic-policy` and `performance` include a Metal target and are therefore macOS-only suites.
On Apple Silicon their integrated accelerator identity is derived automatically; Intel Mac runs
must provide a stable `--accelerator metal=<device-id>`. `catalog-audit` is CPU-only and can run on
every evaluator platform supported by the benchmark harness. A complete suite must be measured on
one compatible hardware cohort; do not combine CPU results from one machine with Metal results
from another to claim completion.

Treat model-policy changes as a separate, fail-closed decision step. Provisional qualification
policy v3 (`muesly-public-asr-qualification-v3`, qualification schema 3) requires aggregate schema
12 and uses only its session/singleton-unit-balanced headline metrics for quality, speed, and
memory.
Automatic-policy and performance coverage must both be complete, every input measurement must be
task-bound schema 11, and all evidence must come from one macOS/arm64 hardware cohort. A candidate
is exploratorily eligible only when its performance `unit_balanced.p95_inference_rtf` is below 1.0.
Among such candidates, its `hard_wer_overall.unit_balanced.wer_percent` must be within 2 points of
the best result and its worst decision-eligible language/noise slice must be within 5 points of the
best worst-slice result. `hard_wer_overall` first removes `synthetic-overlap` records, whose mixed
audio has no unambiguous serial reference order, and then reruns the exact
session-ID-or-singleton-sample reduction. The 15 paired FLEURS sources therefore remain 15 units,
not 45 condition units; with three AMI and three Earnings units, the public bootstrap has only 21
independent analysis units. Overlap results remain diagnostic quality evidence and remain included
in performance and memory evidence. Prefer the smallest exploratory candidate; when measured
inference speed differs by less than 10%, use lower `unit_balanced.max_peak_rss_mb` and then download
size as deterministic tie-breakers.

This 21-unit public bootstrap is provisional. Its candidate and full-precision retention rankings
are exploratory only: `may_update_tiers` is empty, catalog visibility changes are forbidden, and
Low, Medium, High, Ultra, translation behavior, and download visibility remain unchanged. Promotion
requires corroboration from the separate `consented-multilingual-meetings-v1` target: at least
three genuinely consented natural meeting sessions in every combination of five languages and four
noise conditions (60 independent session-cell observations) under
`muesly-meeting-reference-v1`. A qualification report never edits production configuration.
Catalog-audit evidence is optional for an exploratory candidate ranking but required to emit
exploratory full-precision retention signals.

Materialize each completed suite's resumable checkpoints into its aggregate and coverage
evidence. Materialization replays the exact campaign plan, requires every planned task to have
exactly one checkpoint on one hardware cohort, and rejects incomplete or mixed campaigns (other
suites, stale corpus or evaluator revisions, drifted thresholds) without writing anything:

```bash
nub run eval:public:materialize --suite automatic-policy
nub run eval:public:materialize --suite performance
nub run eval:public:materialize --suite catalog-audit
```

After producing aggregate and coverage JSON for the completed suites, generate the reviewable
decision report on standard output:

```bash
nub run eval:public:qualify \
  --automatic-aggregate app/scripts/eval/public-corpus/results/automatic-policy-aggregate.json \
  --automatic-coverage app/scripts/eval/public-corpus/results/automatic-policy-coverage.json \
  --performance-aggregate app/scripts/eval/public-corpus/results/performance-aggregate.json \
  --performance-coverage app/scripts/eval/public-corpus/results/performance-coverage.json \
  --catalog-aggregate app/scripts/eval/public-corpus/results/catalog-audit-aggregate.json \
  --catalog-coverage app/scripts/eval/public-corpus/results/catalog-audit-coverage.json \
  > app/scripts/eval/public-corpus/results/qualification.json
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

Prepare the pinned model candidates before a benchmark campaign. The model directory must be an
explicit absolute path outside the repository; downloads are sequential and each artifact is
verified against the product integrity pin before the next model starts:

```bash
nub run eval:models:prepare \
  --models-dir "$HOME/Library/Application Support/com.muesly/models" \
  --set policy
```

Use `--set catalog-audit` for the legacy/full-precision comparison set or `--set all` for both.
The command reserves 20 GiB only when a download is pending; an all-present read-only verification
does not require or probe that reserve. It reuses already verified models and never writes model
bytes to the repository. Preparation re-attests the canonical model root, provider directories,
and single-link artifacts before and after external product commands. Product downloads,
deletions, and cancellation cleanup share an OS-backed per-model lock across app and evaluator
processes, download into confined `.part` files, verify them before publication, and reject unsafe
resume ranges or link/reparse-point aliases.

Prepare the next underfilled language/noise cell before recruiting or recording:

```bash
MUESLY_CORPUS_CONSENT_RECORDS_DIR=/approved/encrypted/muesly-consent-records \
  nub run eval:corpus:prepare
```

This creates a gitignored, private-permission schema-3 session bundle, an opaque consent record in
the explicitly selected external encrypted records directory, a blank reference transcript, and a
private review-attestation directory. It refuses repository-local consent storage, never creates
fake audio, and never marks consent as granted. The generated README contains exact Bash/zsh and
Windows PowerShell commands for two distinct opaque reviewers followed by intake. Each accepted
review is bound to the current audio and reference SHA-256 plus
`muesly-meeting-reference-v1`; intake requires exactly two such records and accepts files only from
the generated bundle.

Editing either prepared file makes all existing reviews stale. Both reviewers must review the final
artifacts again: the first new attestation invalidates the stale pair and records the first new
acceptance, then the second distinct reviewer records the second acceptance. Reviewer IDs,
decisions, and timestamps remain in the private prepared bundle and are never copied into
`corpus-local.json`. Successful intake retires the complete prepared bundle, including its review
records; confirmed withdrawal performs the same recursive cleanup for any matching pending bundle.
Retirement waits for active review work, deletes only the exact validated directory identity, and
lets confirmed withdrawal finish an interrupted retirement claim.

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
- `--models-dir <path>` selects an existing app model directory. Benchmark preparation is
  deliberately read-only: it never downloads, resumes, repairs, replaces, or deletes model files.
  Download the model with muesly first; canonical-target files must then match the product pins.
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
- Writing a report requires a clean Git worktree. Standalone run schema 10 and campaign checkpoint
  schema 11 record the manifest's versioned reference protocol: `muesly-meeting-reference-v1` for
  private or locally corrected references, or `muesly-public-upstream-gold-v1` for exact public
  source-native references. They also record a versioned evaluator. Schema 11 binds the evaluator
  output to the planned benchmark task digest and
  repeat before inference, so a cached report cannot be reused for another repetition. Both record a
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

Aggregate one or more run reports into transcript-free JSON and Markdown summaries. `--manifest`
is mandatory for every aggregation, including stdout-only diagnostics, because aggregation units
are derived from the authoritative corpus manifest:

```bash
nub run eval:report app/scripts/eval/results/whisper-metal.json \
  app/scripts/eval/results/parakeet-cpu.json \
  --manifest app/scripts/eval/corpus-local.json \
  --json app/scripts/eval/results/aggregate.json \
  --markdown app/scripts/eval/results/aggregate.md
```

Aggregate schema 12 records the reference protocol and
`aggregation_unit_policy: "session-id-or-singleton-sample-v1"`, and treats provider, model, and
reported backend as one indivisible variant. It derives a session unit for samples that share a
manifest `session_id`; every public or non-meeting sample without one becomes its own explicit
singleton-sample unit. Raw session IDs are used only in memory for grouping and are never emitted in
aggregate JSON or Markdown.
This policy does not infer hidden source-speaker or source-recording relationships: a prepared
public composite without `session_id` remains one singleton unit. Any future source-balanced public
policy must add an explicit manifest grouping identity rather than guessing from catalog metadata.

Each summary exposes two metric families. Existing flat fields remain measurement-weighted
diagnostics: micro WER is total word errors divided by total reference words; flat macro WER is the
mean per-measurement WER; and flat duration-weighted, median, and nearest-rank p95 source-audio and
model-input inference RTF, sampled evaluator-process host RSS, and silence metrics retain their
previous meanings. The nested `unit_balanced` object supplies the headline and qualification
metrics. Its reduction order is repeats to samples, samples to manifest-session or singleton-sample
units, then an equal-weight reduction across units. This prevents repeated measurements, sessions
split into more clips, and longer sessions from receiving extra weight. Within each unit, peak RSS
and peak-minus-baseline RSS use the maximum observed sample value before unit-level distributions
are calculated. Because p95 uses nearest rank, 1–19 eligible units make p95 equal the observed
maximum; treat such a p95 as a low-resolution diagnostic rather than a stable tail estimate.
Language, scenario, and noise summaries rebuild units from the samples in each slice, so one
multilingual or mixed-noise session can contribute once to multiple slice rows; those row counts do
not partition the overall unit count.
Schema 12 also emits `hard_wer_overall`: it excludes `synthetic-overlap` measurements before
repeating the same sample/session reduction, so ambiguous serial ordering cannot influence hard WER
decisions and paired FLEURS derivatives cannot be mistaken for independent sessions.

Diagnostic summaries retain every observed sample but are isolated by exact variant, with overall,
public-dataset, language, scenario, noise-condition, and language/noise dimensions. Public samples
are reported separately as `fleurs`, `ami`, or `earnings21`. The report emits cross-variant tables
only when at least two supplied variants contain the identical sample-and-repeat measurement
identities. Equal counts are not enough, and unequal cohorts are not reduced to a post-hoc
intersection: missing measurements may be failures, so that would introduce survivorship bias.
Instead, partial runs retain clearly labelled per-variant diagnostics plus
observed/common/missing counts.

Comparison rows preserve the full provider/model/backend identity in the variant, dataset/variant,
language/variant, scenario/variant, noise-condition/variant, and language/noise/variant dimensions.
The comparison scope covers only supplied variants and does not certify the target matrix; use
`eval:coverage --require-complete` for that gate. Inputs must use standalone run-report schema 10 or
campaign run-report schema 11 with metrics schema 7, name the same corpus revision, and use
identical pass thresholds and OS/architecture.
Schema 10 may omit `repeat_index` or declare only repeat 1; repeated coverage requires schema 11.
Coverage and aggregation reject reused campaign task IDs and bind each ID to one exact
provider/model/backend/sample/repeat measurement. The campaign checkpoint validator remains the
authority that recomputes each digest against the full immutable plan, including evaluator and
accelerator context.
Within each provider/model, all reports must fingerprint identical model bytes; different
provider/model variants retain their own artifact fingerprints. The aggregator also requires
matching sample identity, scorer, machine profile, accelerator, evaluator revision, and executable
context before comparison. Aggregate JSON and Markdown retain separate report and measurement
counts for standalone schema-10 inputs and task-bound schema-11 inputs.
Run-report schemas 10 and 11 record the versioned reference protocol and WER scorer
(`muesly-wer-unicode-v1`);
coverage and aggregation reject reports with missing or different scoring semantics. CPU and GPU
reports from one machine can be combined; reports using different accelerators for the same
backend cannot.
Aggregate schema 12 records both diagnostic and unit-balanced RTF definitions, measurement,
distinct-sample, session-unit, and singleton-unit counts, the aggregation-unit policy, comparison
status, common evaluator inputs, the full evaluator
revision, and exact benchmark-executable digest for every backend. Coverage schema 12 similarly
records the corpus
fingerprint, reference protocol, verified model-artifact map, evaluator-revision digest by backend,
and executable
digest by backend, so a saved completeness result remains bound to the exact corpus revision,
evaluated bytes, source/toolchain inputs, and binary.
Measurement completeness requires one compatible hardware cohort to satisfy the session floor
across the entire requested matrix. The operating system, architecture, and machine profile must
match for every cell, with one consistent accelerator identity per backend. Coverage schema 12
retains raw cross-machine counts and the largest compatible distinct-unit count per cell for
diagnostics, then
enumerates matrix-wide cohorts separately. A matrix assembled from individually complete cells on
different machines or accelerators remains incomplete.

Corpus schema 4 adds source-catalog-bound `public-license` provenance without weakening private
custody: participant recordings still require local-only consent records and opaque sessions.
Coverage-target schema 4 is discriminated by `coverage_mode`. The existing
`language-noise-matrix` mode retains the consented-meeting session floor; `explicit-samples` names
the exact sample IDs in one benchmark suite. An optional `repetitions` value from 1 through 10
creates distinct, resumable task identities for every sample/variant/repeat and requires every
repeat on one compatible hardware cohort. Hardware-cohort entries report `distinct_units`: a unit
is a consented session in matrix mode and an exact sample in explicit-sample mode. Schema 4 can
bind an exact corpus ID, corpus fingerprint, source-catalog digest, and selection digest as one
all-or-nothing revision contract. Existing valid schema-2 matrix and schema-3 target files are
normalized in memory to schema 4; fixed public targets are committed as schema 4.

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
VRAM. Benchmark preparation requires a pre-downloaded model and happens before the measured sample
processes, so `model_download_seconds` records zero while `model_load_seconds` still measures each
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

- **First-run costs:** compiles the Rust workspace in the release profile and downloads FFmpeg during
  the build. Download the selected transcription model with muesly before running the benchmark;
  the harness intentionally never mutates model storage. Later runs reuse the evaluator build.
  Missing Tauri sidecar binaries are stubbed automatically (same approach as CI's rust-check).
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
  manifest entry. Private meeting recordings require an opaque consent-record ID and explicit
  `asr-benchmarking` consent; open-licensed meeting recordings require a pinned source-catalog
  digest and per-sample source-item binding.

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
