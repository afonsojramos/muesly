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

Use the confirmed withdrawal command rather than editing the manifest or deleting files by hand:

```bash
nub run eval:corpus:withdraw \
  --session-id session-opaque-001 \
  --confirm-withdrawal
```

The command removes every sample for the opaque session, atomically replaces the manifest, deletes
the session directory, and removes all derived results because their corpus fingerprint is stale.
It refuses to delete files outside the expected session directory. The external consent record is
not deleted automatically: retain or delete it according to the withdrawal and legal-retention
policy approved by counsel.

## Local intake

1. Prepare the next underfilled collection cell:

```bash
MUESLY_CORPUS_CONSENT_RECORDS_DIR=/approved/encrypted/muesly-consent-records \
  nub run eval:corpus:prepare
```

The command balances collection toward the least-covered language/noise cells, generates
opaque `session-*`, `consent-*`, and sample IDs, and creates a private gitignored bundle under
`intake/` plus a consent record in the explicitly selected external encrypted records directory.
Concurrent preparation calls serialize before reserving a cell.
It refuses to put consent records inside the Git repository. It does not create audio, assert
consent, or count the session toward coverage. Use `--language <code> --noise-condition <slug>`
to select a specific still-underfilled cell. The equivalent
`--consent-records-dir /approved/encrypted/path` flag can be used instead of the environment
variable.
Custom manifests outside the Git repository are supported. Inside the repository, preparation is
restricted to the explicitly ignored `app/scripts/eval/corpus-local.json` manifest and its
gitignored sibling `intake/` directory.
The generated intake command uses the absolute TypeScript entrypoint, so it can be run directly
from an external bundle directory.

2. Keep the affirmative consent record in the approved encrypted records system. Never put names,
   emails, meeting titles, customer names, or consent files in the manifest or Git checkout.
3. Produce a verbatim UTF-8 reference in the spoken language and export the matching audio as
   RIFF/WAVE. Remove an entire sensitive audio interval and its matching reference rather than
   retaining secrets or scoring a redacted transcript against unredacted speech.
4. Import the files. The explicit affirmation is mandatory; it means every audible participant
   consented to `asr-benchmarking` before recording. Use one opaque session ID for every clip
   from the same meeting—coverage counts distinct sessions, not files.

```bash
nub run eval:corpus:intake \
  --audio /private/intake/meeting.wav \
  --reference /private/intake/reference.txt \
  --sample-id es-office-001 \
  --session-id session-opaque-001 \
  --consent-record-id consent-opaque-001 \
  --consent-record app/scripts/eval/consent-records/consent-opaque-001.md \
  --consent-date 2026-07-16 \
  --language es --noise-condition office --speakers 3 \
  --affirm-all-participants-consented
```

The command initializes the gitignored `corpus-local.json` when absent, copies audio and
reference material under `local-corpus/session-.../` with private permissions, derives WAV
duration and exact hashes, rejects duplicate audio, validates the complete next manifest, and
retires a matching prepared source bundle after the manifest commit. Withdrawal also removes any
matching prepared bundle so revoked recordings and references are not retained or counted as
pending coverage. Intake rolls back files if any pre-commit step fails. An exclusive local lock
prevents simultaneous imports from losing manifest entries; a later run reclaims a lock whose
owner process no longer exists, removes only abandoned temporary files, and safely reuses exact
destination copies already promoted by an interrupted import. It verifies that
the supplied consent record exists but never copies its identity-bearing contents into the manifest.
It rejects consent records inside the managed `local-corpus/` and `results/` trees so session
withdrawal cannot delete externally retained consent evidence.
Intake accepts only the five target languages and four defined noise conditions so samples cannot
silently fall outside the matrix. After validating the imported copy, dispose of the source files
according to the approved retention policy.

5. Validate independently:

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

Before writing a real-run report, the evaluator revalidates the manifest while holding the same
local corpus lock used by intake and withdrawal. If the corpus changed during transcription, it
refuses to write a stale report containing removed samples; rerun that benchmark on the new corpus.

For CUDA, Vulkan, HIP, or Intel Metal, also pass
`--accelerator <stable-model-or-device-id>` (for example, the exact GPU model and PCI bus ID).
Apple Silicon Metal records its integrated accelerator identity automatically.

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
  --manifest app/scripts/eval/corpus-local.json \
  --json app/scripts/eval/results/aggregate.json \
  --markdown app/scripts/eval/results/aggregate.md
```

Do not publish model rankings from this corpus without reviewing session independence,
participant mix, failure examples, confidence intervals, and the limitations above.
