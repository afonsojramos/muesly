---
title: "Calendar Sources: Google OAuth + multiple accounts"
type: feat
status: active
date: 2026-06-29
---

# ✨ Calendar Sources: Google OAuth + multiple accounts

## TL;DR

Turn the single local-calendar feature into a **list of calendar sources**, any number enabled at once:

- **On this Mac** (the existing EventKit source), plus
- **one or more connected Google accounts** (read-only, OAuth).

At resolve time muesly fetches from every enabled source concurrently, **dedups across sources**, then runs the existing matcher. Google events convert to the same `CalendarEventCandidate` and flow through the existing matching, redaction, egress gate, and snapshot unchanged (the `calendar_events.source` column already supports `"google"`). Everything stays off by default; the local path remains the privacy-preserving default.

**Hard precondition for public release (not a code task):** the maintainer must complete Google **sensitive-scope verification** for `calendar.events.readonly` and move the OAuth consent screen to **In production**. While the app is in Testing, refresh tokens expire every 7 days and there is a 100-user cap. The feature is fully buildable/testable in Testing mode; it just can't ship broadly until verified. Verification is free (~10 business days), but needs muesly.ai serving a same-domain privacy policy with the Limited Use statement, domain ownership in Search Console, and a demo video.

## Deepening Review — Corrections & Refinements (2026-06-29)

Four expert agents (Rust principal, security, simplicity, OAuth integration research) hardened this plan. The items below **override** any earlier wording; treat them as authoritative.

### Critical correctness/concurrency (Rust review)
1. **`join_all` has no deadline.** Wrap **each** source future in `tokio::time::timeout(budget, fut)` *before* `join_all` (a single stalled socket otherwise blows the budget and the never-block contract). Also give the Google client an explicit **per-request reqwest timeout** (the shared `providers/common.rs` client has none) shorter than the source budget.
2. **Per-`sub` refresh single-flight + in-memory access-token cache.** Concurrent refreshes of one refresh token trip Google's `invalid_grant`/waste grants. Hold a `Mutex<HashMap<sub, Arc<tokio::sync::Mutex<CachedToken>>>>`; re-check expiry under the per-account lock; cache the access token + `expires_at` in memory so the common case does zero network refresh.
3. **Each fan-out arm returns `Vec`, never `Result`.** Collapse `JoinError` (EventKit panic under `spawn_blocking`), `timeout::Elapsed`, `reqwest::Error`, and auth errors to an empty `Vec` + a status side-effect. One source failing is structurally incapable of zeroing the others.
4. **Merge "fill from loser" touches snapshot-payload fields ONLY** (`location`, `conference_url`, `notes`, `organizer_name`, `calendar_name`, `ical_uid`) — **never** scoring fields (`my_participation`, `i_am_organizer`, `attendee_count`, `event_status`, `start`/`end`), or dedup reintroduces nondeterministic confidence.
5. **`account_id`/`ical_uid` are plain nullable columns, NO foreign key.** SQLite can't add an FK via `ALTER TABLE`, and a cascade from `calendar_accounts` would delete history on disconnect (contradicts "keep snapshots"). Comment the intent: "deliberately not a FK; snapshots outlive accounts."
6. **OAuth command is plain `async fn`, NOT `spawn_blocking`** (browser-open is a quick spawn; exchange/userinfo are async reqwest; the wait is an async `oneshot` timeout). No blocking section to wrap.
7. **`reauth_required` only on `invalid_grant`** (parse the token-endpoint JSON `error`), never on timeout/offline/5xx. No retry on `invalid_grant` (a dead token won't recover); retry-once is for 5xx/network. Use a typed `thiserror` `OauthError` enum so the fan-out can match `InvalidGrant` rather than string-matching. Status writes are idempotent/last-writer-wins; never write `status='ok'` unless a fetch actually succeeded.
8. **No `CalendarSource` trait** (heterogeneous sync EventKit vs async Google → `async-trait` boxing for no gain). Function fan-out with enum-style arms. `SourceKind` is a single `mod.rs` enum; a single constructor keeps `source` and `account_id` consistent; `matching.rs` carries them but never reads them.

### OAuth security (security review)
9. **Identity via the userinfo endpoint over TLS** (`https://openidconnect.googleapis.com/v1/userinfo`) with the fresh access token — **not** an unverified id_token decode. `sub` is the keychain key + isolation boundary, so it must be trustworthy; userinfo avoids shipping JWKS verification and a `jsonwebtoken` dependency.
10. **Loopback hardening:** bind `127.0.0.1` only (assert `is_loopback() && !is_unspecified()`); reject callbacks on any path but the exact registered `/`; PKCE **S256** (`new_random_sha256`, never plain); RAII `Drop` guard tears the listener down on every exit path (success/error/timeout/cancel); ephemeral port per flow.
11. **CSRF `state`:** `CsrfToken::new_random` (≥128 bits), single-use, held in memory with the PKCE verifier for that one flow, constant-time compare, reject a second/forged callback.
12. **OAuth error hygiene (real leak path):** the project logs HTTP error bodies elsewhere and the analytics denylist is key-based (free-text `error_message` value is NOT scrubbed). Map all OAuth/token/refresh/revoke errors to **fixed, value-free strings** (mirror `classify_http_error` in `llm_client.rs` which excludes the body); never log the auth URL (has client_id/state/challenge), the redirect URL (has the code), or token bodies; never route OAuth errors into analytics. Test: error strings contain no `Bearer`, `refresh_token=`, or `@`.
13. **Disconnect ordering:** delete the keychain entry **first** (idempotent; `NoEntry` is Ok), then best-effort `revoke`, then delete the row last. If the keychain delete errors (not `NoEntry`), surface it and do **not** delete the row (never orphan a live token). Capture `sub` before deleting the row.
14. **No-email invariant must be ENFORCED, not incidental.** The Google mapper actively reads `attendees[].email`/`organizer.email` to compute `self`/responseStatus, then drops them. Add the single highest-value test: feed an `events.list` fixture with real emails, assert the resulting candidate AND snapshot contain zero email substrings anywhere; add a `debug_assert` in `build_snapshot` for `source=="google"`.
15. **Reword the "no email" invariant:** attendee/organizer emails are never stored or sent; the **connected account's own email** IS stored locally (SQLite) as the account label and never leaves the device. Contract-test that the account email never appears in analytics/logs/LLM prompts.
16. **Google description/notes email redaction:** Google descriptions (auto Meet blurbs) embed organizer emails. Extend the existing snapshot scrub to also redact email-shaped tokens before storage; test alongside the existing scrub tests.
17. **Hop A is always-on and opt-in:** contract-test that with all Google accounts disabled, `fetch_all_candidates` makes **zero** Google network calls. Priming copy must state it connects to Google regardless of your summary/AI choice, read-only, automatically while recording, and that disconnect stops it.
18. **Scope-creep guard:** a single hardcoded scope constant `openid email https://www.googleapis.com/auth/calendar.events.readonly`; test the built auth URL contains exactly that and no broader `/auth/calendar` or `/auth/calendar.readonly`.

### Simplifications (simplicity review — applied to the body)
19. **Cut `google/tokens.rs`** → reuse the existing `keychain::SecretStore` + add a `google_token_key(sub) -> "google-oauth-{sub}"` helper (gets the `MockStore` test harness for free).
20. **Collapse `google/{oauth,client}.rs` → one `calendar/google.rs`** (one PKCE flow + two REST endpoints is right-sized for a single file).
21. **Drop `tauri-plugin-opener`** → open the consent URL with the `open` crate (or the `std::process::Command` pattern already used for the System Settings deep-link). Net new deps: **`oauth2` + `tauri-plugin-oauth` only**.
22. **`CalendarAccountsRepository`: list / upsert / delete / get** (one-column updates fold into `upsert`).
23. **Trim `calendar_accounts` columns:** drop `sub` (it IS the `id` for Google rows), `label` (use `email`; user-editable label deferred), `last_synced_at` (no consumer). Keep `id, source, email, enabled, excluded_calendar_ids, status, created_at`.
24. **DEFER the record-start Google prefetch.** Keep `calendar_title_override` (record-start hot path) **EventKit-only**; the single Google entry point for v1 is the stop-time `attach`. (This also reduces the concurrency surface for item 2, though the single-flight + cache stay as cheap insurance.)
25. **DEFER dedup tier-2 (fuzzy).** Tier-1 `(normalized iCalUID, instance-start rounded to the minute)` closes the `matching.rs:187` confidence trap for the dominant case (EventKit mirrors Google's UID via CalDAV). Ship tier-1; keep the pure `dedup` module + seam so the fuzzy tier is a localized fast-follow. Deferring fuzzy avoids false-merge data-loss; the cost is occasional missed dedup → Low confidence (annoying, not lossy).
26. **Replace the verification-mode flag with a single hardcoded constant** (the project ships "with confidence, not feature flags"). Hardcode the Testing-mode "in review, reconnect ~weekly" copy; flip the constant in the one commit that accompanies going to production.
27. **DEFER a dedicated reconnect command** (login_hint/sub-match/different-sub guard). For v1, "reconnect" routes through **remove + re-add**; the `reauth_required` badge points there. The add flow already enforces the no-partial-row and sub-from-this-flow invariants.
28. **Phases: 8 → 4 chunks + docs** (see revised phases below).

### Concrete integration references (verified 2026)
- `oauth2` v5: `BasicClient::new(ClientId)...set_auth_uri/set_token_uri/set_redirect_uri`; `PkceCodeChallenge::new_random_sha256()`; `.authorize_url(CsrfToken::new_random).add_scope(...).set_pkce_challenge(...).add_extra_param("access_type","offline").add_extra_param("prompt","consent")`; `.exchange_code(code).set_pkce_verifier(v).request_async(&client)`; `.exchange_refresh_token(&RefreshToken)`. Build the reqwest client with `redirect(Policy::none())`.
- `tauri-plugin-oauth` v0.2 (Tauri 2): `start_with_config(OauthConfig{ports, response}, |full_url| ...)` returns the bound port; `cancel(port)` to tear down.
- `events.list?timeMin&timeMax&singleEvents=true&orderBy=startTime&maxResults=2500&showDeleted=false`; map `summary→title`, `start.dateTime|date→start_time` (`.date` ⇒ all-day), `iCalUID→ical_uid`, `attendees[].displayName` (+ `self`/`responseStatus`→my_participation, never email), `organizer.displayName→organizer_name`, `location`, `hangoutLink`/`conferenceData.entryPoints[].uri→conference_url`, `description→notes` (scrub), `status→event_status`, `recurringEventId`/`originalStartTime` for recurrence. 401 ⇒ refresh then retry. Refresh: POST token endpoint `grant_type=refresh_token` (response omits a new `refresh_token`; keep the original).

---

## Overview

Add Google Calendar as an additional, opt-in calendar **source** alongside the local macOS EventKit source, supporting **multiple Google accounts** simultaneously. The settings UI becomes a source list (account groups, each with per-calendar toggles). The backend generalizes from one implicit source to N sources via a small account model + an OAuth/REST client for Google, with a pure cross-source dedup step feeding the existing matcher.

## Problem Statement / Motivation

The shipped calendar feature reads only the local macOS calendar. That covers Google/iCloud/Exchange **if** the user has added those accounts to macOS Calendar, but: (1) Windows/Linux users have no local source; (2) users who don't sync Google into macOS can't use it; (3) the OAuth path gives richer, fresher event data (per-attendee `responseStatus`, `conferenceData`/`hangoutLink`, structured organizer) than the EventKit mirror. The user wants calendar sources to be "a list of options, multiple enabled at once," including multiple Google accounts.

## Proposed Solution

A **multi-source model**:

- A new `calendar_accounts` table lists sources. The local EventKit source is one synthetic row (`id = "eventkit-local"`); each connected Google account is a row keyed by its Google `sub`. Each row has its own `enabled` flag and per-account excluded-calendar ids. The existing `calendar_context_enabled` stays as the **master** feature toggle (a source is consulted only if master is on AND the account is enabled).
- A `calendar/google/` submodule implements OAuth (loopback + PKCE, system browser, refresh token in keychain) and a minimal read-only REST client (`calendarList.list`, `events.list`).
- `service.rs` fans out to all enabled sources concurrently with a per-source timeout, merges, **dedups** (new pure module), then runs the existing matcher. Per-source failure isolates (one bad account never zeroes the others, never blocks a recording).
- Google events convert to `CalendarEventCandidate`; matching, `context.rs` redaction, the `data_egress` gate, and the `calendar_events` snapshot are **unchanged**.

### Two egress hops (keep distinct)

- **Hop A — muesly ↔ Google** (the fetch): happens whenever a Google account is enabled, *regardless of summary provider*, even for a 100%-local summary user. Must be disclosed separately.
- **Hop B — muesly ↔ cloud LLM** (the summary): governed by the existing `data_egress` default-deny gate + name/note toggles. Unchanged.

### Alternatives Considered

| Option | Verdict | Why |
|---|---|---|
| `oauth2` crate (PKCE) + `reqwest` REST + `tauri-plugin-oauth` loopback | **Chosen** | Full multi-account control; refresh tokens in the OS keychain (not a plaintext cache); only 2 REST endpoints needed, so no heavy SDK. |
| `yup-oauth2` + `google-calendar3` | Rejected | yup-oauth2 caches tokens to disk in plaintext by default; google-calendar3 is heavy for 2 endpoints; less multi-account control. |
| Custom URI scheme redirect | Rejected | Google retains loopback for desktop; custom schemes deprecated for native and worse UX. |
| Frontend-driven fetch | Rejected | Would need Google hosts in CSP `connect-src`; all network stays in Rust (reqwest bypasses the WebView CSP), so no CSP change. |

## Hard Precondition: Google OAuth Verification

`calendar.events.readonly` is a **sensitive** scope (not restricted → **no CASA, no fee**). Before public release the maintainer must:

1. Serve a login-free privacy policy on muesly.ai (same domain as the consent screen) including the verbatim Limited Use statement.
2. Verify domain ownership in Google Search Console (same Google account).
3. Configure the consent screen **External**, create a **Desktop** OAuth client, add `calendar.events.readonly` (+ `openid email` to identify the account).
4. Record an unlisted demo video (shows the consent grant, app name, client id in the URL, scope use).
5. Submit verification and move to **In production**.

Until then: keep the app in **Testing** with ≤100 test users and an honest in-app notice that reconnection is needed ~weekly. The client id ships in the binary (public client; PKCE is the protection). Build/test with a dev client id via config/env.

## Technical Approach

### Data model

```mermaid
erDiagram
    calendar_accounts ||--o{ calendar_events : "attributes (by account_id)"
    meetings ||--o| calendar_events : "snapshot (0..1)"

    calendar_accounts {
        text id PK "google sub, or 'eventkit-local'"
        text source "eventkit | google"
        text sub "google subject id (null for eventkit)"
        text email "label; null for eventkit"
        text label "user-editable; default email / 'On this Mac'"
        integer enabled
        text excluded_calendar_ids "JSON array, per-account"
        text status "ok | reauth_required (null = ok)"
        text last_synced_at "RFC3339, nullable"
        text created_at
    }
    calendar_events {
        text meeting_id PK_FK
        text account_id "which source won the dedup (new column)"
        text source "eventkit | google"
        text ical_uid "new: cross-system UID for dedup audit"
        text title
        text start_time
        text end_time
        text organizer_name
        text attendees_json "names only, NO emails"
        text location
        text conference_url
        text notes "scrubbed + capped"
        text calendar_name
        text match_confidence
        text created_at
    }
```

- New migration `app/src-tauri/migrations/2026MMDDHHMMSS_add_calendar_accounts.sql` (sqlx file-based, **not Drizzle** — the global Drizzle rule does not apply to this repo):
  - `CREATE TABLE calendar_accounts (...)`.
  - `ALTER TABLE calendar_events ADD COLUMN account_id TEXT;` and `ADD COLUMN ical_uid TEXT;`.
  - **Backfill** the local source: insert one `eventkit-local` row with `enabled = (old calendar_context_enabled)`, `excluded_calendar_ids = (old calendar_excluded_ids)`. Keep `calendar_context_enabled` as master; the old `calendar_excluded_ids` column becomes legacy (read once for backfill).
  - `send_attendee_names_to_cloud` / `send_notes_to_cloud` stay **global** (they describe the cloud boundary, not a source).
- `CalendarAccount` model in `database/models.rs`; `CalendarAccountsRepository` in `database/repositories/calendar_accounts.rs` (list, get, upsert, set_enabled, set_status, set_excluded, delete). Add `account_id`/`ical_uid` to the `CalendarEvent` model + the snapshot writer; add `calendar_events` to nothing new in cascade (already cascades by `meeting_id`).

### Module layout

```
app/src-tauri/src/calendar/
  mod.rs            # + CalendarAccount-related re-exports, SourceKind
  matching.rs       # unchanged (operates on the deduped merged list)
  context.rs        # unchanged (Hop B redaction)
  eventkit.rs       # + read calendarItemExternalIdentifier into candidate.ical_uid
  dedup.rs          # NEW: pure cross-source dedup (testable, platform-free)
  sources.rs        # NEW: fan-out + per-source isolation + timeout + merge + dedup
  service.rs        # resolve/attach now call sources::fetch_all
  permissions.rs    # unchanged (EventKit permission)
  commands.rs       # + account/google commands
  google/
    mod.rs
    oauth.rs        # PKCE loopback flow: build auth URL, capture code, exchange, refresh, revoke
    client.rs       # reqwest: calendarList.list, events.list -> CalendarEventCandidate
    tokens.rs       # keychain get/set/delete refresh token per account (keyring v3)
```

### `CalendarEventCandidate` additions

Add (platform-free) fields used only for dedup/attribution, not scoring:
- `ical_uid: Option<String>` — EventKit `calendarItemExternalIdentifier`; Google `iCalUID`.
- `source: SourceKind` (`EventKit | Google`) and `account_id: String` — for dedup precedence (Google wins) and snapshot attribution.

EventKit currently reads `eventIdentifier` (local series id); add `calendarItemExternalIdentifier` for `ical_uid` (the cross-system UID; note one external id can map to multiple EKEvents, so dedup the EventKit side against itself first).

### Cross-source dedup (`dedup.rs`) — runs BEFORE the matcher

**Critical:** dedup must precede `match_event`. The matcher's high-confidence rule is `eligible.len() == 1` (`matching.rs:187`); a meeting present in both Google and the EventKit mirror would make `eligible.len() == 2` and silently downgrade **every** such meeting to Low confidence (titles never auto-applied). This is a real bug if dedup is skipped.

- **Primary key:** `(normalized iCalUID, instance-start)` — instance start, not series start, so recurring occurrences stay distinct.
- **Fuzzy fallback** (when iCalUID missing/differs): `(normalized title + start instant within ≤60s + equal duration)`. **No coarse start bucketing** — back-to-back same-titled meetings (14:00 and 14:30) must stay distinct. Merge only when title is non-empty and normalized-equal AND start within tolerance AND duration equal. Bias toward false-distinct (two cards) over false-merge (lost meeting).
- **Winner:** the Google-OAuth copy wins over the EventKit mirror (richer/fresher); fill empty fields from the loser; record the winning `account_id`.
- Unit tests: duplicate-across-sources does **not** downgrade confidence; back-to-back same-title does **not** merge; Google-wins; conservative fuzzy fallback.

### Fan-out (`sources.rs`)

`fetch_all_candidates(pool, now, budget) -> Vec<CalendarEventCandidate>`:
- List enabled accounts (master on). For EventKit: `spawn_blocking(eventkit::fetch_candidates)` (if permission granted). For each Google account: `google::client::fetch_candidates(account, now)` (async, refreshes token as needed).
- `join_all` with a **shared per-source deadline** (≈3s at stop-time attach; ≈1.5s for the optional record-start prefetch). Each source wrapped so failure → empty Vec + a status side-effect (`invalid_grant` → mark `reauth_required`, emit event, keep cached data). Merge all, then `dedup::dedupe`.
- Preserves the existing "never block/fail a recording" contract: the resolver still returns `Option`, and the frontend attach is already non-blocking (`use-recording-stop.svelte.ts:161`).

### Google OAuth (`google/oauth.rs`)

- `oauth2` crate (PKCE S256). Auth URL params: `client_id`, `scope = "openid email https://www.googleapis.com/auth/calendar.events.readonly"`, `redirect_uri = http://127.0.0.1:<ephemeral>/`, `access_type=offline`, `prompt=consent`, `state` (CSRF), `code_challenge`. `login_hint=<email>` on reconnect.
- Open the auth URL in the **system browser** (tauri-plugin-opener, or `open`/`xdg-open`); capture the redirect via `tauri-plugin-oauth`'s loopback server (bound to `127.0.0.1`, small port range, 5-min timeout, torn down after).
- Validate `state`; on `error=access_denied` or missing scope → fail (no row). Exchange code+verifier → tokens. Require a `refresh_token` (fail the connect if absent). Decode `id_token`/call userinfo for `sub`+`email`. Store refresh token in keychain keyed by `sub`; persist the account row.
- `refresh` (exchange_refresh_token), `revoke` (best-effort POST to the revoke endpoint on disconnect). On `invalid_grant`: retry once, else mark `reauth_required`.

### Google REST (`google/client.rs`) — reqwest, read-only

- `calendarList.list` → `Vec<CalendarInfo>` (id, summary→title, primary flag).
- `events.list?timeMin&timeMax&singleEvents=true&orderBy=startTime` over `now-2h..now+2h` per selected calendar → events. Map → `CalendarEventCandidate`: title=summary; start/end from `dateTime` (or `date` → all-day); `iCalUID`; attendees (displayName→name, `self`+`responseStatus`→my_participation, organizer); `responseStatus=="declined"` → declined; `hangoutLink`/`conferenceData`→conference_url else scan location/description; description→notes; status→event_status. **Emails parsed but never stored** (names only), matching the EventKit path. Use the shared `reqwest` client; bearer access token (refresh on 401).

### Commands (`commands.rs`) + bindings + capabilities

New (all `#[tauri::command] #[specta::specta]`, registered in `collect_commands!`, bindings regenerated; app-local so no capability entries needed, matching repo convention):
- `calendar_list_accounts() -> Vec<CalendarAccount>`
- `calendar_add_google_account(app) -> Result<CalendarAccount, String>` (runs OAuth, spawn_blocking-wrapped where it blocks)
- `calendar_reconnect_account(app, account_id) -> Result<CalendarAccount, String>` (login_hint + consent; sub-match-in-place; different-sub guard)
- `calendar_remove_account(account_id, delete_snapshots: bool)` (revoke + keychain delete + row delete; keep snapshots by default)
- `calendar_set_account_enabled(account_id, enabled)`
- `calendar_list_account_calendars(account_id) -> Vec<CalendarInfo>` (google: REST; eventkit: existing list)
- `calendar_set_account_excluded_ids(account_id, ids)`
- `calendar_set_account_label(account_id, label)`

Refactor: the existing global `calendar_list_calendars` / `calendar_get_excluded_ids` / `calendar_set_excluded_ids` become per-account (the feature is unreleased, so changing them is free). Keep `calendar_context_enabled` get/set (master), `send_*_to_cloud`, permission commands, attach/detach/get/purge.

### Frontend (`CalendarSettings.svelte`)

Becomes a **source list** (IA from research — Apple/Fantastical/Reclaim consensus):
- A flat list of collapsible **source groups**: "On this Mac" pinned first (EventKit permission state inline), then one group per Google account labeled by email (left-edge color accent), each with an account master toggle + nested per-calendar switches + a Disconnect action.
- "Add Google account" button (verb-led) at the end; empty state with a clear CTA so off ≠ broken.
- **Priming consent dialog before the browser** (Hop A disclosure: read-only, device↔Google, what's read, disconnect anytime) + a Testing-mode notice ("in review; reconnect ~weekly until approved"). Rewrite the now-false "nothing sent to Google" intro to be source-aware.
- `reauth_required` → inline "Reconnect" badge per account; the rest stays functional. Wrong-account escape hatch: show the resolved email with "Not you? Disconnect".
- Cross-platform: usability = master on AND ≥1 enabled source (not EventKit-based); on non-macOS, omit "On this Mac" and show only Google.

### Verification-mode flag

A build/config flag `google_oauth_verification = testing | production` drives the priming notice and `reauth_required` copy (gentle weekly-reconnect in Testing vs genuine-revocation in Production).

### Privacy

- In-app prominent disclosure before OAuth (Hop A). Privacy policy gets a "Google Calendar connection" section + the verbatim Limited Use statement, on muesly.ai (same domain). Triad: read-only & minimal · device-only, no server copy · no human review / no training / no sale.
- Disconnect revokes the token, clears the keychain entry and (opt-in) that account's snapshots; point users to myaccount.google.com/permissions for account-level revocation.
- Hop B unchanged: Google-sourced events get the same redaction/egress gating before any cloud LLM.

### Implementation Phases (4 chunks + docs)

Merged from 8 to remove artificial verification boundaries (per the simplicity review). Each chunk is independently testable.

**Chunk A — Multi-source model + dedup (the riskiest correctness work, EventKit-only).**
- sqlx migration: `calendar_accounts` (trimmed columns; `INSERT OR IGNORE` the `eventkit-local` row with `enabled=1`, `excluded_calendar_ids` backfilled from the old global column); add nullable `account_id`/`ical_uid` to `calendar_events` (no FK). `CalendarAccount` model + `CalendarAccountsRepository` (list/upsert/delete/get).
- `eventkit.rs`: read `calendarItemExternalIdentifier` into `candidate.ical_uid`; set `source`/`account_id` via the single candidate constructor.
- `dedup.rs`: pure, deterministic-ordered, tier-1 only (iCalUID+instance-start-rounded), dedup EventKit-against-itself, Google-wins, merge only snapshot-payload fields. Runs **before** the matcher.
- `sources.rs` (or a `service.rs` fn): fan-out with per-source `tokio::time::timeout`, each arm → `Vec`. EventKit-only for now.
- Verify: existing EventKit behavior intact via the account row; dedup tests incl. the `eligible.len()==1` trap and back-to-back; `cargo test` green.

**Chunk B — Google OAuth + REST + token lifecycle.**
- `calendar/google.rs`: `oauth2` PKCE/state + `tauri-plugin-oauth` loopback (ephemeral port, Drop-guard teardown, 300s timeout, `127.0.0.1`-only, exact path); userinfo for `sub`/email; refresh token via `keychain` (`google-oauth-{sub}`); per-`sub` single-flight + in-memory token cache; `calendarList.list` + `events.list` → candidate (no emails); typed `OauthError`; `invalid_grant`→`reauth_required` (no retry), 5xx/network→empty+keep-status; value-free error strings.
- Add-account failure taxonomy (cancel/deny/wrong-account/port/offline/no-refresh-token). Hardcoded minimal scope constant.
- Verify: unit tests (auth-URL scope/state, PKCE, no-email mapping from a fixture, error-string hygiene, token-cache single-flight); manual round-trip on a bundled build with a dev client id.

**Chunk C — Wire commands + bindings + stop-time attach.**
- Register commands; regenerate `bindings.ts`; fan-out (EventKit + enabled Google accounts) used by stop-time `attach` (≤3s). Record-start stays EventKit-only.
- Hop-A zero-network-when-disabled contract test.

**Chunk D — Frontend source list.**
- Account groups ("On this Mac" + Google accounts), add/remove/enable, per-account calendars, priming consent disclosure (Hop A), Testing-mode reconnect copy (constant), `reauth_required` badge (reconnect = remove+add for v1), empty/error states, source-aware intro copy.

**Docs (release gate, not optional).** `PRIVACY_POLICY.md` (Limited Use verbatim + "Google Calendar connection" section), `docs/architecture.md`, new `docs/google-oauth-setup.md` (maintainer Cloud project + verification checklist), CLAUDE.md gotchas (coordinate — user edits CLAUDE.md).

Deferred to fast-follow: dedup tier-2 (fuzzy), record-start Google prefetch + per-account cache, dedicated reconnect command, EventKit-mirror "hide the Mac copy" hint, per-account snapshot purge UI, user-editable label / Work-Personal chip.

## System-Wide Impact

- **Interaction graph:** record-start `calendar_title_override` and stop-time `calendar_attach_event` → `service` → `sources::fetch_all` (EventKit spawn_blocking + Google async, join with deadline) → `dedup` → `matching` → snapshot (with `account_id`) → summary `<meeting_context>` (Hop B gate). New: per-account token refresh; `reauth_required` events.
- **Error propagation:** per-source isolation; any source failure → empty for that source + status side-effect; resolver returns `Option`; recording never blocked. Boundary errors `Result<_, String>`.
- **State lifecycle:** account rows + keychain tokens; snapshot attributes the winning account; disconnect cleans token+row, keeps snapshots by default; partial OAuth failures never persist a row.
- **API surface parity:** every action (add/remove/reconnect/enable/select-calendars/label) is a Tauri command (agent-reachable), not UI-only.
- **Integration tests:** (1) Google+EventKit duplicate → one card, confidence not downgraded; (2) one account `invalid_grant` → others still resolve, recording unaffected; (3) offline → EventKit-only snapshot, no `reauth_required`; (4) disconnect → keychain entry gone even when revoke fails, row gone, snapshots kept; (5) all accounts disabled → zero Google network calls (Hop A opt-in).

## Acceptance Criteria

### Functional
- [ ] Calendar settings shows a source list: "On this Mac" + N Google accounts, each independently enabled, all off by default behind the master toggle.
- [ ] Add Google account via loopback + PKCE + system browser; refresh token stored in keychain by `sub`; account row persisted with email label.
- [ ] Add-account failures each have a defined terminal state (cancel, deny scope, wrong account, port blocked, offline, no refresh token); no partial rows; CSRF `state` validated.
- [ ] Multiple Google accounts coexist; connecting the same `sub` twice updates in place; per-account calendar selection works.
- [ ] At resolve time, all enabled sources fetch concurrently with a per-source deadline; one source's failure never zeroes others or blocks a recording.
- [ ] Cross-source duplicates dedup before the matcher (Google wins); confidence is NOT downgraded by a duplicate; back-to-back same-title events do not merge.
- [ ] Google events produce the same redacted `<meeting_context>` via the existing egress gate; emails never stored/sent.
- [ ] Disconnect deletes the keychain entry first (idempotent), best-effort revokes, then deletes the row; snapshots kept by default; keychain delete failure (not `NoEntry`) surfaces and aborts the row delete.
- [ ] `invalid_grant` → immediate per-account `reauth_required` badge (no retry); 5xx/network/offline → empty-this-cycle, status untouched, cached data retained; never blocks a recording.

### Non-Functional / Privacy
- [ ] All Google network calls in Rust; CSP unchanged. Per-request reqwest timeout set; each source future individually `tokio::time::timeout`-wrapped (not a join-level deadline).
- [ ] Hop A disclosed in-app before OAuth and in the privacy policy (Limited Use verbatim); Hop B gate unchanged.
- [ ] Identity resolved via the userinfo endpoint over TLS (not an unverified id_token decode). Loopback bound to `127.0.0.1` only; PKCE S256; CSRF `state` random/single-use/constant-time.
- [ ] Refresh tokens only in keychain (`google-oauth-{sub}`); only non-secret metadata in SQLite; the connected account's own email is stored locally as a label only and never sent. OAuth error strings are value-free (no `Bearer`/`refresh_token=`/`@`); auth/redirect URLs and token bodies never logged; OAuth errors never routed into analytics.
- [ ] Cross-platform: feature usable with Google-only (no EventKit) off macOS; builds on Windows/Linux.

### Quality Gates
- [ ] **No-email enforcement test:** an `events.list` fixture containing real emails yields a candidate AND snapshot with zero email substrings anywhere (the single highest-value test); `debug_assert` in `build_snapshot` for `source=="google"`.
- [ ] **Hop-A opt-in test:** all Google accounts disabled → `fetch_all_candidates` makes zero Google network calls.
- [ ] **Scope-creep test:** built auth URL scope param is exactly the minimal constant; no `/auth/calendar` (full) or `/auth/calendar.readonly`.
- [ ] Dedup tests: duplicate across sources does NOT downgrade confidence; EventKit-against-itself deduped; back-to-back same-title not merged; merge preserves the winner's scoring fields.
- [ ] OAuth tests: state mismatch aborts (no row/exchange); two concurrent `build_auth_url` produce distinct state/verifier; disconnect leaves keychain entry gone even when revoke is stubbed to fail; per-`sub` refresh single-flight coalesces concurrent refreshes.
- [ ] `cargo test` + `cargo check` + `cargo clippy` (new files) clean; `pnpm -C src-svelte check` clean; `bindings.ts` regenerated.
- [ ] OAuth flow verified manually on a bundled build with a dev client id (the only path that exercises the consent prompt).

## Edge-Case Matrix (from SpecFlow)

| Case | Behavior | MVP |
|---|---|---|
| User cancels / closes browser | Loopback listener times out (5 min), no row | ✅ |
| Denies scope / missing scope in grant | Discard token, no row, clear message | ✅ |
| No refresh token returned | Fail connect (`access_type=offline`+`prompt=consent` always) | ✅ |
| Wrong Google account | Show resolved email + "Not you? Disconnect" | ✅ |
| Loopback port blocked | Try port range, else actionable error | ✅ |
| Same account connected twice | Dedup by `sub`, update in place | ✅ |
| Duplicate event (OAuth + EventKit mirror) | Dedup before matcher, Google wins, confidence intact | ✅ |
| Back-to-back same-title meetings | Stay distinct (exact start+duration) | ✅ |
| Token `invalid_grant` mid-use | Retry once → reauth_required, degrade to cached, never block | ✅ |
| One account fails, others ok | Per-source isolation, partial merge | ✅ |
| Offline | Google sources empty fast, EventKit still works | ✅ |
| Disconnect account | Revoke + clear keychain + drop row, keep snapshots | ✅ |
| Reconnect | v1: remove + re-add (badge points there); add flow enforces sub-from-this-flow | ✅ |
| Testing-mode 7-day expiry | Honest weekly-reconnect copy (hardcoded constant, not a flag) | ✅ |
| Migration of old single-source settings | `INSERT OR IGNORE` `eventkit-local` (`enabled=1`) + backfill excluded ids | ✅ |
| Non-macOS | Google-only source list; usability = ≥1 enabled source | ✅ |
| Dedup tier-2 (fuzzy title+time+duration) | Tier-1 (iCalUID) ships; fuzzy deferred (avoids false-merge) | ⏳ defer |
| Record-start Google prefetch | Stop-time attach is the single Google entry point | ⏳ defer |
| Dedicated reconnect command (login_hint/sub-match) | Reconnect = remove + re-add | ⏳ defer |
| EventKit-mirror "hide the Mac copy" toggle | Hint only, never auto-hide | ⏳ defer |
| Targeted per-account snapshot purge UI | Global purge exists as fallback | ⏳ defer |
| Work/Personal domain auto-label chip + editable label | Email is the label | ⏳ defer |
| Background proactive token refresh | Refresh at resolve time (single-flight + in-memory cache) | ⏳ defer |

## Decisions Made (pipeline mode — override if desired)

1. **Stack:** `oauth2` (PKCE) + `reqwest` REST + `tauri-plugin-oauth` (loopback). Refresh tokens in keychain (keyring v3, reuse the existing `SecretStore`; no `google/tokens.rs`). System browser via the `open` crate (no `tauri-plugin-opener`). Net-new deps: `oauth2` + `tauri-plugin-oauth` only. Not yup-oauth2/google-calendar3/jsonwebtoken.
2. **Scope:** `calendar.events.readonly` (+ `openid email` for identity); identity via the **userinfo endpoint** (no id_token JWKS verification). Read-only; hardcoded scope constant.
3. **Single Google entry point = stop-time attach** (≤3s); record-start `calendar_title_override` stays EventKit-only (Google prefetch deferred).
4. **Disconnect keeps snapshots** by default; keychain-delete-first ordering; opt-in delete + targeted purge UI deferred (global purge exists).
5. **Ship in Testing mode to a limited beta** with an honest weekly-reconnect notice (a **hardcoded constant**, not a feature flag); full release gated on Google verification.
6. **`send_names`/`send_notes` stay global** (cloud boundary, not per-source). EventKit-mirror hint deferred.
7. **No refresh token → fail the connect.** `account_id`/`ical_uid` are plain nullable snapshot columns (no FK). One `calendar/google.rs`; `dedup.rs` + `sources.rs` as files; repo = list/upsert/delete/get; account columns trimmed (no `sub`/`label`/`last_synced_at`).
8. **Dedup tier-1 only** (iCalUID + instance-start) ships and closes the matcher confidence trap; fuzzy tier deferred. Merge fills only snapshot-payload fields.

## Dependencies & Risks

- **Google verification** is the gating release prerequisite (see above). Build/test unaffected; ship gated.
- **New deps:** `oauth2`, `tauri-plugin-oauth`, `tauri-plugin-opener` (or reuse `open`). Net-new but standard.
- **Dedup correctness** is the highest-risk logic (the confidence-downgrade trap). Mitigated by pre-matcher placement + targeted tests.
- **OAuth flow** can only be fully verified on a bundled build with a real client id; unit-test the URL/state/PKCE/mapping, manually verify the consent round-trip.
- **Multi-account token refresh** (Google's 100-tokens/account cap, 6-month unused expiry) — refresh on resolve; `reauth_required` path covers revocation.
- **Privacy posture:** adds a genuine cloud/account dependency, opt-in and off by default, disclosed; the local path remains the default.

## Documentation Plan

- `PRIVACY_POLICY.md` (root, source of truth) → "Google Calendar connection" section + verbatim Limited Use statement.
- `docs/architecture.md` → multi-source model, OAuth, dedup, two egress hops.
- New `docs/google-oauth-setup.md` → maintainer's Google Cloud project + verification checklist.
- `CLAUDE.md` → gotchas (Testing-mode 7-day expiry; loopback+PKCE; tokens in keychain). (Coordinate — the user edits CLAUDE.md.)

## Sources & References

### Internal (verified, current)
- Calendar module: `app/src-tauri/src/calendar/{mod,matching,context,eventkit,service,permissions,commands}.rs`; matcher confidence trap `matching.rs:187`; global exclusions `service.rs:33`; snapshot 1-per-meeting `database/repositories/calendar.rs`; egress gate `summary/llm_client.rs` (`data_egress`).
- Stop-time non-blocking attach: `app/src-svelte/src/lib/hooks/use-recording-stop.svelte.ts:161`; now-false copy `CalendarSettings.svelte` intro.
- Migrations are sqlx file-based (`database/manager.rs` `sqlx::migrate!`), latest `migrations/20260628160000_add_calendar_events.sql`; keychain `keychain/mod.rs` (`keyring = "3"`); command registration `lib.rs` `collect_commands!` + bindings test.

### External (verified 2026)
- Google OAuth for native/desktop (loopback + PKCE; OOB dead): https://developers.google.com/identity/protocols/oauth2/native-app ; loopback: https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration ; RFC 8252.
- Scope choice (`calendar.events.readonly`, sensitive not restricted): https://developers.google.com/workspace/calendar/api/auth ; sensitive vs restricted: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification , https://support.google.com/cloud/answer/13464325 .
- Limited Use / User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- Events API (`events.list`, `iCalUID`, `singleEvents`): https://developers.google.com/calendar/api/v3/reference/events
- EventKit cross-system id `calendarItemExternalIdentifier`: https://developer.apple.com/documentation/eventkit/ekeventstore/1507281-calendaritems
- Crates: `oauth2` (PKCE), `tauri-plugin-oauth` (loopback, Tauri 2), `keyring` v3 — https://docs.rs/oauth2 • https://github.com/FabianLars/tauri-plugin-oauth • https://crates.io/crates/keyring
- Dedup heuristic precedent (title+time+location): Fantastical duplicate merging (2026).
- Comparable IA: Apple Calendar, Fantastical, Notion Calendar, Reclaim (account→calendar tree).
