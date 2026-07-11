---
title: "Ask anything" chat bar (streaming meeting Q&A)
type: feat
status: completed
date: 2026-07-10
---

# "Ask anything" chat bar

> **Progress (2026-07-10):** ALL PHASES SHIPPED on `main`. Phase 0+1 (commits
> `9c7689a`, `5fe19ac`, `9899149`, `4dca5a2`, two-agent reviewed, UI
> browser-verified). Phase 2a: llama-helper streams token lines (stop-token
> holdback emitter), sidecar `send_request_streaming` (RequestGuard + held
> stdout lock + per-line timeout + kill-on-stall), fake-sidecar integration
> tests. Phase 2b: `generate_summary_streaming` SSE for OpenAI-compat + Claude
> (extracted shared `send_with_retry`), fake-SSE-server e2e test. All providers
> now stream through the same Channel contract; frontend unchanged (done.full
> authoritative). 422 muesly + 6 llama-helper tests green. Also fixed a
> pre-existing lockfile drift (llama-cpp-sys-2 pinned to 0.1.146).

A persistent bottom-pill chat input to ask questions about the current meeting — during
recording and after — with slash-command "recipes" (canned prompts). Tokens stream from
Rust (where all LLM access lives) to the frontend over a Tauri `ipc::Channel`. The app is
`adapter-static` (no JS server), so the transport is a `#[tauri::command]` + `Channel<T>`,
not an HTTP endpoint.

## Overview

Two meeting surfaces already exist and share one shell:

- **Live** meeting: `src/routes/(app)/note/+page.svelte` (editor + `TranscriptPanel`).
- **Saved** meeting: `src/routes/(app)/meeting-details/+page.svelte` → `MeetingDetailsView.svelte`.
- **Shared shell**: `src/routes/(app)/+layout.svelte`, which already renders `RecordingBar`
  as a `fixed bottom-6 z-40` centered pill offset by `sidebar.effectiveWidth`.

The chat bar mounts in the shared layout next to `RecordingBar`, so a single instance serves
both surfaces. Meeting context (transcript + summary + title) is loaded in Rust by
`meeting_id` and fed to the LLM as prompt context, gated by the existing privacy egress
classifier before any remote provider sees it.

## Key decision: hand-roll a Svelte 5 runes chat store, skip `createChat`

Evaluated `@tanstack/ai-svelte@0.14.3`'s `createChat` (todo asked us to). Its `connection`
(`ConnectionAdapter`) does support a non-HTTP `stream()`/`rpcStream()` transport, so a Tauri
Channel *can* be bridged. But the transport contract speaks the **AG-UI event protocol**
(`RUN_STARTED` / `TEXT_MESSAGE_CHUNK` / `RUN_FINISHED` / `RUN_ERROR` with `threadId`/`runId`/
`messageId` bookkeeping), while our Rust side emits plain `token`/`done`/`error`. The adapter
would exist only to translate one enum we control into another enum we control — pure overhead —
and pulls `@tanstack/ai-client` + `@tanstack/ai` + `@tanstack/ai-event-client` + `@ag-ui/core`
+ zod (all 0.x, fast-churning) into a local-only desktop app.

**Decision:** hand-roll a ~60-line runes store. Zero deps, exact message shape, exact
cancellation semantics. **Migration path preserved:** if we later want streaming tool-calls,
multimodal, or reasoning segments, the `stream((messages, _data, signal) => AsyncIterable)`
adapter bridging `Channel.onmessage` into an async queue is the documented upgrade, so this
is not a one-way door. (Reference sketch kept in this plan's Sources.)

## Architecture

### Rust (`app/src-tauri/`)

**New module `summary/chat.rs`** (or `chat/` folder) with two commands, registered in
`collect_commands!` (`lib.rs:766`) next to the summary cluster (`lib.rs:903`):

```rust
#[derive(Clone, Serialize, specta::Type)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
enum ChatStreamEvent {
    Started { gen_id: String },
    Token   { text: String },
    Done    { gen_id: String, full: String },
    Error   { message: String },
}

#[tauri::command] #[specta::specta]
async fn chat_ask<R: Runtime>(
    app: AppHandle<R>, state: State<'_, AppState>,
    meeting_id: String, question: String, history: Vec<ChatTurn>,
    gen_id: String,
    on_event: tauri::ipc::Channel<ChatStreamEvent>,
) -> Result<(), String>;

#[tauri::command] #[specta::specta]
fn chat_cancel(state: State<'_, AppState>, gen_id: String);
```

Flow inside `chat_ask`:
1. `resolve_llm_call_settings(pool, model_provider)` (`summary/service.rs:46`) — resolve
   provider + api key (keychain) + endpoints. **This is currently private — expose a thin
   public wrapper** (e.g. `pub async fn llm_settings_for_chat(...)`), don't duplicate it.
2. Load context: `MeetingsRepository::get_meeting(pool, &meeting_id)` (transcript lines,
   `Me:`/`Them:` labels) + `SummaryProcessesRepository::get_summary_data(pool, &meeting_id)`
   (generated summary) + title.
3. **Privacy — no new gate; provider choice is consent (consistent with summaries).**
   Security review corrected the original assumption: there is NO policy that blocks a
   transcript from reaching a remote provider. The summary pipeline sends the transcript to
   whatever provider the user configured (`summary/service.rs:503`) with no gate; `data_egress`
   (`llm_client.rs:102`) only governs how much extra *calendar* PII (attendee names, notes,
   conference URLs) rides along, via `get_calendar_send_attendee_names_to_cloud` /
   `get_calendar_send_notes_to_cloud` (`setting.rs:155-198`, default false). Chat's Phase 1
   context is **transcript + summary + title only** (no calendar events), so the classifier is
   N/A — do not invent a chat-only block (it would refuse what summary already sends). If chat
   ever surfaces calendar context, reuse `calendar::service::meeting_context_block`
   (`calendar/service.rs:252-271`) verbatim so the two flags stay the single source of truth,
   threading the *resolved* endpoints into `data_egress` (not `None, None`).
4. Build system + user prompt. **Mirror the summarizer's prompt-injection defense**
   (`processor.rs:601,618-631`): wrap transcript/summary/history in `<transcript>`-style tags
   and instruct the model to treat them as untrusted reference data, not instructions. Never
   `log` prompt content; keep `classify_http_error` discipline (no raw HTTP bodies in errors).
5. Register a `CancellationToken` in a **chat-owned registry** (new static in `chat.rs`, keyed
   by `gen_id`) — NOT the summary `CANCELLATION_REGISTRY` (private to `service.rs`; sharing
   risks cancelling a meeting's summary). Own registry also structurally guarantees gen_id
   isolation. `chat_cancel` trips it; dropping the JS Channel does not cancel the backend.
6. Stream tokens via `on_event.send(ChatStreamEvent::Token { .. })`, terminal `Done`/`Error`.

**Phase 1 sends the whole answer as one `Token{full}` + `Done`** (via existing
`generate_summary`) — same command/Channel shape, so real streaming is a backend-only swap.

**Channel binding — confirmed, no fallback needed.** Feasibility review verified tauri-specta
rc.25 emits `Channel<ChatStreamEvent>` bindings (`js_ts.rs:972-999`) and tauri 2.11.4 (lockfile)
provides the specta impl (`ipc/channel.rs:54-59`, feature force-enabled via tauri-specta). Phase 0
is a 10-minute confirmation, not a branch point; the `app.emit`+`listen` fallback is dropped as
dead weight. Requirements: `ChatStreamEvent: specta::Type + Serialize + Clone`,
`ChatTurn: specta::Type + Deserialize`.

**Streaming implementation — additive, do NOT modify the working summary paths:**
- **Phase 2a (local, BuiltInAI — privacy-default, ship first):** streaming sibling to the
  sidecar. New request variant in `llama-helper/src/main.rs` that `println!`s one JSON line per
  token in the generate loop (`main.rs:452-512`) + a terminal marker; new
  `SidecarManager::send_request_streaming` in `sidecar.rs` looping `read_line`. Existing
  `read_response`/`Response::Response{text}` path untouched. **Three mandatory hazards
  (feasibility review) — desync the shared summary process if wrong:**
  1. **Cancel must kill the sidecar**, not just stop reading — mirror `client.rs:206-219`
     (`manager.shutdown()` on `token.cancelled()`); otherwise stale token lines corrupt the
     next request. Accept the model-reload cost.
  2. **Hold a `RequestGuard`** for the whole stream (`sidecar.rs:358`) so the 30s health ping
     (`sidecar.rs:576-595`) skips, AND hold the `stdout_reader` lock for the entire stream (not
     per-line like `read_response`) so a stray `pong` can't interleave as a token.
  3. **Buffer a stop-token-length tail** before emitting each token (streaming can't strip
     stop tokens post-hoc like `main.rs:489-501`). Use an inter-token (per-`read_line`) timeout
     that resets each token, not one wall-clock budget. Keep the two protocol enums
     (`client.rs:23-48` ↔ `main.rs:22-51`) in sync. **Re-verify summaries still work after.**
- **Phase 2b (cloud SSE) — DEFERRED** (scope review). More work than one callback: two parsers
  (OpenAI-compatible `data: {choices:[{delta:{content}}]}`+`[DONE]` vs Claude
  `content_block_delta`) + a buffer to reassemble JSON split across `bytes_stream` chunk
  boundaries. Own follow-up phase, gated on 2a landing and summaries re-verified.

### Frontend (`app/src-svelte/`)

- **`src/lib/stores/chat.svelte.ts`** — `ChatStore` singleton (modeled on `notes.svelte.ts`):
  `messages = $state<ChatMessage[]>([])`, `draft = $state('')`, `isStreaming = $state(false)`,
  `genId`. `send(question)` pushes a user msg + an empty assistant msg, opens a
  `Channel<ChatStreamEvent>`, appends `token.text` to the in-flight assistant message on
  `onmessage`, flips `isStreaming` off on `done`/`error`. `stop()` calls `commands.chatCancel`.
  Reads meeting context from `transcripts.currentMeetingId` (live) or the `?id` param /
  `sidebar.currentMeeting` (saved).
- **`src/lib/services/chat.ts`** — thin wrapper creating the Channel and calling
  `commands.chatAsk(...)` (mirrors `services/transcript.ts`), so the Channel-vs-emit transport
  detail is hidden from the store.
- **`src/lib/components/ChatBar/ChatBar.svelte`** — the pill. Clone `RecordingBar.svelte:96-98`
  styling (`rounded-full border border-border bg-card shadow-[...]`). Uses:
  - `Textarea` (`ui/textarea`, native `field-sizing-content` autosize — no JS autosize),
    Enter to send / Shift+Enter newline.
  - `Command` + `Popover` (`ui/command`, `ui/popover`) for the **recipes** menu, opened by
    typing `/` or a button. Recipes are canned prompts (see below).
  - `ScrollArea` (`ui/scroll-area`) for the message list, shown in a popover/panel above the
    pill when there are messages.
  - `Button` for send/stop.
- **Mount** in `(app)/+layout.svelte` in its **own** `{#if}` block (NOT inside RecordingBar's
  `{#if recordingState.isRecording && windowFocused}` at `:461` — the chat must show during AND
  after recording). Gate on `page.url.pathname ∈ {/note, /meeting-details}` only. Reuse the
  `fixed bottom-* z-40 -translate-x-1/2` + `left: calc(50% + ${sidebar.effectiveWidth/2}px)`
  wrapper. **Collision:** when recording+focused on `/note`, both pills sit at `bottom-6` —
  stack the chat pill at `bottom-24`; keep clear of the bottom-right `Toaster`.

**WKWebView gotcha:** show/hide the recipes menu, message panel, and pill via
`{#if}` / `visibility` / `display`, never `opacity`+`transition` reveal (sticks visible in
WKWebView; Chromium tests won't catch it). See `[[webkit-opacity-hover-reveal-gotcha]]`.

### Recipes (slash-command prompts)

A small typed list `src/lib/components/ChatBar/recipes.ts`: `{ id, label, icon, prompt }`.
Starter set: **Summarize**, **Action items**, **Key decisions**, **Follow-up email draft**,
**What did I miss?**. Selecting one fills the draft (editable) or sends immediately. Keep the
list data-driven so more can be added without touching the component.

## Implementation phases (checklist)

**Phase 0 — Transport confirmation**
- [x] Add `ChatStreamEvent` (+ `ChatTurn`) enum + stub `chat_ask` emitting `Started`→`Token`→`Done`.
- [x] Run `cargo test exports_typescript_bindings`; confirm `Channel<ChatStreamEvent>` binds (it will).

**Phase 1 — End-to-end vertical slice (real answers, whole-answer-as-one-token)**
- [x] Expose a `pub(crate)` chat-settings resolver wrapping `resolve_llm_call_settings`.
- [x] `chat_ask`: load context (`get_meeting` + `get_summary_data`), build injection-safe prompt,
      call existing `generate_summary`, emit `Token{full}` + `Done`. `chat_cancel` + a chat-owned
      cancellation registry.
- [x] Rust tests: injection-safe prompt building, cancel path, error surfaces cleanly.
- [x] `chat.svelte.ts` store + `services/chat.ts` + regenerate bindings.
- [x] `ChatBar.svelte` + own `{#if}` mount in layout (pathname gate, sidebar offset, `bottom-24`
      collision handling), recipes list + Command/Popover menu.
- [x] `pnpm check` / `vp lint` / `vp fmt` / `cargo test -p muesly` all green. Commit.

**Phase 2a — Local sidecar token streaming (privacy-default; ship next)**
- [x] llama-helper streaming request variant (one JSON line per token + marker).
- [x] `SidecarManager::send_request_streaming` with the 3 hazards above (kill-on-cancel,
      RequestGuard+held lock, stop-token tail buffer, inter-token timeout).
- [x] `chat_ask` uses the streaming path for BuiltInAI; UI renders tokens incrementally.
- [x] **Re-verify the summary pipeline still works** (existing paths untouched).

**Phase 2b — Cloud SSE streaming — DEFERRED** (own follow-up; two parsers + chunk reassembly).

## Acceptance criteria

- [x] A bottom-pill chat input appears on `/note` and `/meeting-details`, not elsewhere.
- [x] Asking a question streams an assistant answer grounded in this meeting's transcript+summary.
- [x] Works during an active recording (coexists with `RecordingBar`, no overlap) and after.
- [x] Slash `/` opens the recipes menu; picking a recipe drives the prompt.
- [x] A stop control cancels an in-flight generation (backend actually stops).
- [x] The prompt treats transcript/summary as untrusted data (injection-resistant, mirrors the
      summarizer); prompt content is never logged and errors never leak raw HTTP bodies.
- [x] `pnpm check`, `vp lint`, `vp fmt`, `cargo test -p muesly` all pass.

## System-wide impact

- **Interaction graph:** `chat_ask` → resolve settings (keychain) → DB reads (`get_meeting`,
  `get_summary_data`) → LLM (sidecar process or reqwest) → Channel sends. Uses a **chat-owned**
  cancellation registry keyed by `gen_id`, separate from the summary registry.
- **State lifecycle:** no persistence in Phase 1 (chat is ephemeral per session). Persisted
  history would be a new table + migration — out of scope now.
- **Error propagation:** command boundary returns `Result<_, String>`; streaming errors go
  through the `Error` event (never raw HTTP bodies — respect `classify_http_error`).

## Risks & mitigations

- **`Channel<T>` specta binding** → verify in Phase 0; `app.emit`+`listen` fallback ready.
- **Breaking the summary/sidecar path** → streaming is additive (new request variant + new
  method); existing `read_response`/`generate_summary` untouched; verify summaries post-change.
- **Provider without streaming / errors mid-stream** → terminal `Error` event + toast; partial
  assistant text preserved.
- **UI collision** (RecordingBar, Toaster) → explicit `bottom-*` stacking while recording.
- **Concurrent asks** → per-request Channel + `gen_id` isolate streams; a new ask cancels the
  previous in-flight one in the store.

## Sources & references

- Rust LLM entry point `generate_summary` — `app/src-tauri/src/summary/llm_client.rs:211`;
  egress gate `:102`; providers `:66`. Local sidecar `summary/summary_engine/sidecar.rs`
  (spawn `:279`, `read_response` `:397`); `llama-helper/src/main.rs` generate loop `:452-512`,
  whole-response return `:639`. Settings/cancellation `summary/service.rs:25,46,231`.
  Command registration `lib.rs:766,903`; bindings test `lib.rs:224`. Context repos
  `database/repositories/meeting.rs:119,185`, `summary.rs:11`.
- Frontend mount `src/routes/(app)/+layout.svelte:462-468`; RecordingBar pill styling
  `RecordingBar.svelte:96-98`; store template `stores/notes.svelte.ts` &
  `stores/transcript.svelte.ts`; service template `services/transcript.ts:59`; UI primitives
  under `src/lib/components/ui/` (`textarea` native autosize, `command`, `popover`,
  `scroll-area`).
- Tauri Channel docs: https://v2.tauri.app/develop/calling-frontend/ ; cancellation is DIY
  (tauri#8351). `@tanstack/ai-svelte` 0.14.3 `stream()`/`rpcStream()` custom adapter
  (migration path if we outgrow the hand-rolled store).
- WKWebView reveal gotcha: memory `[[webkit-opacity-hover-reveal-gotcha]]`.
