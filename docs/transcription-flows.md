# Transcription flows

Every path audio takes through the app to become transcript text, speaker
labels, and a summary. **Keep this file in sync**: any change to these
pipelines (new stage, new event, moved gate, renamed command) must update the
matching diagram in the same PR.

There are three transcription entry points (live recording, retranscribe,
import) that share one engine, plus two post-processing flows (diarization,
summary) that consume the transcript.

## Live recording

Source: `audio/pipeline.rs`, `audio/transcription/worker.rs`,
`whisper_engine/engine.rs`, `audio/recording_commands/mod.rs`,
`hooks/use-recording-stop.svelte.ts`.

```mermaid
flowchart TD
    MIC["Microphone capture 48kHz"] --> SPLIT["Dual-path pipeline"]
    SYS["System audio tap 48kHz"] --> SPLIT
    SPLIT -->|"recording path: ducking, mixing"| FILE["audio.mp4 in meeting folder"]
    SPLIT -->|"transcription path"| VAD["VAD: speech-only segments<br/>min 250ms, max 15s"]
    VAD --> QUEUE["Chunk queue"] --> WORKER["Serial transcription worker<br/>(NUM_WORKERS = 1)"]
    WORKER --> PICK{"configured provider"}
    PICK -->|"localWhisper (default)"| ENGINE["Whisper engine decode<br/>(see 'Inside one decode')"]
    PICK -->|"parakeet (Fastest profile)"| PARA["Parakeet v3 single pass:<br/>no prompts, no confidence,<br/>no language machinery"]
    PARA --> GATES
    ENGINE --> GATES{"Gates: confidence floor 0.3,<br/>hallucination filter,<br/>mic/system crosstalk"}
    GATES -->|"dropped"| X1["discarded"]
    GATES -->|"admitted"| EMIT["transcript-update event<br/>(upserted by sequence_id)"]
    EMIT --> SINK["RecordingManager sink → transcripts.json"]
    EMIT --> UI["Live transcript store / drop-up"]
    WORKER -.->|"language lock settles"| REPAIR["Post-lock repair: re-decode<br/>Deciding-phase segments forced to the<br/>stable language, re-emit same sequence_id"]
    REPAIR --> EMIT
```

On stop (`use-recording-stop.svelte.ts`): wait for the queue to drain → flush
buffer → save meeting to SQLite. Then, without holding the stop UI: an
optional **quality pass** (a retranscription of the saved file;
`post_meeting_quality_pass` setting) chained into **auto-diarization** (only
if calendar attendees exist and models are downloaded), plus an independent
title pass. The summary auto-generates when the meeting first opens.

The quality pass ALWAYS runs Whisper, regardless of the live provider: with
Parakeet selected for live captions ("Fastest" profile in settings), it is
exactly the pass that upgrades the transcript to whisper quality afterwards.

## Retranscribe (manual) and import

Source: `audio/retranscription.rs`, `audio/import.rs`,
`MeetingDetails/RetranscribeDialog.svelte`, `MeetingDetailsView.svelte`.
Both offline paths share the engine semantics of the live path (language lock,
prompt hygiene, post-lock repair of early segments).

```mermaid
flowchart TD
    MENU["Meeting menu → Retranscribe audio"] --> DIALOG["RetranscribeDialog:<br/>language, model,<br/>'Regenerate the AI summary when done'"]
    DIALOG --> CMD["start_retranscription_command"]
    IMPORT["Import audio file"] --> CMD2["import command"]
    CMD --> DECODE["Decode + resample to 16kHz mono"]
    CMD2 --> DECODE
    DECODE --> VAD2["VAD (2s redemption),<br/>split oversized segments"]
    VAD2 --> LOOP["Per-segment engine decode<br/>+ segment filter"]
    LOOP --> REPAIR2["Post-lock repair of<br/>Deciding-phase segments"]
    REPAIR2 --> SNAP["Snapshot current transcript<br/>as a revision (undo support)"]
    SNAP --> DB[("DELETE + INSERT transcripts")]
    DB --> EVT["retranscription-complete event"]
    EVT --> PILL["Background tasks pill"]
    EVT --> DROPUP["Open transcript drop-up refreshes"]
    EVT --> CHAIN{"Regenerate summary<br/>requested at start?"}
    CHAIN -->|"yes"| SUMMARY["Summary flow (below)"]
    CHAIN -->|"no"| DONE["done"]
```

Progress/terminal events: `retranscription-progress` / `-complete` / `-error`,
all carrying `meeting_id`. The summary chain lives in the meeting-details
PAGE, not the view: completing a retranscription refetches the paginated
transcripts, which remounts the keyed `MeetingDetailsView`, so the page sets
`shouldAutoGenerate` and the remounted view generates through the same
mechanism a fresh recording uses. The chain survives the dialog being
backgrounded and the remount, but not leaving the meeting page (a toast says
so); it only fires for runs started from the dialog, never for the
post-recording quality pass.

## Inside one decode (whisper engine)

Source: `whisper_engine/engine.rs`, `lang_lock.rs`, `decode_policy.rs`,
`audio/transcription/segment_filter.rs`.

Everything below is whisper-only. A Parakeet decode is one TDT transducer
pass (`parakeet_engine/engine.rs`): no prompts, no language lock, no echo
breaker, no confidence — only the worker-level gates (hallucination filter,
crosstalk) apply to its output.

```mermaid
flowchart TD
    IN["16kHz segment + language preference"] --> PROMPT["initial_prompt = custom vocabulary<br/>+ meeting terms + per-stream prior tail"]
    PROMPT --> MODE{"language"}
    MODE -->|"explicit code"| ONE["single forced pass"]
    MODE -->|"auto-translate"| TR["detect + translate pass"]
    MODE -->|"auto"| P1["pass 1: auto-detect"]
    P1 --> LOCK{"lang_lock"}
    LOCK -->|"Deciding: probability-gated votes;<br/>2 confident votes or plurality of 4"| USE["use detected<br/>(marked for post-lock repair)"]
    LOCK -->|"Locked, agrees"| USE2["use detected"]
    LOCK -->|"Locked, disagrees"| FORCE["pass 2 forced to stable,<br/>prior prompt dropped"]
    LOCK -->|"challenger: 3 confident segments<br/>spanning at least 10s"| SWITCH["stable switches"]
    ONE --> ECHO
    TR --> ECHO
    USE --> ECHO
    USE2 --> ECHO
    FORCE --> ECHO
    ECHO{"decode parrots the<br/>prior prompt?"} -->|"yes"| REDO["re-decode without prior"]
    ECHO -->|"no"| OUT
    REDO --> OUT["text + confidence"]
    OUT --> STORE{"store as next prior prompt?<br/>only if language verified AND<br/>passes hallucination filter"}
```

Empty decodes climb a temperature ladder (0.0 → 0.8). The hallucination filter
drops exact low-confidence phrases ("Obrigado.", "thank you for watching"),
degenerate repetition loops, and bare-URL segments at any confidence.

## Speaker diarization

Source: `diarization/commands.rs`, `hooks/use-diarization.svelte.ts`,
`hooks/use-recording-stop.svelte.ts` (auto-run).

```mermaid
flowchart TD
    T1["Meeting menu → Identify speakers"] --> READY{"models on disk?"}
    T2["Auto-run after stop: calendar<br/>attendees + models present"] --> RUN
    READY -->|"no"| DL["Download ~35MB models<br/>(persistent progress toast)"] --> RUN
    READY -->|"yes"| NAMES{"assigned names exist?"}
    NAMES -->|"yes"| CONFIRM["Confirm dialog:<br/>re-identify clears names"] --> RUN
    NAMES -->|"no"| RUN["diarize_meeting"]
    RUN --> D1["decode full recording → 16kHz mono"]
    D1 --> D2["sidecar: segmentation + embedding<br/>→ speaker turns"]
    D2 --> D3["reconcile turns onto system segments;<br/>mic side is always the local user"]
    D3 --> D4[("persist speaker_id + attendee names")]
    D4 --> EVT2["diarization-complete"]
    EVT2 --> R1["page refetch + drop-up refresh"]
```

Events: `diarization-progress` (stages: decode / cluster / label, no
percentage), `diarization-complete`, `diarization-error` — all drive the
background tasks pill, since the auto-run has no other UI.

## Summary generation

Source: `summary/service.rs`, `summary/processor.rs`, `summary/cleanup.rs`.

```mermaid
flowchart TD
    G1["Enhance notes menu"] --> GEN
    G2["Auto-generate on first open"] --> GEN
    G3["Template switch"] --> GEN
    G4["Post-retranscribe chain"] --> GEN
    GEN["handleGenerateSummary"] --> CLEAN{"transcript_cleanup_enabled?"}
    CLEAN -->|"yes"| C1["LLM disfluency cleanup pass<br/>(UI: 'Cleaning transcript...')"] --> BASE
    CLEAN -->|"no"| BASE["English base summary pass<br/>(chunked for long transcripts)"]
    BASE --> LANG{"output language"}
    LANG -->|"translate"| T["translation pass"]
    LANG -->|"non-English transcript,<br/>English target"| N["English normalization pass"]
    LANG -->|"English/English"| P["as-is"]
    T --> STRIP
    N --> STRIP
    P --> STRIP["strip think-blocks +<br/>wrapper code fences"]
    STRIP --> TITLE["extract/strip title heading"]
    TITLE --> DB2[("summary_processes.result")]
```

Every LLM pass output goes through `clean_llm_markdown_output`, which strips
`<think>` blocks and wrapper code fences (including unbalanced ones that small
models emit). User notes are folded into the generation prompt as
`<user_context>`.
