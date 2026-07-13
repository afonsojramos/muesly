# Analytics Event Taxonomy — Registry Proposal

**Status**: Spike proposal (Plan 031, 2026-06-18)

---

## 1. Current-state event inventory

Events are emitted two ways: generic TS `Analytics.track(name, props)` / `invoke('track_event', …)` dispatched from the frontend, and dedicated Rust commands assembled inside `app/src-tauri/src/analytics/client.rs`. No shared declaration exists today.

### 1a. TypeScript-emitted events (via `Analytics.track` → `invoke('track_event')`)

| Event name | Call site | Property keys |
|---|---|---|
| `session_started` | `analytics.ts:trackSessionStarted` | `session_id`, `days_since_last_meeting`, `total_meetings`, `platform`, `os_version`, `architecture` |
| `session_ended` | `analytics.ts:trackSessionEnded` | `session_id`, `session_duration_seconds`, `meetings_in_session`, `platform`, `os_version` |
| `app_started` | `analytics.ts:trackAppStarted` | `timestamp` |
| `meeting_completed` | `analytics.ts:trackMeetingCompleted` | `meeting_id`, `duration_seconds`, `transcript_segments`, `transcript_word_count`, `words_per_minute`, `meetings_today`, `day_of_week`, `hour_of_day`, `platform`, `os_version` |
| `microphone_selected` | `DeviceSelection.svelte:handleMicDeviceChange` | `device_category`, `is_bluetooth`, `has_system_audio` |
| `system_audio_selected` | `DeviceSelection.svelte:handleSystemDeviceChange` | `device_category`, `is_bluetooth`, `has_microphone` |
| `theme_changed` | `PreferenceSettings.svelte:handleThemeChange` | `theme` |
| `preferences_viewed` | `PreferenceSettings.svelte:$effect` | `notifications_enabled` |
| `notification_settings_changed` | `PreferenceSettings.svelte:handleNotificationToggle` | `notifications_enabled` |
| `storage_folder_opened` | `PreferenceSettings.svelte:handleOpenRecordingsFolder` | `folder_type` |
| `auto_save_recording_toggled` | `RecordingSettings.svelte` | `enabled` |
| `default_devices_changed` | `RecordingSettings.svelte` | `microphone`, `system_audio` |
| `recording_notification_preference_changed` | `RecordingSettings.svelte` | `show_recording_started`, `show_recording_stopped` |
| `button_click` | `sidebar.svelte.ts` | `name`, `location` |
| `user_id_copied` | `AnalyticsConsentSwitch.svelte` | `user_id` |
| `beta_feature_toggled` | `config.svelte.ts` | `feature`, `enabled` |
| `button_click_<name>` | `RecordingControls.svelte`, `Sidebar.svelte`, `SummaryGeneratorButtonGroup.svelte`, `TranscriptButtonGroup.svelte`, `SummaryUpdaterButtonGroup.svelte`, `SummaryPanel.svelte`, `use-recording-start.svelte.ts`, `use-recording-stop.svelte.ts` | `button`, `location` (via `trackButtonClick`) |
| `page_view_<name>` | `+page.svelte`, `MeetingDetailsView.svelte`, `use-recording-stop.svelte.ts`, `meeting-details/+page.svelte` | `page` (via `trackPageView`) |
| `error` | `analytics.ts:trackError` | `error_type`, `error_message` |
| `transcription_error` | `RecordingControls.svelte`, `use-recording-stop.svelte.ts` | `error_message`, `timestamp` |
| `transcription_success` | `RecordingControls.svelte` | `duration`, `timestamp` |
| `summary_generation_started` | `use-summary-generation.svelte.ts` | `model_provider`, `model_name`, `transcript_length`, `platform`, `os_version`, `time_since_recording_minutes` |
| `enhance_transcript_started` | `RetranscribeDialog.svelte` | `model`, `language` |
| `enhance_transcript_completed` | `RetranscribeDialog.svelte` | `model`, `language`, `duration_seconds` |
| `enhance_transcript_failed` | `RetranscribeDialog.svelte` | `error_type`, `error_message` (via `trackError`) |
| `import_audio_started` | `use-import-audio.svelte.ts` | `file_extension`, `file_size_mb` |
| `import_audio_completed` | `use-import-audio.svelte.ts` | `duration_seconds`, `file_extension` |
| `import_audio_failed` | `use-import-audio.svelte.ts` | `error_type`, `error_message` (via `trackError`) |
| `copy` | `use-copy-operations.svelte.ts` | `type`, `location` |
| `user_activated` | `use-recording-stop.svelte.ts` | `meetings_count`, `days_since_first_launch` |
| `feature_used` | `use-templates.svelte.ts` | `feature` |
| `model_changed` | `use-model-configuration.svelte.ts` | `new_provider`, `new_model` |
| `settings_changed` | `use-model-configuration.svelte.ts` | `setting_type`, `new_value` |

### 1b. Rust-assembled events (dedicated Tauri commands, properties assembled in `client.rs`)

| Event name | Tauri command | Property keys |
|---|---|---|
| `session_started` | (internal `start_session`) | `session_id`, `timestamp` |
| `session_ended` | (internal `end_session`) | `session_id`, `session_duration`, `timestamp` |
| `daily_active_user` | `track_daily_active_user` | `user_id`, `date`, `timestamp` |
| `user_first_launch` | `track_user_first_launch` | `timestamp`, `app_version` |
| `meeting_deleted` | `track_meeting_deleted` | `meeting_id`, `timestamp` |
| `settings_changed` | `track_settings_changed` | `setting_type`, `new_value`, `timestamp` |
| `app_started` | `track_app_started` | `app_version`, `timestamp` |
| `feature_used` | `track_feature_used` | `feature_name`, `timestamp` |
| `summary_generation_completed` | `track_summary_generation_completed` | `model_provider`, `model_name`, `success`, `timestamp`, `duration_seconds`?, `error_message`? |
| `summary_regenerated` | `track_summary_regenerated` | `model_provider`, `model_name`, `timestamp` |
| `model_changed` | `track_model_changed` | `old_provider`, `old_model`, `new_provider`, `new_model`, `timestamp` |
| `custom_prompt_used` | `track_custom_prompt_used` | `prompt_length`, `timestamp` |
| `meeting_ended` | `track_meeting_ended` | `transcription_provider`, `transcription_model`, `summary_provider`, `summary_model`, `total_duration_seconds`?, `active_duration_seconds`, `pause_duration_seconds`, `microphone_device_type`, `system_audio_device_type`, `chunks_processed`, `transcript_segments_count`, `had_fatal_error`, `timestamp` |
| `analytics_enabled` | `track_analytics_enabled` | `timestamp` |
| `analytics_disabled` | `track_analytics_disabled` | `timestamp` |
| `analytics_transparency_viewed` | `track_analytics_transparency_viewed` | `timestamp` |

### 1c. Existing privacy contracts

Two prose documents define "never collect" rules:

**`AnalyticsDataModal.svelte` — `notCollected` array:**
- Meeting names or titles
- Meeting transcripts or content
- Audio recordings
- Device names (only types: Bluetooth/Wired)
- Personal information
- Any identifiable data

**`PRIVACY_POLICY.md` — "What we never collect":**
- Recordings, audio, transcripts, or notes
- Recording titles, file names, or participant information
- Personal or identifiable data
- LLM conversations or AI-generated content

**Plan 028 denylist (`SENSITIVE_PROPERTY_KEYS` in `client.rs`):**
```
device_name, meeting_title, meeting_name, user_agent, file_name, file_path
```

This denylist is a **reactive backstop**: it strips known-bad keys if a call site accidentally includes them. The registry proposed here is the **proactive complement**: call sites cannot name keys outside the declared allowlist.

---

## 2. STOP-condition check: new leaks found?

Reviewing all events above against the "never collect" rules:

- No event sends `device_name` (plan 025 fixed this; `device_metadata.ts` returns only `category` and `isBluetooth`).
- No event sends `meeting_title` or `meeting_name`.
- No event sends `file_name` or `file_path` (import events use only `file_extension` and `file_size_mb`).
- No event sends `user_agent`.
- `user_id_copied` in `AnalyticsConsentSwitch.svelte` sends `user_id` — this is the randomly-generated anonymous ID the user is copying for support purposes, not a PII field. This is explicitly not in the "never collect" category and is consistent with the privacy policy.

**Result: no new leaks found. Proceeding with the spike.**

---

## 3. Recommended registry design

**Recommendation: Option C = Option A (TS-first typed registry) + conformance check.**

### Why Option A + conformance check (not Option B)

Option B (shared JSON/TOML schema consumed by both TS and Rust via codegen) is the theoretically complete solution, but it requires:
- A build step that runs schema validation/codegen for Rust
- Maintenance of a codegen pipeline in the workspace
- Alignment with the planned `tauri-specta` bindings work (see Open Questions below)

Option A delivers most of the safety value now, at low cost, with one structural limitation: the Rust-assembled events (section 1b) are not typed by it. That limitation is explicit and documentable. The `SENSITIVE_PROPERTY_KEYS` denylist in `client.rs` remains as the backstop for the Rust path.

The conformance check (part C) is the highest-value piece: it converts "we never collect X" from a prose promise into a tested invariant. Even if only the TS path is typed for now, the test asserting no registry event declares a forbidden key is permanently valuable.

### Design of `analytics-events.ts`

```typescript
// Declare each event as a key → readonly tuple of allowed property keys.
// The track<E>() wrapper enforces that callers only pass declared keys.
// To add or rename a property, update the tuple here first.

export const REGISTRY = {
  microphone_selected: ['device_category', 'is_bluetooth', 'has_system_audio'],
  system_audio_selected: ['device_category', 'is_bluetooth', 'has_microphone'],
  theme_changed: ['theme'],
  // ... grow incrementally
} as const;

export type EventName = keyof typeof REGISTRY;
export type PropsOf<E extends EventName> = Record<
  (typeof REGISTRY)[E][number],
  string
>;

export function track<E extends EventName>(
  event: E,
  props: PropsOf<E>
): Promise<void>;
```

Call sites change only superficially:

**Before** (`DeviceSelection.svelte`):
```ts
Analytics.track('microphone_selected', {
  device_category: metadata.category,
  is_bluetooth: metadata.isBluetooth.toString(),
  has_system_audio: (!!selectedDevices.systemDevice).toString()
})
```

**After** (`DeviceSelection.svelte`):
```ts
track('microphone_selected', {
  device_category: metadata.category,
  is_bluetooth: metadata.isBluetooth.toString(),
  has_system_audio: (!!selectedDevices.systemDevice).toString()
})
```

Identical runtime behavior. The only change is compile-time enforcement.

---

## 4. Migration outline

The migration is intentionally incremental. Each event moves in its own PR; no big-bang rewrite.

### Phase 1 (this spike): 3 events proved

- `microphone_selected`, `system_audio_selected`, `theme_changed` — done in this PR.
- Conformance check for these 3 events — done.

### Phase 2: High-traffic TS events

Add the following to `REGISTRY` and route their call sites:
- `session_started`, `session_ended` (in `analytics.ts`)
- `meeting_completed` (in `analytics.ts`)
- `summary_generation_started` (in `use-summary-generation.svelte.ts`)
- `import_audio_started`, `import_audio_completed` (in `use-import-audio.svelte.ts`)
- `preferences_viewed`, `notification_settings_changed`, `storage_folder_opened` (in `PreferenceSettings.svelte`)
- `auto_save_recording_toggled`, `default_devices_changed`, `recording_notification_preference_changed` (in `RecordingSettings.svelte`)
- `user_activated` (in `use-recording-stop.svelte.ts`)

Each migration verifies: `nub --cwd src-svelte run check` passes; no new properties added; conformance test still green.

### Phase 3: Button-click and page-view families

`button_click_<name>` and `page_view_<name>` are generated dynamically via `trackButtonClick` / `trackPageView`. These need a slightly different approach: either a template registry (e.g. `button_click: ['button', 'location']`) or migration to explicit event names. This is a design decision for Phase 3.

### Phase 4: Rust-assembled events (requires Option B or specta)

Events in section 1b are assembled entirely in Rust. A TS-only registry does not cover them. Three approaches:

1. **Document and test only** — add the Rust events to the registry as comments or a separate `RUST_REGISTRY` object. The conformance test checks their declared properties against the denylist, but the Rust code is not type-checked against it. The denylist in `client.rs` remains the enforcement mechanism.

2. **Adopt tauri-specta** (see Open Questions) — if `tauri-specta` is adopted for typed command bindings, it may provide a natural place to declare the analytics event schema for Rust commands. The two efforts should be coordinated to avoid parallel schemas.

3. **JSON schema + build check (Option B)** — a `docs/analytics-events.json` schema consumed by both a TS import and a Rust build script. Most robust, most machinery. Defer until Phase 4 is funded.

`meeting_ended` is the canonical example of the Rust-assembled path. It is called by `track_meeting_ended` in `recording_commands.rs`, assembled entirely in Rust, and does not flow through `Analytics.track` in TypeScript at all. A TS registry (Option A) provides zero compile-time coverage for it; the denylist in `client.rs` remains its only guard.

---

## 5. Open questions — answered

**Q: Is one registry enough, or do the TS and Rust paths need separate-but-reconciled declarations?**

One registry is *not* sufficient to enforce types on both paths with Option A. The TS registry enforces at TS call sites only. For now: one registry covers the TS path; the Rust path is governed by the `SENSITIVE_PROPERTY_KEYS` denylist. A shared schema (Option B) would unify them — recommended as Phase 4 work, contingent on whether `tauri-specta` makes the Rust side typed first.

**Q: Should the modal's "What We Collect" categories be generated from the registry, or just checked against it in a test?**

Checked in a test, not generated. Generation couples UI copy to code structure; a small wording change requires a code change. The test approach (assert no registry event declares a forbidden key) is the minimum viable invariant without coupling. The modal's positive claims ("we collect recording duration") are prose and should stay prose — they are accurate and unlikely to drift dangerously. The dangerous drift is false negatives ("we never collect X" becoming false in code), which the conformance test catches.

**Q: Where does the `SENSITIVE_PROPERTY_KEYS` denylist from plan 028 fit?**

It is an **independent backstop**, not derived from the registry. The registry's allowlist and the denylist are complementary: the allowlist prevents call sites from naming undeclared keys (proactive); the denylist strips known-bad keys even if a call site somehow includes them (defensive). The conformance test links the two: it asserts that the registry's declared keys do not include any key on the denylist, which would mean the allowlist and denylist are consistent.

**Q: Does this interact with the `tauri-specta` bindings work?**

Yes. The `docs/plans/` directory references a plan for typed command bindings via specta. If specta is adopted, Tauri commands (including the analytics commands like `track_meeting_ended`) get typed TS bindings generated from Rust. That partially addresses the "one registry vs two" problem for the command-invocation direction (TS → Rust argument types). It does not address the event taxonomy (what properties each logical analytics event carries), but it reduces the surface area where a mismatch can occur. The two efforts should be coordinated: do not build a TS-side `RUST_REGISTRY` for analytics command arguments if specta will generate those types anyway.
