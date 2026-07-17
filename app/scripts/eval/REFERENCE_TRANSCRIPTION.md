# Meeting reference transcription protocol

Protocol ID: `muesly-meeting-reference-v1`

This document is the normative annotation contract for every reference used by the Muesly
meeting benchmark. The protocol ID is part of the corpus manifest, target matrix, prepared intake
metadata, benchmark task identity, run/checkpoint reports, aggregates, and coverage output. A
change to a normative rule requires a new protocol ID and fresh review and measurement; legacy
private corpora, prepared bundles, checkpoints, reports, and aggregates are never upgraded
implicitly.

The protocol controls the reference text, not the corpus language stratum. `language` remains a
human-assigned collection label. Preserve code-switching exactly; do not infer a different stratum
from token proportions, and do not apply an automatic language-percentage rule.

## Required review procedure

1. A primary annotator listens to the complete retained audio and drafts the reference without
   consulting an ASR hypothesis.
2. A second reviewer independently listens to the same retained audio before reviewing the draft.
3. The annotator and reviewer compare the two renderings, replay every disagreement, and resolve
   one final reference. Never settle an uncertainty by copying model output.
4. Confirm that the retained audio and final reference cover the same intervals, the declared
   primary language and noise condition are the intended human-assigned collection stratum, and no
   private interval marked for removal remains in either artifact.
5. Only then affirm
   `--affirm-reference-protocol muesly-meeting-reference-v1` during intake.

## What to transcribe

- Transcribe lexical speech only. Do not add timestamps, speaker labels, turn markers, confidence
  values, or non-speech tags such as `[noise]`, `[music]`, or `[laughter]`.
- Write numbers, dates, times, percentages, units, and currency as spoken words. For example,
  transcribe “twenty five euros,” not `€25`.
- Write an initialism as separated spoken letters (`I B M`). Write an acronym pronounced as a word
  as that word (`NASA`).
- Preserve filled pauses using the ordinary spelling for the spoken language (`um`, `uh`, `eh`,
  `euh`, and equivalent forms). Use one spelling consistently within a language.
- Preserve repetitions, self-corrections, false starts, and audible word fragments. Render an
  incomplete fragment with a trailing hyphen, for example `the pro- the project`.
- Preserve the words actually spoken during code-switching, including their original language and
  diacritics. Do not translate or transliterate them to the declared primary language.
- For overlap, linearize utterances by audible onset: earlier onset first. If onsets cannot be
  distinguished, use one stable speaker order for that clip. Do not merge simultaneous words into
  invented phrases.
- Never guess unintelligible speech and never insert an “unknown” token or tag. Remove the complete
  unintelligible or sensitive interval from both audio and reference before intake. If removal
  would make the sample unusable, exclude the sample.

## Text form and scoring

- Store the final reference as valid UTF-8 text in the spoken language.
- Punctuation, capitalization, and line breaks are editorial aids and are ignored by the WER
  scorer. Spelling, word choice, and meaningful diacritics are not ignored.
- Do not normalize away dialectal or grammatical forms that were actually spoken.
- A retained speech sample must have a non-empty reference. The checked-in synthetic silence
  fixture is the deliberate exception: its empty reference defines a hallucination check rather
  than a speech annotation.

The checked-in Gettysburg Address reference and empty synthetic-silence reference were reviewed
against this protocol as public smoke data. They validate the harness only and do not substitute
for consented multilingual meeting references.

## Rationale and external conventions

The procedure follows established meeting and ASR evaluation practice: AMI used written
transcription guidance, multiple passes, explicit handling of overlap, interruptions, restarts,
and backchannels; NIST ASR evaluations score system output against human references under a
declared normalization/transcription convention.

- <https://groups.inf.ed.ac.uk/ami/corpus/transcription.shtml>
- <https://groups.inf.ed.ac.uk/ami/corpus/Guidelines/speech-transcription-manual.v1.1.pdf>
- <https://www.nist.gov/system/files/documents/2021/08/31/OpenASR21_EvalPlan_v1_3_1.pdf>
