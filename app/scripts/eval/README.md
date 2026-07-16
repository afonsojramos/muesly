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
  corpus.mjs           # manifest validation and language normalization
  coverage.mjs         # coverage gate across language/noise/model/backend cells
  fixtures/            # golden transcripts + repository-safe audio
  wer.mjs             # word error rate vs golden (importable `wer()` + CLI)
  summary-rubric.mjs  # checklist scoring of a summary markdown file
  real-run.mjs        # real-engine run: cargo example -> WER gate
  report.mjs          # aggregate run reports by corpus and hardware dimensions
```

## Usage

```bash
# From the repo root:
nub run eval              # multi-utterance golden (clean + noisy hyp)
nub run eval:wer app/scripts/eval/fixtures/sample-ref.txt \
  app/scripts/eval/fixtures/sample-hyp.txt

# Or call node directly; --max-wer <pct> makes the run fail above a threshold:
node app/scripts/eval/wer.mjs \
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

- A non-empty reference is a WER run (gated by `--max-wer`, default 10).
- An empty reference is a hallucination check: the engine should produce
  (near-)nothing (gated by `--max-hallucinated-words`, default 2).
  `silence.wav` is 20 s of deterministic ~-60 dBFS noise for exactly this.
- `--provider whisper|parakeet` (default `whisper`) and `--model <name>` A/B engines
  and artifacts on the same fixtures. Parakeet defaults to `parakeet-tdt-0.6b-v3-int8`.
- `--backend cpu|metal|cuda|vulkan|openblas|hipblas` selects the compiled Whisper
  backend (default `cpu`). Parakeet currently uses ONNX Runtime CPU and accepts only `cpu`.
  CPU and OpenBLAS runs explicitly disable GPU execution; GPU runs fail instead of silently
  falling back when the requested backend cannot initialize.
- `--models-dir <path>` reuses an existing app model directory instead of downloading
  another copy into the development directory.
- `--output <path>` writes a transcript-free JSON report containing WER or hallucination
  count, inference RTF, model-load/inference timings, peak RSS, OS, architecture, machine profile,
  backend,
  and a SHA-256 fingerprint of the exact model artifact bytes.
- `--fixture <sample-id>` limits the run to one uniquely named manifest sample.
- The real run uses the same long-pause VAD segmentation and segment-quality filter as
  the post-meeting production pass, so it catches pipeline regressions as well as model ones.
- BCP-47 locales are reduced to their primary language for Whisper (`en-US` → `en`).
  Set `whisper_language` in the manifest when an explicit mapping is needed; unsupported
  Whisper codes fail before inference.

Aggregate one or more run reports into transcript-free JSON and Markdown summaries:

```bash
nub run eval:report results/whisper-metal.json results/parakeet-cpu.json \
  --json results/aggregate.json --markdown results/aggregate.md
```

Reports contain micro-averaged WER (total word errors divided by total reference words),
duration-weighted inference RTF, peak RSS, and silence hallucinations. They group those metrics by
language, noise condition, hardware backend, provider/model, and the combined
language/noise/backend matrix. This avoids treating a five-word clip as equally important
as a five-minute meeting. Inputs must use run-report schema 5, name the same corpus revision, and
use identical pass thresholds, model bytes, and OS/architecture; the aggregator rejects
comparisons that would lose that artifact, machine-profile, or evaluation context.
Coverage JSON also records the corpus fingerprint and verified model-artifact map so a saved
completeness result remains bound to the exact corpus revision and evaluated bytes.

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
  `real-run.mjs`.
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

| File | Role |
|------|------|
| `sample-*.txt` | Single-utterance smoke |
| `meeting-golden-ref.txt` | Multi-utterance sprint-planning reference |
| `meeting-golden-hyp.txt` | Clean hypothesis (expect ~0% WER) |
| `meeting-golden-hyp-noisy.txt` | ASR-like errors (non-zero WER) |
| `real-speech.wav` + `real-speech-ref.txt` | Audio + golden for the real-engine run |
| `silence.wav` + empty `silence-ref.txt` | Near-silence audio for the hallucination check |

Add more fixtures under `fixtures/` as real meetings are curated.

CI: `.github/workflows/eval-harness.yml` runs WER (short + multi-utterance) +
rubric dry-run on changes to `app/scripts/eval/**`. Fixture WER is asserted
with `--max-wer` (0% for clean hypotheses, 10% for the noisy one); fixtures are
fixed files, so the thresholds are deterministic. **CI never runs `eval:real`**
— the real run needs a Rust build, a model download, and hardware-dependent
inference, so it stays a dev-machine check by design.
