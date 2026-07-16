# Consented multilingual meeting corpus

This is the private intake and measurement procedure for the benchmark target in
`corpus-targets.json`. It is an operational baseline, not legal advice or a substitute for
review by counsel and an ethics/privacy owner.

The committed public-domain/synthetic corpus is only a smoke test. A quality claim about
meeting transcription requires real meeting speech. The initial target deliberately asks for
three distinct consented sessions in every combination of five languages (`en`, `es`, `pt`,
`fr`, `de`) and four conditions (`clean`, `office`, `remote-call`, `overlapping-speech`):
60 distinct-session cell observations. Each is then measured with the shipped Parakeet artifact and
the same Whisper artifact on CPU and Metal, producing 180 required measurement cells.
This floor exposes large product failures; it is not statistically representative of every
accent, demographic, device, or acoustic environment.

## Consent boundary

Before recording, every audible participant must receive a clear disclosure and make a
freely given, specific, informed, unambiguous affirmative choice. Refusal and withdrawal
must cause no disadvantage. The disclosure must name the controller, purpose, data types,
retention period, access/security boundary, and withdrawal route. The European Commission's
guidance says consent must be specific, informed, affirmative, and as easy to withdraw as to
give; it also calls for purpose limitation, data minimisation, storage limitation, and
appropriate safeguards:

- <https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/legal-grounds-processing-data/grounds-processing/when-consent-valid_en>
- <https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/legal-grounds-processing-data/grounds-processing/what-if-somebody-withdraws-their-consent_en>
- <https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en>

Use `consent-record.example.md` as a starting checklist. Keep the signed/affirmative record,
participant identities, and contact route encrypted outside the repository. The manifest may
contain only opaque `consent-*` and `session-*` IDs. Because workplace power imbalances can
make consent invalid, do not treat this template alone as sufficient for employee research.

If someone joins after recording begins, stop and obtain their consent before continuing or
delete that recording. On withdrawal, stop processing and remove the audio, reference,
manifest entries, and per-sample reports tied to the opaque session ID. Regenerate aggregates
from the remaining source reports. Follow any additional legal retention obligation documented
by counsel.

## Local intake

1. Copy `corpus-local.example.json` to the gitignored `corpus-local.json`.
2. Store audio and references under the gitignored `local-corpus/session-.../` directory.
   Use one opaque session ID for every clip from the same meeting; coverage counts distinct
   sessions, not files.
3. Create the consent record under the gitignored `consent-records/` directory or an encrypted
   records system. Never put names, emails, meeting titles, customer names, or consent files in
   the manifest.
4. Produce a verbatim reference in the spoken language. Remove an entire sensitive audio
   interval and its matching reference rather than retaining secrets or scoring a redacted
   transcript against unredacted speech.
5. Compute lowercase SHA-256 hashes for both files (`shasum -a 256 <file>` on macOS/Linux),
   record decoded audio duration, and validate:

```bash
nub run eval:corpus:validate app/scripts/eval/corpus-local.json
```

The validator requires schema 2, at least two speakers for meetings, participant consent,
local-only redistribution, opaque session/consent IDs, valid dates, exact hashes, and no
identity-bearing or unknown metadata fields. Identical audio cannot appear in more than one sample,
so copied recordings cannot satisfy multiple independent-session or language/noise coverage cells.

## Condition labels

- `clean`: quiet room, close microphone, no material competing speech.
- `office`: ordinary shared-room noise such as typing, HVAC, or distant speech.
- `remote-call`: conferencing codecs, speakerphone/headset paths, or network artifacts.
- `overlapping-speech`: at least one meaningful interval with simultaneous speakers; do not
  manufacture overlap by mixing unrelated recordings.

Keep recording device and microphone placement varied inside each cell, but do not encode
participant or customer identity in filenames or metadata.

## Measure and gate coverage

Run each variant with the same manifest, thresholds, and model artifact:

```bash
nub run eval:real --manifest app/scripts/eval/corpus-local.json \
  --provider whisper --model large-v3-turbo-q5_0 --backend cpu \
  --output app/scripts/eval/results/whisper-cpu.json

nub run eval:real --manifest app/scripts/eval/corpus-local.json \
  --provider whisper --model large-v3-turbo-q5_0 --backend metal \
  --output app/scripts/eval/results/whisper-metal.json

nub run eval:real --manifest app/scripts/eval/corpus-local.json \
  --provider parakeet --model parakeet-tdt-0.6b-v3-int8 --backend cpu \
  --output app/scripts/eval/results/parakeet-onnx-cpu.json
```

Check that every required language/noise/provider/model/backend cell has at least three
distinct sessions. The command fails with `--require-complete` while any cell is missing:

```bash
nub run eval:coverage --manifest app/scripts/eval/corpus-local.json \
  --report app/scripts/eval/results/whisper-cpu.json \
  --report app/scripts/eval/results/whisper-metal.json \
  --report app/scripts/eval/results/parakeet-onnx-cpu.json \
  --json app/scripts/eval/results/coverage.json --require-complete

nub run eval:report app/scripts/eval/results/whisper-cpu.json \
  app/scripts/eval/results/whisper-metal.json \
  app/scripts/eval/results/parakeet-onnx-cpu.json \
  --json app/scripts/eval/results/aggregate.json \
  --markdown app/scripts/eval/results/aggregate.md
```

Do not publish model rankings from this corpus without reviewing session independence,
participant mix, failure examples, confidence intervals, and the limitations above.
