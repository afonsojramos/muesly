# Public upstream-gold reference verification protocol

Protocol ID: `muesly-public-upstream-gold-v1`

This document is the normative verification contract for references reconstructed from pinned,
publicly licensed human transcripts. It applies only to sources in the schema-3 public source
catalog whose `reference_verification` field names one of the closed recipes below. The protocol
ID is bound through public corpus preparation, intake, benchmark tasks, checkpoints, reports,
aggregates, and coverage output. Any normative change requires a new protocol ID and fresh corpus
preparation and measurement; existing artifacts are never upgraded implicitly.

This is an exact-source verification protocol, not a local annotation protocol. Source-native
spelling, punctuation, capitalization, number forms, and other editorial conventions remain
unchanged except for the deterministic extraction rules declared by the selected recipe. The WER
scorer may apply its declared scoring normalization later, but preparation must not rewrite the
reference to imitate that normalization.

## Fail-closed acceptance contract

A public reference is accepted without local review only when all of these conditions hold:

1. The source catalog uses schema version 3 and catalog ID
   `muesly-public-asr-sources-v3`.
2. Every source names exactly one recognized `reference_verification` recipe, and its dataset and
   artifact kinds are the ones required by that recipe. Missing or unknown recipes fail.
3. Every downloaded artifact matches its committed URL, revision where applicable, byte size, and
   SHA-256 digest before it is read. Preparation may continue offline after these artifacts have
   been acquired and verified.
4. The schema-3 selection binds the source catalog ID, deterministic source selection and window,
   output audio hash, and exact reference SHA-256 digest.
5. The recipe rederives the reference from the verified source artifacts. The generated UTF-8
   bytes must match the selection's `reference_sha256`; an existing local reference file must be
   byte-identical. Preparation must never accept a changed file by recomputing and recording its
   new hash.
6. Prepared metadata records the recipe and exact reference digest. Snapshot and intake validation
   require the current file, prepared metadata, and committed selection to agree.

Every check is mandatory. A missing field, malformed digest, artifact drift, derivation drift,
recipe mismatch, or local byte change excludes the sample. Review attestations cannot rescue a
failure of this contract.

No local two-person review is required when, and only when, the complete exact-source contract
passes. This exemption says that the committed bytes are reproducibly upstream human gold; it
does not claim that public speakers consented to a private Muesly collection, or that the source
followed Muesly's private annotation style.

## Closed verification recipes

### `fleurs-tsv-composite-v1`

This recipe is valid only for a FLEURS source with exactly one pinned `audio-archive` artifact and
one pinned `index` artifact from the same committed dataset revision.

- Parse the pinned test TSV using the committed FLEURS parser and select utterances with the
  deterministic composite algorithm.
- Bind the exact ordered audio-member list, its SHA-256 commitment, member count, and composite
  duration in the selection.
- Trim the source transcript field for each selected row, preserve its remaining text verbatim,
  join the ordered fields with one ASCII space, and append one line-feed byte.
- Use those exact reference bytes for every deterministic audio condition derived from that
  composite. Each condition has its own committed audio digest but shares the composite's
  committed reference digest and session identity, so aggregate analysis cannot treat paired
  derivatives as independent source sessions.

### `ami-manual-words-window-v1`

This recipe is valid only for an AMI Meeting Corpus source with exactly one pinned meeting-audio
artifact and the pinned public manual-annotation archive.

- Select the window with the most timed lexical words at the committed duration and grid, using the
  committed AMI word-document ordering. Punctuation annotations are retained for rendering when
  they fall inside the selected window, but do not contribute to the density score or committed
  `word_count`.
- Bind the exact window boundaries, active-speaker count, word count, annotation-member count, and
  ordered annotation-member digest in the selection.
- Render only the manual word annotations retained by the committed window and boundary policy;
  crossing words are excluded. Ordering and text rendering are deterministic.
- The resulting UTF-8 bytes must match the sample's committed reference digest. The extracted
  audio must independently match its committed digest.

AMI's public manual annotations are the gold words. No ASR hypothesis may participate in this
recipe.

### `earnings21-human-reference-aligned-v1`

This recipe is valid only for an Earnings-21 source with exactly one pinned `audio` artifact, one
pinned human `reference` artifact, and one pinned `alignment-hypothesis` artifact. The reference
and alignment artifacts must each declare their exact upstream revision. The alignment artifact
must declare `role: "timing-only"`.

The human reference is the sole source of scored words. The timed Rev/Kaldi hypothesis may locate
the time-window boundaries, but none of its words may be copied into, substituted into, or used to
correct the reference.

The deterministic alignment must satisfy every gate below:

- exact aligned-pair ratio is at least `0.90`;
- normalized edit distance is at most `0.10`;
- each boundary is supported by an exact consecutive two-token context of normalized tokens;
- each boundary context occurs exactly once in both sides of the compared alignment context; and
- the matched timing edge is no more than `2.5` seconds from the requested audio edge.

The selection binds the alignment input sizes, edit distance, chosen human-reference token range,
output token count, and output reference digest. Preparation slices only that committed range from
the human reference, renders it deterministically, and requires the resulting bytes to match both
`expected_reference_seed_sha256` and the sample's `reference_sha256`. These two digests must be
equal.

## Required evidence

The reproducibility chain must retain enough committed metadata to prove, without network access:

- source ID, dataset revision, license, attribution, redistribution policy, and recipe;
- artifact IDs, kinds, roles where required, upstream revisions where required, sizes, and
  SHA-256 digests;
- source-catalog ID and exact catalog digest;
- selection schema, source-catalog ID, and exact selection digest;
- deterministic member, window, transform, and alignment commitments required by the recipe; and
- derived audio and reference SHA-256 digests.

The public corpus itself remains local-only. The catalog records upstream licensing and
attribution; it does not authorize redistributing the prepared bundle.

## Local corrections and private references

Do not edit a reference accepted under this protocol, even to fix an obvious upstream error. A
local change is no longer reproducible upstream gold and must fail exact-byte verification.

No public-reference correction workflow is implemented. The current public tooling cannot move a
sample into the private protocol, accept a corrected public reference, or produce qualification
evidence from locally edited public text. Exclude that sample from the public suites and restore the
exact upstream bytes if the unchanged public corpus is still needed. A future correction route must
introduce a separately versioned protocol, preparation recipe, review contract, manifest binding,
and fresh measurements before corrected text can be eligible. Never relabel a locally edited
reference as `muesly-public-upstream-gold-v1` or `muesly-meeting-reference-v1` in the current public
workflow.

Public upstream-gold evaluation complements, but does not replace, a consented multilingual
meeting corpus collected and reviewed under the private protocol.
