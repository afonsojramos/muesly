# Eval harness

Offline checks for ASR/summary quality so model and pipeline changes are measurable.
Two tiers:

- **Dry-run** (`pnpm eval`, CI): scores pre-written hypothesis text against golden
  references — proves the scoring scripts, not the engine.
- **Real run** (`pnpm eval:real`, dev machines only): transcribes a checked-in audio
  fixture with the actual Whisper engine and gates its WER against the golden.

## Layout

```
app/scripts/eval/
  fixtures/           # golden transcripts (plain text) + real-speech.wav audio
  wer.mjs             # word error rate vs golden (importable `wer()` + CLI)
  summary-rubric.mjs  # checklist scoring of a summary markdown file
  real-run.mjs        # real-engine run: cargo example -> WER gate
```

## Usage

```bash
# From the repo root:
pnpm eval                 # multi-utterance golden (clean + noisy hyp)
pnpm eval:wer -- app/scripts/eval/fixtures/sample-ref.txt \
  app/scripts/eval/fixtures/sample-hyp.txt

# Or call node directly; --max-wer <pct> makes the run fail above a threshold:
node app/scripts/eval/wer.mjs \
  app/scripts/eval/fixtures/meeting-golden-ref.txt \
  app/scripts/eval/fixtures/meeting-golden-hyp.txt \
  --max-wer 0

# Rubric: counts required sections in a summary markdown
pnpm eval:rubric -- path/to/summary.md
```

## Real run (`pnpm eval:real`)

Runs the `transcribe-fixture` cargo example (`app/src-tauri/examples/`) over
every audio fixture and gates the results. Fixtures are auto-discovered:
each `fixtures/<base>.wav` with a sibling `fixtures/<base>-ref.txt`.

- A non-empty reference is a WER run (gated by `--max-wer`, default 10).
- An empty reference is a hallucination check: the engine should produce
  (near-)nothing (gated by `--max-hallucinated-words`, default 2).
  `silence.wav` is 20 s of deterministic ~-60 dBFS noise for exactly this.
- `--model <name>` (default `tiny`) A/Bs models on the same fixtures, e.g.
  `node app/scripts/eval/real-run.mjs --model large-v3-turbo`.
- `--fixture <base>` limits the run to one fixture.

Baseline (2026-07-12, Apple Silicon, Metal, `tiny`): `real-speech` 0.00% WER,
`silence` 1 hallucinated word. Re-measure after any decode-path change.

- **First-run costs:** compiles the Rust workspace, downloads FFmpeg during the
  build, and fetches the `tiny` model (~75 MB) into the gitignored dev models
  dir. Later runs reuse everything. Missing Tauri sidecar binaries are stubbed
  automatically (same approach as CI's rust-check).
- **Threshold:** default `--max-wer 10`. Calibration (2026-07-11, Apple Silicon,
  Metal): 3 consecutive runs of `tiny` on the fixture scored 0.00% WER, so 10%
  is a regression tripwire, not a quality bar. Re-calibrate by running it a few
  times after intentional decode changes and updating the default in
  `real-run.mjs`.
- **Backend variance:** the example builds with the workspace's default
  features (Metal/CoreML are hardwired on macOS); small cross-backend drift is
  absorbed by the threshold.
- **Fixture provenance:** `real-speech.wav` is a 27 s excerpt (16 kHz mono,
  ~0.9 MB) of the LibriVox recording of Lincoln's Gettysburg Address read by
  John Greenman (archive.org item `gettysburg_johng_librivox`, public domain).
  The reference is the canonical Bliss-copy text of the excerpt, cross-checked
  against `tiny` and `base` transcriptions. Additional clips must stay public
  domain or self-recorded, ≤ ~1 MB, with the reference and calibration updated.

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
