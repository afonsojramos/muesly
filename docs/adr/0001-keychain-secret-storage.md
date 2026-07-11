# ADR 0001: Move Cloud API Keys to the OS Keychain

**Status**: Proposed (spike complete, implementation deferred)
**Date**: 2026-06-17
**Spike plan**: `plans/015-keychain-secret-storage-spike.md`

---

## Context

muesly stores cloud-provider API keys as plaintext text columns in the local SQLite database (`muesly.db` in the Tauri app-data directory). Any process running as the same user, any Time Machine or iCloud backup of the app-data directory, or anyone who copies the database file can read every key. For a product whose core promise is privacy, this is the weakest link.

The mature fix is to store secrets in the OS keychain and keep only a non-secret identifier in SQLite. This ADR records the result of the spike: a concrete secret inventory, the chosen approach with rationale, the Linux fallback strategy, a step-by-step migration plan, and the test requirements for the implementation follow-up.

---

## Step 1: Secret Inventory

### 1.1 Secrets currently in SQLite

The following columns exist in the `settings` table (mapped from the `Setting` struct in `app/src-tauri/src/database/models.rs`):

| Provider token | SQLite column | Credential type | Model struct field |
|---|---|---|---|
| `openai` | `openaiApiKey` | LLM provider API key | `openai_api_key` |
| `claude` | `anthropicApiKey` | LLM provider API key | `anthropic_api_key` |
| `groq` | `groqApiKey` | LLM provider API key (also used by transcript pipeline) | `groq_api_key` |
| `grok` | `xaiApiKey` | LLM provider API key | `xai_api_key` |
| `ollama` | `ollamaApiKey` | LLM provider API key (optional, some Ollama installs are open) | `ollama_api_key` |
| `openrouter` | `openRouterApiKey` | LLM provider API key | `open_router_api_key` |
| `custom-openai` | `customOpenAIConfig` (JSON blob) | Custom endpoint key embedded in JSON alongside `endpoint`, `model`, `maxTokens`, etc. | `custom_openai_config` |

The following columns exist in the `transcript_settings` table (mapped from `TranscriptSetting` in `app/src-tauri/src/database/models.rs`):

| Provider token | SQLite column | Credential type | Model struct field |
|---|---|---|---|
| `deepgram` | `deepgramApiKey` | Transcription provider API key | `deepgram_api_key` |
| `elevenLabs` | `elevenLabsApiKey` | Transcription provider API key | `eleven_labs_api_key` |
| `groq` (transcript) | `groqApiKey` | Transcription provider API key (same service, separate table row) | `groq_api_key` |
| `openai` (transcript) | `openaiApiKey` | Transcription provider API key | `openai_api_key` |
| `localWhisper` | `whisperApiKey` | API key for remote Whisper endpoint (optional) | `whisper_api_key` |

**Note on `ollama` and `localWhisper`**: these keys are optional even in normal use (Ollama typically runs without auth; local Whisper may not need a key). They are still secrets if set and must be treated identically to the others.

**Note on `customOpenAIConfig`**: the API key is embedded as the `apiKey` field inside a JSON string. The migration must extract the key, store it in the keychain, and rewrite the JSON blob with `apiKey: null` (or absent). The `endpoint` and model parameters in the blob are not secrets.

**Drift check performed**: confirmed on 2026-06-17 that no keychain/keyring code exists anywhere in `app/src-tauri/src/`. Keys are still in plaintext SQLite.

### 1.2 Call-site inventory

Every site that must change when the implementation lands. File paths are relative to the repository root.

#### Repository layer (`app/src-tauri/src/database/repositories/setting.rs`)

| Function | Direction | Lines |
|---|---|---|
| `SettingsRepository::save_api_key` | write — plaintext to SQLite column | 70–108 |
| `SettingsRepository::get_api_key` | read — from SQLite column | 111–141 |
| `SettingsRepository::save_transcript_api_key` | write — plaintext to SQLite column | 177–205 |
| `SettingsRepository::get_transcript_api_key` | read — from SQLite column | 210–233 |
| `SettingsRepository::delete_api_key` | delete — sets SQLite column to NULL | 236–270 |
| `SettingsRepository::save_custom_openai_config` | write — serializes full `CustomOpenAIConfig` to JSON including `apiKey` | ~325–345 |
| `SettingsRepository::get_custom_openai_config` | read — deserializes JSON including `apiKey` | 280–314 |

#### API command layer (`app/src-tauri/src/api/settings.rs`)

| Tauri command | Direction | Lines |
|---|---|---|
| `api_get_model_config` | read — calls `get_api_key` after loading provider | 27–74 |
| `api_save_model_config` | write — calls `save_api_key` when key is non-empty | 76–133 |
| `api_get_api_key` | read — direct call to `get_api_key`, exposed to frontend | 136–159 |
| `api_get_transcript_config` | read — calls `get_transcript_api_key` | 162–209 |
| `api_save_transcript_config` | write — calls `save_transcript_api_key` | 211–246 |
| `api_get_transcript_api_key` | read — direct call, exposed to frontend | 249–276 |
| `api_delete_api_key` | delete — calls `delete_api_key`, exposed to frontend | 279–305 |
| `api_save_custom_openai_config` | write — calls `save_custom_openai_config` | 310–380 |
| `api_get_custom_openai_config` | read — calls `get_custom_openai_config` | 384–407 |

#### Summary service (`app/src-tauri/src/summary/service.rs`)

| Location | Direction | Lines |
|---|---|---|
| Key read for LLM call | read — calls `get_api_key` then `get_custom_openai_config` | ~53–130 |

#### Tauri command registration (`app/src-tauri/src/lib.rs`)

| Symbol | Lines |
|---|---|
| `api::api_get_api_key` registered | ~874 |
| `api::api_get_transcript_api_key` registered | ~877 |
| `api::api_save_custom_openai_config` registered | ~899 |
| `api::api_get_custom_openai_config` registered | ~900 |

**Total sites that must change in the implementation**: 4 repository methods plus 1 repository method pair for custom-OpenAI, 9 command functions, 1 summary-service read path, and the `Setting` / `TranscriptSetting` models (key fields become dead columns pending removal).

---

## Step 2: Chosen Backend and Rationale

### Options evaluated

**Option A: `keyring` crate (cross-platform OS keychain)**
Backed by macOS Keychain Services, Windows Credential Manager, and Linux Secret Service D-Bus API (via `libsecret`). No user-facing password required; keys are scoped to the OS user account. The crate is actively maintained, has no `unsafe` surface in its public API, and the platform backends are all mature.

**Option B: `tauri-plugin-stronghold`**
An encrypted vault managed by the app. Requires a user-supplied password or a derived key (e.g., from a device identifier). Adds a non-trivial key-derivation step and user-facing unlock flow. Appropriate when secrets must survive without an OS keychain (e.g., headless servers), but that is not muesly's target environment.

**Option C: Encrypted SQLite columns (AES-GCM, key from OS keychain)**
Keeps secrets in the database but encrypts them with a key that itself lives in the OS keychain. Strictly more complex than Option A with no additional security benefit for the threat model here.

### Decision: Option A (`keyring` crate)

The `keyring` crate (crates.io: `keyring`, current stable series is `3.x`) fits the threat model directly: protect keys at rest from accidental exposure via file copy or backup. It adds one dependency and about 30 lines of wrapper code. The other options add more code and introduce user-facing complexity that muesly does not need.

**Dependency to add** to `app/src-tauri/Cargo.toml`:

```toml
keyring = "3"
```

No features flag is needed for the default backends (macOS/Windows/Linux Secret Service).

### What SQLite keeps after migration

After the migration, the `*ApiKey` columns and `customOpenAIConfig.apiKey` are set to `NULL`. The columns remain in the schema (dropping them is a separate, later migration) so that the code does not break on databases that have not yet migrated. The columns serve only as a "has this been migrated?" signal: `NULL` means the key has been moved (or was never set); a non-NULL value means the migration has not run yet for that row.

**The SQLite row never stores a key value again after migration.**

### Linux fallback when Secret Service is unavailable

On some Linux configurations (headless, minimal desktop, or CI), the Secret Service D-Bus endpoint may be absent. `keyring` will return a `NoStorageAccess` or similar error on the first write attempt.

The chosen fallback is **fail loudly, not silently**:

1. On first launch, before running the migration, check whether the keychain backend is reachable by attempting to store and delete a dummy test entry.
2. If the check fails, emit a user-visible warning (Tauri notification or in-app banner) explaining that the OS keychain is unavailable and that API keys will remain in the database until it is set up.
3. The app continues to function using the plaintext SQLite path as a degraded but working state.
4. On subsequent launches the check runs again; once a Secret Service provider is available the migration runs automatically.

This is a better tradeoff than silently keeping keys in plaintext with no indication, or blocking the app entirely. It is also consistent with the STOP condition in the spike: the fallback is defined and surfaced rather than hidden.

**Linux users who want full protection** should install a Secret Service provider (e.g., `gnome-keyring` or `kwallet`). The app can link to setup instructions from the warning banner.

---

## Step 3: Migration Plan

### Overview

On first launch after the upgrade, before any other key read/write operation, the app runs a one-time migration:

1. Open the SQLite pool.
2. For each key column that is non-NULL, call the keychain backend to store it, then clear the column.
3. Handle per-key failures individually so that one bad key does not block others.
4. Record migration completion in a settings column (e.g., `keychainMigrated` boolean, default `FALSE`).

### Detailed steps

```
1. Read all key columns from the settings row.
2. For each non-NULL key (including the `apiKey` field inside `customOpenAIConfig`):
   a. Attempt keychain write:
      keyring::Entry::new("muesly", "<service-name>")?.set_password(value)
      Service names follow the pattern: "muesly-<provider>-api-key"
      e.g., "muesly-openai-api-key", "muesly-custom-openai-api-key"
   b. If the write succeeds: set the SQLite column to NULL.
   c. If the write fails (keychain unavailable): leave the column as-is and record
      the failure. Proceed to the next key.
3. After processing all keys, if any write failed:
   a. Emit a user-visible warning (see Linux fallback above).
   b. Do NOT set keychainMigrated = TRUE.
   c. The migration will re-run on the next launch for the remaining keys.
4. If all writes succeeded (or no keys were set): set keychainMigrated = TRUE.
   This prevents re-running the migration and touching NULL columns on every launch.
```

### Failure path

When a keychain write fails for a given key:

- The plaintext value stays in SQLite as the authoritative source for that key.
- The app still functions (the existing read path falls back to SQLite if the keychain entry is absent).
- A persistent banner or settings-page warning informs the user.
- The failure is logged with enough context to diagnose (e.g., the OS error code).
- The migration retries on the next launch until it succeeds for all keys.

The dual-read path (try keychain first, fall back to SQLite) is a transitional shim that can be removed in a later release once it is safe to assume all installs have migrated.

### Key rotation recommendation

Moving a key from SQLite to the keychain does not un-expose it. Any key that was stored in plaintext in a database file that was synced to iCloud, backed up with Time Machine, or copied manually must be treated as potentially exposed.

**The migration prompt should include a clear message:**

> "Your API keys have been moved to the OS Keychain for better security. If your database file was ever backed up to cloud storage or shared with another person, consider regenerating your API keys at each provider's website, as the previous copies may still exist in those backups."

This message should appear once, on the first successful migration. It should not be dismissible silently — require an explicit "I understand" acknowledgment before it disappears.

### WAL and backup risk

SQLite's WAL (write-ahead log) mode means that even after `UPDATE settings SET openaiApiKey = NULL`, the previous plaintext value may still exist in `muesly.db-wal` or in a checkpoint-before-truncation state within the main database file until the next full VACUUM. Time Machine and other backup tools may capture the WAL file. This is why the rotation recommendation above is essential: migration removes the live reference but cannot guarantee removal from all backup copies.

---

## Step 4: Prototype

This checkout is not a git repository, so the optional throwaway prototype described in Step 4 of the spike plan was not built here. A runtime prototype is a deferred follow-up. To verify that `keyring 3.x` round-trips a dummy value on the target platform, the operator should:

1. Create a scratch branch off `main`.
2. Add `keyring = "3"` to `app/src-tauri/Cargo.toml`.
3. Write a small `#[test]` or `fn main()` that calls:
   ```rust
   let entry = keyring::Entry::new("muesly-prototype", "test-key")?;
   entry.set_password("dummy-value")?;
   let retrieved = entry.get_password()?;
   assert_eq!(retrieved, "dummy-value");
   entry.delete_credential()?;
   ```
4. Run it on macOS, Windows, and a representative Linux desktop to confirm no platform-specific caveats.

Known platform notes from the `keyring` crate documentation (as of the 3.x series):
- **macOS**: stores in the login keychain; requires the binary to be code-signed for distribution builds. Development builds with ad-hoc signing or unsigned CLI binaries work in the user's session.
- **Windows**: stores in the Windows Credential Manager; no additional requirements.
- **Linux**: requires a running Secret Service provider. The crate will return an error if none is available; it does not silently no-op.
- **Linux CI**: most CI environments do not have a Secret Service. Tests that touch the keychain must be gated (e.g., `#[ignore]` or a feature flag) to avoid CI failures.

---

## Implementation Testing Plan

These tests do not exist yet. They are the required test coverage for the implementation PR.

### Unit test: keychain wrapper

File: `app/src-tauri/src/keychain/mod.rs` (new module, implementation follow-up)

```
- store_and_retrieve_roundtrip:
    store a dummy value under "muesly-test-<uuid>", retrieve it, assert equal, delete it.
- store_overwrites_existing:
    store value A, store value B for the same key, retrieve, assert B.
- delete_nonexistent_is_ok:
    call delete for a key that was never stored; assert Ok(()) or a typed "not found" variant.
- retrieve_absent_returns_none:
    call get for a key that was never stored; assert Ok(None).
```

These tests touch the real OS keychain. Gate them with `#[ignore]` in CI, or behind a Cargo feature `keychain-integration-tests` that CI does not enable.

### Integration test: migration

File: `app/src-tauri/src/database/repositories/setting.rs` (extend the existing test module)

Use the in-memory SQLite harness established in plan 008:

```
- migration_moves_key_and_clears_column:
    1. Seed the in-memory DB with a plaintext key in, e.g., openaiApiKey.
    2. Run the migration function against a mock keychain backend (injectable trait).
    3. Assert: the mock keychain received the correct service name and value.
    4. Assert: the column is NULL in SQLite after migration.
    5. Assert: keychainMigrated is TRUE.

- migration_retries_on_keychain_failure:
    1. Seed a key. Configure the mock keychain to return an error.
    2. Run migration. Assert: column still non-NULL. keychainMigrated is FALSE.
    3. Fix the mock. Run migration again. Assert: column NULL, keychainMigrated TRUE.

- migration_handles_custom_openai_apikey:
    1. Seed a customOpenAIConfig JSON with an apiKey field.
    2. Run migration.
    3. Assert: keychain received the key under "muesly-custom-openai-api-key".
    4. Assert: the stored JSON has apiKey absent or null.

- dual_read_path_prefers_keychain:
    1. Write a key to both the mock keychain and the SQLite column (simulating
       a partially migrated state).
    2. Call the read wrapper. Assert keychain value is returned.

- dual_read_path_falls_back_to_sqlite:
    1. Write a key only to the SQLite column.
    2. Configure mock keychain to return "not found".
    3. Call the read wrapper. Assert SQLite value is returned.
```

The mock keychain backend should be a simple `HashMap<String, String>` behind a trait object so these tests run without touching the OS keychain and can run in CI.

---

## Open Questions

1. **`groq` appears in both `settings` and `transcript_settings`**: the same provider token maps to two separate columns. After migration, there should be two separate keychain entries (e.g., `muesly-groq-api-key` and `muesly-groq-transcript-api-key`). The implementation must not conflate them.

2. **`openai` also appears in both tables**: same issue. Distinct keychain entry names needed.

3. **Column removal timing**: the `*ApiKey` columns should be removed from the schema in a follow-up migration after the dual-read shim is removed. Premature removal will break installs that have not yet migrated. The removal follow-up should be gated on a minimum supported version that guarantees the migration has run.

4. **Code signing on macOS**: Tauri 2 development builds use ad-hoc signing. Confirm that the keychain entry survives between runs under ad-hoc signing (it should, because the keychain access is user-scoped, not code-signature-scoped for self-signed items). Test with a notarized production build before shipping.

5. **`delete_api_key` for `custom-openai`** currently clears the entire `customOpenAIConfig` JSON, not just the key. After migration, delete should remove the keychain entry and also rewrite the JSON blob with `apiKey` removed, preserving `endpoint`, `model`, and optional parameters.

---

## Relation to Other Plans

- **Plan 013** (DB-repo tests): the migration integration tests require an in-memory SQLite harness. If plan 013 has not landed yet, build the harness as part of this implementation.
- **Plan 014** (filesystem blast radius): that plan narrows which files can be accessed from the app; this plan narrows the credential blast radius. They are complementary.

---

## Implementation Follow-up

This ADR is the deliverable of the spike. The implementation is a separate plan. When that plan lands, update this ADR's status to "Accepted" and link to the implementation PR.
