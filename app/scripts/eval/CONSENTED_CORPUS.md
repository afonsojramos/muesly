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
Rust CI binds those committed variants to the High/Ultra Automatic Whisper recommendation, the
default Parakeet model, their supported evaluator backends, and every required integrity pin.
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
Concurrent preparation calls serialize before reserving a cell, and planning takes its manifest
snapshot under the same local mutation lock as intake and withdrawal.
It refuses to put consent records inside the Git repository. It does not create audio, assert
consent, or count the session toward coverage. Use `--language <code> --noise-condition <slug>`
to select a specific still-underfilled cell. The equivalent
`--consent-records-dir /approved/encrypted/path` flag can be used instead of the environment
variable.
Custom manifests outside the Git repository are supported. Inside the repository, preparation is
restricted to the explicitly ignored `app/scripts/eval/corpus-local.json` manifest and its
gitignored sibling `intake/` directory.
The generated single-line Bash/zsh and Windows PowerShell intake commands use the absolute
TypeScript entrypoint, so either can be run directly from an external bundle directory.

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

Run every provider/model/backend variant against the same manifest and thresholds. Pin one exact
artifact for each provider/model across all of that variant's backend reports; Whisper and
Parakeet, or two different model names, each retain their own artifact fingerprint.

Start with a safe plan. It validates the private corpus and target matrix, reports the number of
pending tasks, and does not build models or run inference:

```bash
nub run eval:corpus:benchmark \
  --manifest app/scripts/eval/corpus-local.json
```

Execute and checkpoint the campaign with:

```bash
nub run eval:corpus:benchmark \
  --manifest app/scripts/eval/corpus-local.json \
  --run --require-complete
```

The campaign coordinates with the corpus mutation lock, refuses to start while a withdrawal is
pending, and prevents intake, withdrawal, or unrelated result writes during a run. Every completed
sample is written atomically as a private, transcript-free checkpoint, so an interrupted command
can be re-run safely. Resume requires the exact corpus sample revision, thresholds, evaluator
revision, model artifact, benchmark executable, backend, accelerator, and hardware cohort. Quality
failures remain checkpointed and make the command exit non-zero. `--require-complete` also rejects
an empty or underfilled corpus and requires one compatible hardware cohort across the full target
matrix.
After a crash, a supported corpus mutation reclaims only a provably dead campaign owner and
preserves the old lock as private evidence; uncertain process identity still fails closed. Before
installing a mutation lock, commands enforce pending-withdrawal authorization and check campaign
ownership; they repeat both checks after installation. Rejected campaigns therefore cannot hold the
lock or run recovery, and checkpoint writes tolerate only the remaining brief race window. Final
verification requires the exact checkpoint names, identities, and content digests observed by the
campaign.
Use repeatable `--variant provider/model/backend` options for a subset and
`--accelerator backend=stable-device-id` where the selected backend requires an explicit GPU
identity. A subset cannot be combined with `--require-complete`, which always certifies the full
target matrix.

Before writing a real-run report, the evaluator revalidates the manifest while holding the same
local corpus lock used by intake and withdrawal. If the corpus changed during transcription, it
refuses to write a stale report containing removed samples; rerun that benchmark on the new corpus.
Run-report schema 9 also persists the versioned WER scorer, a clean evaluator revision, and the
SHA-256 digest of the exact benchmark executable. The evaluator revision binds the result to the
Git commit, `Cargo.lock`, `rustc -vV`, release target and Cargo features, and a digest of the
allowlisted build environment. Report generation therefore requires a clean Git worktree and
rechecks the revision after transcription. Git, Cargo, and rustc command launchers are resolved
from sanitized absolute command-search paths, and each launcher's canonical path and bytes are
attested around its invocation. Full `rustc -vV` output binds the selected Rust toolchain identity;
when rustup provides the launcher, this attests the rustup shim rather than claiming the selected
compiler's internal binary bytes. Compiler-wrapper environment variables (`RUSTC_WRAPPER` and
`RUSTC_WORKSPACE_WRAPPER`) must be unset or empty, and highest-precedence Cargo CLI configuration
forces both wrapper settings empty so parent or `CARGO_HOME` configuration cannot interpose. The
provider/backend executable and model are built, prepared, and privately snapshotted once per
campaign variant, then the exact snapshot is invoked directly for every selected sample;
for every committed CPU/Metal Whisper and ONNX-CPU Parakeet target, preparation returns the
canonical product-pin digest and the runner requires both the source artifact and private snapshot
to match it. Unknown pins and mismatched bytes fail non-destructively before inference.
metrics schema 7 must repeat its backend, platform, hardware, accelerator, executable identity,
and exact corpus audio SHA-256. The campaign captures digest-bound reference text in memory,
revalidates the selected audio and reference immediately before and after inference, and writes
each checkpoint through the same manifest/lock lease without reloading every corpus sample.
Schema 7 preserves source-audio RTF and also records the exact post-VAD audio duration passed to
ASR plus model-input RTF. A sample with no ASR input records a null model-input RTF; aggregate
reports label and weight the two RTF definitions separately.
When scoring, source/toolchain inputs, or tokenization semantics change, rerun every
variant: coverage and aggregation reject legacy or incompatible reports.

Model preparation completes before measurement, and the exact provider/model artifact set is
fingerprinted before the first sample and after the last. A report is refused if the model bytes
change. Each sample then runs in a fresh benchmark process so process-local engine state is reset;
host file caches and accelerator/runtime caches may remain warm, so this is not a cold-cache claim.
Only an allowlisted benchmark runtime environment is forwarded. Adaptive-memory overrides and
operational logging are removed, and a digest of the remaining ambient inputs is bound into the
hardware profile. The requested acceleration policy and accelerator identity are bound separately,
so CPU and accelerator variants from one machine retain a comparable profile.

For CUDA, Vulkan, HIP, or an Intel Mac GPU backend, also pass
`--accelerator <stable-model-or-device-id>` (for example, the exact GPU model and PCI bus ID).
Apple Silicon Metal and Core ML record their integrated accelerator identity automatically.
Select Core ML with `--backend coreml`; the resulting metrics and coverage cell use the canonical
reported backend name `coreml-metal`. The primary GGML file is verified against its product pin;
because a locally compiled Core ML encoder bundle has no distribution pin, its complete composite
artifact is fingerprinted and privately snapshotted for reproducibility but is explicitly not
reported as a canonical product artifact. Core ML remains available for diagnostic target matrices
but is not part of the fully canonical CPU/Metal/Parakeet 180-cell floor described above.

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

Check that at least one matrix-wide hardware cohort has three distinct sessions in every required
language/noise/provider/model/backend cell. A cohort fixes the OS, architecture, and machine
profile across the whole matrix and uses one consistent accelerator identity per backend. Raw and
best-per-cell counts remain visible for diagnostics, but stitching individually complete cells
from different machines or accelerator identities does not satisfy coverage schema 8. Coverage
schema 8 also pins the evaluator-revision and benchmark-executable digest for every backend. The
command fails with `--require-complete` until the corpus cells and one full-matrix cohort are
complete:

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

The explicit `eval:real` commands above remain useful for one-off diagnostics. The campaign runner
is the canonical way to fill and resume the target matrix; use `eval:report` afterward to create
reviewable aggregate JSON and Markdown. Aggregate schema 7 keeps each provider/model/reported-
backend variant separate and emits comparison tables only when every supplied variant measured the
identical set of sample IDs. Unequal or interrupted cohorts remain available as clearly labelled
per-variant diagnostics, but the report does not score their intersection because missing
measurements may be failures. Report comparison covers only supplied variants; the coverage command
above remains the target-completeness authority.

RSS columns are sampled evaluator-process host memory, not model-only allocation or accelerator
VRAM. Sampling runs every 10 ms from immediately before model load through the end of inference.
The aggregate shows both the absolute sampled peak and its increase from the pre-model-load
baseline; it may miss a shorter peak between samples.

Do not publish model rankings from this corpus without reviewing session independence,
participant mix, failure examples, confidence intervals, and the limitations above.
