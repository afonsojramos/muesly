# Eval harness (scaffold)

Minimal offline checks for ASR/summary quality so model and pipeline changes are measurable.

## Layout

```
app/scripts/eval/
  fixtures/           # sample golden transcripts (plain text)
  wer.mjs             # word error rate vs golden
  summary-rubric.mjs  # checklist scoring of a summary markdown file
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

Fixtures:

| File | Role |
|------|------|
| `sample-*.txt` | Single-utterance smoke |
| `meeting-golden-ref.txt` | Multi-utterance sprint-planning reference |
| `meeting-golden-hyp.txt` | Clean hypothesis (expect ~0% WER) |
| `meeting-golden-hyp-noisy.txt` | ASR-like errors (non-zero WER) |

Add more fixtures under `fixtures/` as real meetings are curated.

CI: `.github/workflows/eval-harness.yml` runs WER (short + multi-utterance) +
rubric dry-run on changes to `app/scripts/eval/**`. Fixture WER is asserted
with `--max-wer` (0% for clean hypotheses, 10% for the noisy one); fixtures are
fixed files, so the thresholds are deterministic. No live model output is
scored or gated.
