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
# WER: hypothesis vs reference (space-tokenized, lowercased)
node app/scripts/eval/wer.mjs \
  app/scripts/eval/fixtures/sample-ref.txt \
  app/scripts/eval/fixtures/sample-hyp.txt

# Rubric: counts required sections in a summary markdown
node app/scripts/eval/summary-rubric.mjs path/to/summary.md
```

Add more fixtures under `fixtures/` as real meetings are curated.

CI: `.github/workflows/eval-harness.yml` runs WER + rubric dry-run on changes to
`app/scripts/eval/**`. It checks that the harness scripts execute; it does not
gate merges on quality scores.
