---
title: "Local Calendar Meeting Context (macOS EventKit)"
type: feat
status: active
date: 2026-06-28
---

# ✨ Local Calendar Meeting Context (macOS EventKit)

## TL;DR — Answering the Original Question

> "I want to be able to locally sign in with Google so muesly gets access to Google Calendar — is that possible? Or would a local-focused app work best connecting to the local calendar?"

**Connect to the local calendar.** It is both the more private and the lower-effort path, and it *still gives you Google Calendar* — because macOS already syncs the user's Google (and iCloud/Exchange) accounts into the local Calendar store. muesly reads that local store read-only via **EventKit**; it never talks to Google, never holds an OAuth token, never sees an account. One integration covers every calendar provider the OS knows about, and the "everything stays on your device, no account" promise stays literally true.

Direct Google OAuth sign-in *is* possible (loopback + PKCE, read-only scope, token in the keychain), but it is mostly net-new infrastructure, drags in Google verification paperwork for a distributed app, requires CSP changes, and reintroduces the exact cloud + Google-account dependency muesly's marketing positions *against*. We therefore **defer Google OAuth as an optional Windows/Linux fallback only**, behind the same kind of explicit opt-in muesly already uses for cloud LLM providers.

The closest comparable confirms the call: **Hyprnote** (open-source, Tauri, local-first) reads the local calendar via EventKit; **Granola** uses cloud OAuth, and Granola is who muesly differentiates against on privacy.

---

## Deepening Review — Corrections Applied (2026-06-28)

Five expert agents (swift/EventKit, Rust principal, security/privacy, simplicity, external research) hardened this plan. The corrections below **override** any earlier wording; the body sections were updated to match.

**Critical (would crash, silently fail, or be impossible as first drafted):**

1. **Use `objc2-event-kit`, NOT `cidre`.** Verified directly against the pinned source: `cidre` rev `a9587fa` has **no EventKit module/feature** (its feature list is `av, am, at, ax, ca, ci, cl, cm, ct, cf, cg, ns, …`, no `ek`). And `objc2-event-kit` is the **no-bump path**, because the whole objc2 stack (`objc2 0.6.4`, `block2 0.6.2`, `objc2-foundation 0.3.2`, `dispatch2 0.3.1`) is already resolved in `Cargo.lock` transitively (via tauri/tray-icon/muda). No Phase-1 cidre spike needed. `cidre` stays for `ns::Workspace` in `meeting_detect`; the two coexist. Gate `objc2-event-kit` under `[target.'cfg(target_os="macos")'.dependencies]`.
2. **The "all EventKit on the main thread" rule was wrong.** Correct threading: the auth *request* is fired from the main thread, but its **completion handler runs on an arbitrary background queue** (do no store/AppKit work inside it). **Never block the main thread waiting on the auth completion** (it deadlocks the run loop so the prompt never appears); deliver the result async. `events(matching:)` is **synchronous + blocking** and must run on a **background thread** (it is not AppKit), off the hot path. Only store *creation* and the *auth request* touch main. `authorizationStatus(for:)` is a cheap static call needing no marshaling.
3. **The PII "local vs cloud" gate has no source of truth, and the obvious one is wrong.** `LLMProvider` has no local/cloud classifier; the frontend `CLOUD_PROVIDERS` set already omits OpenAI; `Ollama`/`CustomOpenAI` can egress to arbitrary remote hosts. A naive variant check would silently ship attendee emails to OpenAI. Add a Rust **egress classifier keyed on the resolved endpoint host** (loopback = `Local`, else `Remote`; default-deny) and gate on that, in Rust, at the single prompt-assembly chokepoint.
4. **The pure matcher cannot detect "I declined" as the boundaries were drawn.** "Declined" needs `EKParticipant.isCurrentUser` + `participantStatus == .declined`, resolvable only inside EventKit; if the user is the organizer they are often absent from `attendees` (not declined); nil attendees = not declined. So `matching.rs` must receive **pre-computed `my_participation: Option<ParticipantStatus>` and `i_am_organizer: bool`** on each candidate. Also **hard-exclude `EKEventStatus.canceled`** (was missing).

**High-value structural simplifications:**

5. **Do not thread a `MeetingContext` struct through the summary chain.** `process_transcript_background` already has `meeting_id` + `pool` (`service.rs:366`) and the resolved provider (`:387`). Fetch the snapshot there (~`service.rs:462`, beside the existing metadata reads), gate + render it, and pass **one `Option<&str>`** into `generate_meeting_summary`, injected as `<meeting_context>` at `processor.rs:623-627`, final pass only (not chunk prompts). Do **not** add a field to `ProcessTranscriptParams` (specta-capped at 10, already full).
6. **Per-call `EKEventStore` at record time, not in `AppState`.** `AppState` is lazily managed post-DB-init (`setup.rs:50`); caching the store there couples calendar to the DB lifecycle. A fresh store per record-time lookup (in an autorelease scope, like `watcher.rs:95`) also sidesteps snapshot-staleness entirely. The resolver returns `Option`, never `Result`, into the recording path, so it is structurally incapable of failing a recording.
7. **Do not persist attendee emails at all.** Nothing consumes them (they never enter any prompt), so storing them only adds third-party PII to a backup-exposed SQLite file (ADR 0001). Drop the email field from the snapshot; the `MeetingContext` type that crosses into prompt-building has **no email field**, so no future edit can leak one.

These are reflected in the sections below and in the revised Decisions list.

---

## Overview

Add an opt-in feature that reads the user's **local macOS calendar** (read-only, via EventKit) and uses the meeting happening at record time to:

1. **Title** the recording with the real meeting name (instead of `Meeting <timestamp>`).
2. **Attach** a snapshot of the event (time, organizer, attendees, agenda/notes, video-call link) to the recording.
3. **Enrich the summary** by injecting that context into the summarization prompt as a `<meeting_context>` block, parallel to the existing `<user_context>` block.

macOS-first. Windows/Linux compile to no-ops with the Calendar settings tab hidden. The hard problems are **matching** (picking the right event) and **privacy** (keeping attendee PII out of cloud LLM prompts) — not the EventKit plumbing, which reuses patterns already in the codebase.

## Problem Statement / Motivation

Recordings are currently titled `Meeting <timestamp>` unless the user types a name, and summaries have no knowledge of who was in the room or what the meeting was about. Calendar context is the single highest-leverage signal for better titles and summaries, and every comparable tool (Granola, Otter, Fathom, Hyprnote) uses it. The product already half-anticipates this: `NotificationSettings` scaffolds `meeting_reminders`/`meeting_reminder_minutes`, and `meeting_detect/` already watches for meeting apps in the foreground but cannot say *which* meeting it is. Calendar context fills that gap.

The tension to resolve is that muesly's entire identity is local-first privacy ("private speech-to-text… entirely on local infrastructure"). The solution must not quietly break that.

## Proposed Solution

**Read the local macOS calendar via EventKit, read-only and opt-in.**

- A new `calendar/` Rust module wraps EventKit (authorization, range queries, field extraction), marshaled to the main thread using the exact `run_on_main_thread` pattern already used in `meeting_detect/watcher.rs`.
- At recording start, before the default `Meeting <timestamp>` name is generated, query EventKit for the event "happening now," score candidates, and (for high-confidence matches) use the event title; persist a **snapshot** of the event to a new `calendar_events` table keyed by `meeting_id`.
- The summary pipeline injects a `<meeting_context>` block, with attendee PII gated by provider type (local vs cloud).
- A new "Calendar" settings tab handles the connect flow, permission state, and per-calendar selection. The recording detail view lets the user **correct, attach, or detach** the matched event.

### Alternatives Considered

| Option | Verdict | Why |
|---|---|---|
| **A. Google OAuth → Google Calendar API** | **Rejected as primary** | Net-new OAuth/loopback/PKCE/token-refresh infra (no precedent in repo — all current creds are static user-pasted keys), Google verification paperwork (~$540–$4,500/yr CASA only for restricted scopes; verification ~10-day review), CSP `connect-src` must add Google hosts, and it reintroduces the cloud/account dependency muesly positions against. Only covers Google, not iCloud/Exchange. |
| **B. Local OS calendar via EventKit** | **Chosen** | Reuses `cidre`, the `meeting_detect` main-thread pattern, the `audio/permissions.rs` permission UX, and the keychain/settings patterns. Public auth API (simpler than the private TCC SPI already used for audio). Covers Google/iCloud/Exchange in one integration. No network, no tokens, no account, no CSP change. Matches Hyprnote. |
| **C. Hybrid (EventKit primary + OAuth opt-in)** | **Deferred** | The OAuth half is reserved as a *later* Windows/Linux fallback, messaged like the existing opt-in cloud-LLM exception. Not in this MVP. |

## Technical Approach

### Architecture

Data flow (no network for the chosen path):

```
EventKit (local, on main thread)
   └─► calendar/service.rs  ──► calendar/matching.rs  (score + pick event)
          │                          │
          │                          └─► snapshot ─► calendar_events table (SQLite)
          │
          ▼ (record-time hook in audio/recording_commands)
   meetings row title  ◄── high-confidence match title
          │
          ▼ (at summarization)
   summary/processor.rs  ──►  <meeting_context> block (PII-gated)  ──► LLM
```

New Rust module mirroring the existing module layout (`audio/`, `summary/`, `meeting_detect/`):

```
app/src-tauri/src/calendar/
  mod.rs          # module hub + re-exports
  permissions.rs  # EventKit auth: 4-state enum, status check, request, open-System-Settings deep-link
  eventkit.rs     # #[cfg(target_os="macos")] cidre EventKit wrapper (range query, field extraction), main-thread marshaled
  matching.rs     # pure scoring/selection algorithm (unit-testable, no platform deps)
  service.rs      # high-level coordinator: "resolve event for instant", snapshot, persist
  commands.rs     # #[tauri::command] #[specta::specta] surface
```

`matching.rs` is deliberately **platform-free and pure** (takes a `Vec<CalendarEventCandidate>` + a timestamp, returns a scored choice) so it is fully unit-testable without EventKit.

### EventKit integration (macOS)

- **Crate: `objc2-event-kit = "0.3"`** (+ `objc2`, `objc2-foundation`, `block2`, `dispatch2`), gated under `[target.'cfg(target_os="macos")'.dependencies]`. This is the **no-bump** path (the objc2 stack is already in `Cargo.lock` at the needed versions). `cidre` does **not** expose EventKit at the pinned rev (verified), so do not try to extend it; `cidre` stays in use for `ns::Workspace` in `meeting_detect` and coexists fine. The method is `EKEventStore::requestFullAccessToEvents_completion` taking a typed `block2::Block`.
- **Deployment floor:** `requestFullAccessToEvents` and `.fullAccess`/`.writeOnly` are **macOS 14.0+ only**. Pin muesly's macOS minimum: if already 14+, use only the new API; if 13 is supported, branch to legacy `requestAccess(to: .event)` and map the legacy `.authorized` status to "granted". Scope the entity to `.event` only — never request `.reminder`.
- Authorization: `requestFullAccessToEvents_completion` (block-based). **Do not** use deprecated `requestAccess(to:)`. Status via the cheap static `EKEventStore.authorizationStatus(for: .event)`.
- Range query: `predicateForEvents(withStart:end:calendars:)` → `events(matching:)`. EventKit **expands recurring occurrences** within the range (each occurrence is a separate `EKEvent` with concrete start/end; modified occurrences carry their overrides). Store the concrete occurrence start, not the rule. Note: `eventIdentifier` is **shared across all occurrences** of a series, so it does not uniquely identify the matched instance; store the occurrence start alongside it for any future refresh. The predicate silently clamps ranges to ~4 years (irrelevant here, but do not pre-fetch huge ranges later).
- Fields read per event: `title`, `startDate`, `endDate`, `isAllDay`, `status` (`EKEventStatus`), `organizer` (+ `isCurrentUser`), `attendees` (`name`, `participantStatus`, `isCurrentUser`; email via the `mailto:` URL on the participant — but see Privacy: emails are **not persisted**), `location`, `url`, `notes`, owning `EKCalendar` (`title`, `type`, `allowsContentModifications`).
- **Conference URL is unreliable:** `EKEvent.url` is a generic field, often nil; Google/Zoom links frequently live in `notes`/`location`. Resolution order: `url` if it is a known conferencing host, else regex-scan `location` then `notes`. Tolerate nil; never panic on a non-`mailto:`/garbage URL.
- **Threading (corrected — the blanket "all EventKit on main" rule was wrong):**
  - Store *creation* and the *auth request* happen on the main thread (`app.run_on_main_thread`), because the request drives a UI prompt.
  - The auth **completion handler fires on a background queue** — bridge it to a channel; do **no** store/AppKit work inside it. **Never block the main thread on the completion** (it starves the run loop and the prompt never appears); deliver the result asynchronously.
  - `events(matching:)` is **synchronous and blocking** (disk/IPC + recurrence expansion) and is **not** AppKit — run it on a **background thread**, off the recording hot path. Marshaling a blocking fetch onto main is actively harmful.
  - The record-time lookup is called from an `async` Tauri command (a tokio worker, never main), so a `recv_timeout(Duration::from_secs(2))` block mirroring `meeting_detect/watcher.rs:101` is safe; on timeout return `None`. See `docs/solutions/runtime-errors/appkit-off-main-thread-crash-meeting-detection-20260620.md`.
  - Wrap the EventKit work in an autorelease scope (`objc2::rc::autoreleasepool`, analogous to `watcher.rs:95`) so temporary Objective-C objects free deterministically.

### Permission model — **fail closed** (differs from audio)

Mirror the *shape* of `audio/permissions.rs` (status enum, status command, deep-link to System Settings, frontend listener), but with two deliberate differences:

1. **Fail closed, not open.** Audio fails *open* on `Unknown` because the system-audio tap has no public status API and silently records zeros. EventKit has a *public* status API, so there is no "Unknown": if status is not `fullAccess`, render no context and never fabricate a title. Do not poll-and-guess.
2. **`restricted` is terminal; `writeOnly` is effectively unreachable but handle defensively.** `restricted` (MDM/parental controls) cannot be granted by the user, so its copy must say so and must **not** offer a "Open System Settings" button. `writeOnly` ("Add Only") **cannot result from a full-access request** (the prompt only offers Allow Full Access / Don't Allow); a user can only reach it by manually downgrading in System Settings afterward. So do not give it bespoke "re-request" UX: treat `writeOnly` identically to `Denied` ("insufficient access, grant full access in System Settings").

Enum: `Granted` (fullAccess) / `Denied` / `Restricted` / `WriteOnly` / `NotDetermined`. Map `WriteOnly` → same handling as `Denied`.

Deep-link to the Calendar privacy pane reuses the audio pattern: `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"`.

### Info.plist & entitlements

- Add to `app/src-tauri/Info.plist`: `NSCalendarsFullAccessUsageDescription` (macOS 14+ key) **and** the legacy `NSCalendarsUsageDescription` (ship both). Missing the string crashes on the access request.
- Entitlements: the app ships **unsandboxed Developer ID** (`entitlements.plist` has only device entitlements; `hardenedRuntime: true`). For Developer-ID distribution, EventKit is gated by the TCC prompt driven by the Info.plist string — **no sandbox entitlement required**. Add `com.apple.security.personal-information.calendars` only if/when a sandboxed Mac App Store build is pursued (note it, don't add it now).
- **Dev-mode caveat:** `pnpm tauri:dev` binaries attribute TCC consent to the launching terminal (same class of issue as the documented system-audio gotcha). **Validate the permission flow against a bundled build**, not `tauri dev`.

### Data model

New table `calendar_events`, 1:1 with a recording, keyed by `meeting_id` (mirrors `meeting_notes` / `transcript_chunks` / `summary_processes`). **Snapshot semantics:** copy fields at record time; never re-derive from the live calendar. **Emails are never persisted** (nothing consumes them; storing third-party PII in a backup-exposed SQLite file is pure downside, per ADR 0001).

```mermaid
erDiagram
    meetings ||--o| calendar_events : "snapshot (0..1)"
    meetings ||--o| meeting_notes : has
    meetings ||--o{ transcripts : has

    meetings {
        text id PK
        text title
        text created_at
    }
    calendar_events {
        text meeting_id PK_FK
        text event_identifier "EventKit series id (NOT unique per occurrence)"
        text occurrence_start "RFC3339, disambiguates the recurring instance"
        text title
        text start_time "RFC3339"
        text end_time "RFC3339"
        text organizer_name "name only, no email"
        text attendees_json "JSON: [{name, status}] — names only, NO emails"
        text location
        text conference_url
        text notes "scrubbed + length-capped"
        text calendar_name
        text source "eventkit | google(future)"
        text match_confidence "high | low | manual"
        text created_at
    }
```

Migration: `app/src-tauri/migrations/20260628HHMMSS_add_calendar_events.sql` (timestamp after `20260619020000`), `CREATE TABLE IF NOT EXISTS … REFERENCES meetings(id) ON DELETE CASCADE`. Add a matching `#[derive(FromRow, Serialize, Deserialize, specta::Type)]` `CalendarEvent` model in `database/models.rs`. Add a `CalendarEventsRepository` in `database/repositories/calendar.rs` mirroring `notes.rs` (upsert/get/delete + a coexistence test).

**Cascade delete:** add `DELETE FROM calendar_events WHERE meeting_id = ?` to the hard-delete transaction in `database/repositories/meeting.rs:329-348`, alongside the existing `meeting_notes` deletion (verify whether siblings rely on FK cascade vs manual delete and match that). An orphaned row retaining attendee data after the user deletes a recording is a data-retention bug. Note: hard delete only runs on permanent trash removal, so soft-deleted (trashed) recordings retain their snapshot until trash is emptied.

**Independent purge:** add a `calendar_purge_all_snapshots` command and offer it when the master toggle is switched off ("also delete all stored calendar data"). A user revoking the feature reasonably expects the third-party PII it gathered to be removable without deleting their recordings.

### Settings persistence

Add non-secret columns to the single-row `settings` table (precedent: `auto_detect_meetings`, migration `20260619010000`), with get/set in `database/repositories/setting.rs`:

- `calendar_context_enabled` (bool, default `false`): master opt-in.
- `calendar_excluded_ids` (JSON TEXT): per-calendar opt-out. Defaults exclude calendars where `EKCalendar.type` is `.subscription` or `.birthday`, or `allowsContentModifications == false` (read-only: holidays, subscribed, delegated-read-only). Note: there is **no `isSubscribed` property and no `.holiday` type**; detect via `type` + `allowsContentModifications`. Everything else defaults on.
- `calendar_send_attendee_names_to_cloud` (bool, default `false`): see Privacy Model.
- `calendar_send_notes_to_cloud` (bool, default `false`): notes/agenda are the highest-variance-sensitivity field; gate them separately from names.

(No keychain needed for the EventKit path: no secrets. The keychain/`keyring` v3 pattern in `keychain/mod.rs` is reserved for the deferred OAuth fallback. **Do not bump `keyring` 3→4** (breaking migration); reuse the existing abstraction.)

### Record-time matching hook

In `audio/recording_commands/mod.rs`, immediately **before** the default `effective_meeting_name` is generated (`mod.rs:335-340` for the default path, `mod.rs:530-534` for the device path), call `calendar::service::resolve_event_for_instant(app, now) -> Option<EventSnapshot>`:

- **Signature returns `Option`, never `Result`** (internally `anyhow::Result`, swallowed to `None` with `log::warn!`). It is structurally incapable of failing a recording.
- **Resolve into a local `Option` *before* taking the `RecordingManager` lock**, so a 2s EventKit stall can never extend a lock the audio pipeline contends on.
- If `calendar_context_enabled` is false, or `authorizationStatus(for: .event) != .fullAccess`, or no match → `None`, keep existing fallback.
- **Title precedence (never override an explicit user name):** explicit `meeting_name` arg > high-confidence matched title > `Meeting <timestamp>`.
- Persist the snapshot to `calendar_events` (the DB `meetings` row is written by the frontend after stop, so store the snapshot keyed by the same `meeting-{uuid}` so it joins; persist via the repository in the stop/save path or stash on `RecordingSaver` like `set_device_info` at `recording_saver.rs:82-95`).
- Re-check `authorizationStatus` here each time (cheap static call, no marshaling) rather than caching "we have permission" — handles mid-session revocation.

### Matching algorithm (`matching.rs`) — the heart

`matching.rs` is **pure and platform-free**: it takes `Vec<CalendarEventCandidate>` (a POD struct) + the record instant, and returns a scored choice. `eventkit.rs` converts `EKEvent` → `CalendarEventCandidate` behind the macOS cfg; no `EKEvent` type leaks into `matching.rs`, so it is unit-testable on any platform (incl. CI Linux).

**`CalendarEventCandidate` must carry pre-computed fields** the pure matcher cannot derive itself (they need EventKit/`isCurrentUser` resolution): `start`, `end`, `is_all_day`, `event_status` (`EKEventStatus`), `my_participation: Option<ParticipantStatus>`, `i_am_organizer: bool`, `attendee_count`, `calendar_excluded: bool`.

**Fetch window vs candidate window:** fetch the predicate over a wider range (e.g. `now-2h .. now+2h`) so boundary tie-breaks have neighbors, then mark an event *eligible* only if `start - 15min <= now <= end` (handles joining early; joining late is already inside the window).

**Hard exclusions** (never auto-match): all-day events; multi-day events; `event_status == .canceled`; **declined** events; events on excluded calendars.
- **"Declined" detection:** the user declined iff there is an attendee with `isCurrentUser` whose `participantStatus == .declined`. Guard rails: if `i_am_organizer`, the user has **not** declined (organizers are often absent from `attendees`); if there are no attendees (solo block), it is **not** declined. Only `.declined` excludes (not `.pending`/`.tentative`).

**Scoring** (high → low): score on the **self** participation status (`.accepted` > `.tentative` > `.pending`), not `EKEventStatus` (which Google/Exchange rarely populate meaningfully); has attendees > solo block; start closest to `now`. Back-to-back tie-break: before the boundary prefer the ending event, after it prefer the starting one; final tie-break toward more attendees.

**Confidence:**
- **High** = single eligible candidate, self-accepted, has attendees, overlaps `now` → auto-apply title.
- **Low** = no attendees, multiple overlapping candidates, or only a tentative/solo candidate → keep timestamp title, store the snapshot, and *suggest* the event in the UI ("matched: <title>, is this right?") rather than committing it as the title.
- **No match** → timestamp fallback, no row.

### Summary enrichment & Privacy Model

**Injection seam (no struct threading).** `process_transcript_background` (`summary/service.rs:366`) already has `meeting_id`, `pool`, and the resolved `provider` (`:387`), and already does per-meeting DB/metadata reads around `service.rs:462-483`. Fetch the snapshot there via `CalendarEventsRepository::get`, build the **redacted** block string, and pass **one `Option<&str>`** into `generate_meeting_summary` (a sibling param to the existing `custom_prompt: &str`), appended as a `<meeting_context>` block right after the `<user_context>` block at `processor.rs:623-627`. **Final templated pass only** — not the chunk prompts (`processor.rs:499-502,556-559`), which would waste tokens and risk the model echoing attendee names into chunk summaries. Do **not** add a field to `ProcessTranscriptParams` (specta-capped at 10, already full); the snapshot lives in the DB, not the IPC boundary. The summary-time lookup collapses `Err`/`None` to "no block" (mirror `read_summary_language_from_metadata(...).ok().flatten()` at `service.rs:467`).

**Egress classifier (the load-bearing privacy primitive).** There is currently **no** local/cloud classifier on `LLMProvider`, and the frontend `CLOUD_PROVIDERS` set is already wrong (omits OpenAI). Add an authoritative Rust classifier `LLMProvider::data_egress(ollama_endpoint, custom_openai_endpoint) -> Egress`:
- `OpenAI | Groq | Grok | OpenRouter | Claude => Remote`; `BuiltInAI => Local`.
- `Ollama | CustomOpenAI => Local` **only if** the resolved endpoint host is loopback (`127.0.0.1`/`::1`/`localhost`), else `Remote`.
- **Default-deny:** anything not provably local is `Remote`. The gate keys on this in Rust at the single prompt-assembly chokepoint, never on UI state. Add a unit-test matrix (remote-host Ollama/CustomOpenAI classify as `Remote`).

**Watertight PII redaction.** Build a single redacted `MeetingContext` value *before* prompt assembly via `MeetingContext::for_egress(snapshot, egress, send_names, send_notes)`. The `MeetingContext` type that crosses into prompt-building has **no email field at all**, so no future edit can leak one (emails are never stored anyway). Organizer is treated **identically to an attendee** in every gate.

**Field gating:**
- **Always present (any egress):** title, start/end (local time), location (non-URL).
- **Conference URL:** kept in the local snapshot for the detail view, but **stripped from `Remote` prompts entirely** (Zoom/Meet/Teams URLs embed personal meeting IDs and `?pwd=` passcodes; the model does not need the join link). For `Local`, include it.
- **Attendee + organizer names:** `Local` includes by default; `Remote` **off by default**, one explicit opt-in (`calendar_send_attendee_names_to_cloud`).
- **Notes/agenda:** `Local` includes; `Remote` **off by default** behind its own toggle (`calendar_send_notes_to_cloud`). Regardless of egress, run a **secret-scrub pass** first (strip lines/tokens matching passcode/PIN/`?pwd=`/dial-in/long-opaque-token patterns), **then** length-cap (~1–2KB). Scrub-then-cap, so truncation never leaves a half-secret.
- **Emails:** never in any prompt, never stored.
- Dedup the user's own identity so it stays consistent with the existing `Me:`/`Them:` convention (`processor.rs:602`).

**Disclosure.** Reuse the existing inline `Alert variant="warning"` pattern (`ModelSettingsModal.svelte:594-600`) at the moment of risk: when enabling names/notes-to-cloud while a `Remote` provider is selected, naming exactly what leaves ("attendee names from your calendar will be sent to {provider}"). Update `site/src/lib/content/privacy-policy.md:45-50` to enumerate the new fields. **Logging hygiene:** the degrade/error paths must log counts and confidence only, never event titles, names, notes, or URLs (they land in log files and backups).

### Frontend

- **New "Calendar" settings tab** in `app/src-svelte/src/routes/(app)/settings/+page.svelte` (note the `(app)` route group; tabs use a `TabItem[]` array from `$lib/ui/tabs.svelte`). New `CalendarSettings.svelte` sibling of `RecordingSettings.svelte`: master toggle, permission state + "Open System Settings", per-calendar list with noise-exclusion defaults, the cloud-attendee toggle, and a "preview current/next event" confirmation.
- **Recording detail view:** show the attached event (calendar name + a "change" affordance opening a picker of nearby events that day, plus "detach"); allow attaching an event to a manual recording. Low-confidence matches render as a suggestion, not a committed title.
- **Cross-platform:** hide the Calendar tab entirely off macOS (absent tab beats a disabled one).
- Stores follow `config.svelte.ts` (invoke/listen) and `recording-state.svelte.ts` patterns.

### New Tauri commands (capabilities + bindings)

Each new `#[tauri::command] #[specta::specta]` command must be: (1) added to `collect_commands!` in `make_specta_builder()` (`lib.rs:766-984`); (2) granted an `allow-<command-name>` permission in the inline `main` capability (`tauri.conf.json:40-80`); (3) reflected in regenerated `app/src-svelte/src/lib/bindings.ts` (the `#[cfg(test)]` at `lib.rs:218-234` fails otherwise). Anticipated commands: `calendar_permission_status`, `calendar_request_access`, `calendar_list_calendars`, `calendar_set_enabled`, `calendar_set_excluded`, `calendar_preview_current_event`, `calendar_attach_event`, `calendar_detach_event`, `calendar_purge_all_snapshots`.

### Implementation Phases

#### Phase 1: EventKit foundation + permission
- Add `objc2-event-kit = "0.3"` (+ `block2`, `objc2-foundation`) under `[target.'cfg(target_os="macos")'.dependencies]`. (No cidre spike: cidre has no EventKit at the pinned rev.)
- `calendar/permissions.rs` (5-state enum, status/request commands, deep-link; `WriteOnly`→`Denied` handling) + `calendar/eventkit.rs` (store creation + auth on main; completion bridged off-main; `events(matching:)` on a background thread; autorelease scope).
- Info.plist keys; pin the macOS deployment floor (commit to 14+ or add the legacy `requestAccess` branch).
- **Verify:** from a **bundled** build (not `tauri dev`), grant permission and log today's events; test denial from a clean TCC state (`tccutil reset Calendar <bundle-id>`). Denial/restricted paths render correctly.

#### Phase 2: Data model + matching
- Migration + `CalendarEvent` model + `CalendarEventsRepository`; add to cascade delete.
- `calendar/matching.rs` pure algorithm.
- **Verify:** `cargo test` covers matching (back-to-back, all-day, declined, recurring occurrence, no-attendee, no-match) and repository upsert/get/delete + cascade.

#### Phase 3: Record-time integration
- Hook `resolve_event_for_instant` into `recording_commands` before the name fallback; title precedence; snapshot persistence; record-time auth re-check.
- **Verify:** recording during a real meeting picks up the title; manual recording falls back cleanly; explicit name wins.

#### Phase 4: Summary enrichment + privacy
- `LLMProvider::data_egress` classifier (loopback-host check; default-deny) + unit tests.
- Fetch snapshot by `meeting_id` at `service.rs:462`, render redacted block, pass one `Option<&str>` into `generate_meeting_summary`; inject `<meeting_context>` at `processor.rs:623-627` (final pass only). Notes secret-scrub then length-cap.
- **Verify:** local summary includes names + URL; remote summary excludes emails always, names/notes unless opted in, URL stripped; remote-host Ollama/CustomOpenAI classify as Remote; assert outgoing prompt for every remote provider contains zero attendee `@`-tokens.

#### Phase 5: Frontend
- Calendar settings tab + `CalendarSettings.svelte`; per-calendar selection; names-to-cloud + notes-to-cloud toggles; inline `Alert` disclosure at the moment of risk (reuse `ModelSettingsModal.svelte:594-600`); purge-on-disable.
- Detail-view attach/detach/change picker; low-confidence suggestion UI.
- Regenerate bindings; capabilities entries; update `site/.../privacy-policy.md`.
- **Verify (browser/app):** connect flow, denial flow, calendar selection, correcting a wrong match end-to-end.

#### Phase 6: Cross-platform + docs
- `#[cfg(target_os="macos")]`-gate all native calls to no-ops; hide tab off macOS; confirm Windows/Linux build + recording path unaffected.
- Update `CLAUDE.md` (Gotchas: calendar permission + dev-mode TCC), `docs/architecture.md` (new module + data flow), and add a `docs/solutions/` entry if a new gotcha surfaces.

## System-Wide Impact

- **Interaction graph:** `start_recording` → `recording_commands` name resolution → `calendar::service::resolve_event_for_instant` (auth/store on main, fetch on a background thread) + `matching` → snapshot persisted with the `meetings` row → at summarization, snapshot fetched by `meeting_id`, redacted by egress, rendered as `<meeting_context>`. No new background threads (lookup-at-record-time; no polling).
- **Error propagation:** every calendar failure (no permission, no calendars, no match, EventKit error) degrades to "no context, timestamp title". The resolver returns `Option`, so calendar can **never** block or fail a recording by construction. Boundary errors stay `Result<_, String>`.
- **State lifecycle:** snapshot is written with the recording; cascade-deleted with it. No live coupling to the calendar after capture.
- **API surface parity:** any user action (connect, select calendars, attach/detach/correct, toggle cloud attendees) is exposed as a Tauri command, so it is scriptable/agent-reachable, not UI-only.
- **Integration test scenarios:** (1) record during a confirmed meeting → title + summary context; (2) back-to-back boundary; (3) permission revoked mid-session → graceful timestamp fallback; (4) cloud provider + calendar on → no emails in the outgoing prompt; (5) delete recording → `calendar_events` row gone.

## Acceptance Criteria

### Functional
- [ ] Opt-in master toggle (default OFF) in a macOS-only Calendar settings tab.
- [ ] EventKit permission requested via the macOS 14+ full-access API; `granted/denied/restricted/writeOnly/notDetermined` each handled with correct copy (restricted offers no "open settings"; writeOnly handled as denied = "grant full access").
- [ ] Recording during a high-confidence meeting is auto-titled with the event name; low-confidence keeps the timestamp title and only suggests; no match falls back silently; an explicit user-typed name always wins.
- [ ] Auto-match excludes all-day, multi-day, declined, canceled, and noise-calendar events; matches the correct recurring occurrence (disambiguated by occurrence start).
- [ ] Event snapshot stored in `calendar_events` (no emails) and cascade-deleted with the recording; `calendar_purge_all_snapshots` available and offered on disable.
- [ ] Summary includes a `<meeting_context>` block; notes secret-scrubbed then length-capped.
- [ ] User can attach / detach / change the matched event from the recording detail view.
- [ ] Per-calendar selection with noise calendars excluded by default.

### Non-Functional / Privacy
- [ ] No network calls and no credentials for the EventKit path; CSP unchanged.
- [ ] PII gate keys on `LLMProvider::data_egress` (default-deny; remote-host Ollama/CustomOpenAI = Remote), enforced in Rust at prompt assembly. The `MeetingContext` type has no email field.
- [ ] Remote summaries never include attendee/organizer emails (never stored) or the conference URL; names and notes excluded by default with explicit opt-in toggles + inline disclosure; privacy policy enumerates the new fields.
- [ ] EventKit store creation + auth run on main; `events(matching:)` runs off-main; auth completion never blocks main (no SIGABRT, no deadlock).
- [ ] Calendar failures never block or error a recording (resolver returns `Option`).

### Quality Gates
- [ ] `cargo test` (matching, egress classifier, repository/cascade) and `cargo check` clean (incl. cross-compile sanity for non-macOS gating).
- [ ] `pnpm -C src-svelte check` clean; `bindings.ts` regenerated (specta test passes).
- [ ] Permission flow verified on a **bundled** build (not `tauri dev`), including a clean-TCC denial path.
- [ ] Windows/Linux build succeeds; recording path unaffected; tab hidden.

## Edge-Case Matrix (from SpecFlow)

| Case | Behavior | MVP |
|---|---|---|
| Permission `restricted`/`writeOnly`/`notDetermined` | Distinct copy; fail closed | ✅ |
| Back-to-back / overlapping events | Window + scoring + boundary tie-break | ✅ |
| All-day / multi-day / declined / canceled | Excluded from auto-match | ✅ |
| Recurring | Match concrete occurrence (occurrence start stored) | ✅ |
| No-attendee / solo block | De-prioritized → low confidence | ✅ |
| No match / manual recording | Timestamp fallback, no row, silent | ✅ |
| Late/early start | eligible if `start-15min <= now <= end` (fetch window wider) | ✅ |
| Wrong match | Detach/change picker; low-conf = suggest | ✅ |
| Permission revoked mid-use | Re-check at record time → fallback | ✅ |
| Noise calendars | Excluded by default, per-calendar toggle | ✅ |
| Cloud attendee PII | Emails never stored/sent; names + notes off by default; URL stripped for remote | ✅ |
| Remote-host Ollama / CustomOpenAI | Classified as Remote by egress check | ✅ |
| Stale/changed event after recording | Snapshot semantics (frozen) | ✅ |
| Onboarding step | Settings-only; post-first-recording nudge | ⏳ defer |
| Live calendar watching | Lookup-at-record-time only | ⏳ defer |
| Manual "refresh from calendar" | Uses stored `event_identifier` | ⏳ defer |
| Google OAuth (Win/Linux) | Reserved opt-in fallback | ⏳ defer |
| Fuse with `meeting_detect` / Meet rescue | Decoupled for MVP | ⏳ defer |

## Decisions Made (pipeline mode — override if desired)

1. **Approach: local EventKit, not Google OAuth.** Privacy + reuse + coverage. OAuth deferred to a Windows/Linux opt-in fallback.
2. **Remote-egress data policy:** emails never stored or sent; attendee/organizer names AND notes off by default for remote with separate explicit opt-in toggles; conference URL stripped for remote. Gate keyed on a Rust `LLMProvider::data_egress` classifier (default-deny), enforced at prompt assembly. (Most privacy-protective defensible default for a local-first product.)
3. **Low-confidence match:** auto-apply the title only for high-confidence (single eligible event, self-accepted, has attendees, overlaps now); otherwise keep the timestamp and merely suggest.
4. **Onboarding:** settings-only for MVP; nudge after first successful recording.
5. **`keyring` stays at v3; use `objc2-event-kit` (NOT cidre).** The objc2 stack is already in `Cargo.lock`, so this is the no-bump path; cidre has no EventKit at the pinned rev. OAuth crates not added.
6. **macOS deployment floor pinned** (commit to 14+ for the new full-access API, or branch to legacy `requestAccess`). To confirm during Phase 1.

## Dependencies & Risks

- **macOS deployment floor** is the one open decision: 14+ (clean) vs adding a legacy `requestAccess` branch for 13. Confirm before Phase 1. (No cidre-EventKit risk: ruled out by direct source inspection.)
- **Dev-mode TCC attribution:** must validate on a bundled build, with a clean-TCC denial test.
- **Threading correctness:** auth on main + completion off-main + fetch off-main; never block main on the completion. The single most likely source of an intermittent crash/hang.
- **Egress classifier correctness** is the load-bearing privacy control: unit-test remote-host Ollama/CustomOpenAI and assert no `@`-tokens reach remote prompts.
- **Matching quality:** mitigated by the detach/change safety valve and low-confidence-suggest behavior.
- **No OAuth/token-refresh precedent** in the repo: irrelevant to MVP (only matters for the deferred fallback).

## Documentation Plan

- `CLAUDE.md` → Gotchas: calendar permission (EventKit full-access, restricted/writeOnly states, dev-mode TCC), and the new `calendar/` module in the module map.
- `docs/architecture.md` → new module + record-time hook + summary-context flow.
- `docs/solutions/` → add an entry if a new gotcha surfaces during implementation.

## Sources & References

### Internal references (verified)
- Command registration / specta builder / bindings test: `app/src-tauri/src/lib.rs:766-984`, `:218-234`, `:1231`.
- Managed state: `app/src-tauri/src/state.rs:1-5`; lazy `app.manage` `database/setup.rs:50`.
- Recording-start name hook: `app/src-tauri/src/audio/recording_commands/mod.rs:335-340`, `:530-534`; `RecordingSaver::set_device_info` `recording_saver.rs:82-95`.
- Permission UX precedent: `app/src-tauri/src/audio/permissions.rs` (enum `:10-18`, status `:28-78`, deep-link `:117-138`).
- Main-thread EventKit pattern + gotcha: `app/src-tauri/src/meeting_detect/watcher.rs:90-118`; `docs/solutions/runtime-errors/appkit-off-main-thread-crash-meeting-detection-20260620.md`.
- Summary injection seam: `summary/service.rs:366` (has `meeting_id`+`pool`), provider resolved `:387`, metadata reads `:462-483`, swallow idiom `:467`; inject after `<user_context>` at `summary/processor.rs:623-627`; `generate_meeting_summary` `:414`; `ProcessTranscriptParams` (10-param cap) `summary/commands.rs:179`.
- Egress classifier target: `LLMProvider` `summary/llm_client.rs:68-77`, egress map `build_request_target` `:281-312`; frontend `CLOUD_PROVIDERS` (incomplete, UI-only) `ModelSettingsModal.svelte:63-87`; cloud-warning Alert `ModelSettingsModal.svelte:594-600`.
- DB schema / repo / cascade: `migrations/20260616000000_initial_schema.sql`; `database/repositories/notes.rs`; `database/models.rs:79`; cascade in `database/repositories/meeting.rs:329-348`; settings precedent `repositories/setting.rs` + `migrations/20260619010000_add_auto_detect_meetings.sql`.
- External-call precedent (deferred OAuth path): shared client `providers/common.rs:22-31`; authed GET `providers/anthropic.rs`; keychain `keychain/mod.rs` (`keyring = "3"`, `Cargo.toml:157`); ADR `docs/adr/0001-keychain-secret-storage.md`.
- Deps: objc2 stack already in `Cargo.lock` (`objc2 0.6.4`, `block2 0.6.2`, `objc2-foundation 0.3.2`, `dispatch2 0.3.1`); `cidre` `Cargo.toml:183` (`features=["av"]`, NO EventKit); `Info.plist` (audio keys only); `entitlements.plist` (unsandboxed Developer ID); CSP `tauri.conf.json:32`; capabilities `tauri.conf.json:40-80`.
- Settings UI: `app/src-svelte/src/routes/(app)/settings/+page.svelte` (tabs via `$lib/ui/tabs.svelte`); store patterns `config.svelte.ts:14-15`, `recording-state.svelte.ts`. Privacy policy: `site/src/lib/content/privacy-policy.md:45-50`.

### External references (verified June 2026)
- EventKit changes (full-access API, macOS 14+): Apple TN3153 https://developer.apple.com/documentation/technotes/tn3153-adopting-api-changes-for-eventkit-in-ios-macos-and-watchos ; WWDC23 "Discover Calendar and EventKit" https://developer.apple.com/videos/play/wwdc2023/10052/
- `EKAuthorizationStatus` (writeOnly semantics) https://developer.apple.com/documentation/EventKit/EKAuthorizationStatus ; `requestFullAccessToEvents` https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoevents(completion:) ; `predicateForEvents` https://developer.apple.com/documentation/eventkit/ekeventstore/predicateforevents(withstart:end:calendars:)
- `objc2-event-kit` 0.3 / `objc2` 0.6 / `block2` 0.6 / `dispatch2` 0.3 https://docs.rs/objc2-event-kit • https://docs.rs/dispatch2 • https://github.com/madsmtm/objc2
- `cidre` (no EventKit module at rev a9587fa) https://github.com/yury/cidre
- Tauri 2 macOS bundle (Info.plist as file path, auto-merge at bundle time) https://v2.tauri.app/distribute/macos-application-bundle/ ; capabilities https://v2.tauri.app/security/capabilities/
- Google OAuth for native apps (loopback + PKCE; OOB deprecated) https://developers.google.com/identity/protocols/oauth2/native-app ; RFC 8252 §6/§7.3/§8.5; RFC 9700 (token storage)
- `keyring` (stay on v3 abstraction) https://crates.io/crates/keyring
- Comparables: Hyprnote (local EventKit), Granola (cloud OAuth).
