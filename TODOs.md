# TODOs: Granola-alternative feature gaps

Tracking what muesly still needs to match Granola (granola.ai) in features and UX.
Update this file when shipping — do not leave shipped work unchecked.

## Core note-taking flow

- [x] **In-meeting notes editor**
- [x] **Enhance flow merging user notes + transcript**
- [x] **Dual-color text**: AI summary uses muted foreground (`tone="ai"` on Editor);
      user notes keep default foreground. Mixed single-document dual-tone is residual
      (would need TipTap marks for AI vs user ranges).
- [x] **Transcript linking**: `[mm:ss]` tokens in summaries are clickable and jump
      the side panel to the nearest transcript segment (`transcript-link` helpers +
      `sidePanelState.jumpToSegment`).
- [x] **Template picker after generation**

## Meeting context

- [x] **Calendar integration (core)**: Coming Up list, multi-account Google + EventKit,
      auto-start scheduler, folder rules, conference join. Residual: polish "at top of
      notes list" density and join-link UX in more surfaces.
- [x] **Meeting detection (core)**: `meeting_detect` watcher for known apps with
      auto-prompt path. Residual: OS-level reliability when app is backgrounded.
- [x] **Attendee chips** on the meeting-details header from calendar shortlist/self.
- [x] **Speaker separation** + named speaker attribution / diarization (sherpa-onnx).

## Model quality

- [x] **Summary model catalog / hardware-aware default / single-pass headroom**
- [x] **Whisper decode quality**: prior-segment `initial_prompt` continuity +
      temperature ladder (`whisper_engine/decode_policy.rs`).
- [x] **Transcript cleanup pass**: Settings toggle (default off) + optional
      `MUESLY_TRANSCRIPT_CLEANUP=1` override; runs as an extra LLM call before summary.
- [x] **Cloud BYOK first-class**
- [x] **Me/Them speaker labels**
- [x] **Full local diarization** via sherpa-onnx helper + named speakers UI.
- [x] **Eval harness scaffold** under `app/scripts/eval/` (WER + summary rubric dry-run).
- [ ] Watch: Qwen3-ASR-1.7B and IBM Granite Speech as future engines.

## Recording reliability

- [x] Silent-input detection, system-audio permission, VAD fixes, normalizer gain cap, etc.
- [x] **System-audio tap level**: quiet system captures are peak-boosted toward a
      usable level (`compensate_system_audio_level` on the system pipeline path,
      max 12×, silence left alone). Residual: true output-volume compensation from
      CoreAudio device volume if peak boost is still insufficient.

## Chat / AI

- [x] **"Ask anything" chat bar** (streaming Channel + recipes).
- [x] **Natural-language search across meetings**: 3+ word queries also call
      `api_nl_search_meetings` and show a multi-meeting context pack on `/search`.

## Organization

- [x] Folders, trash
- [x] **People view** at `/people` (`api_list_people` groups by attendee name).

## Sharing & platform

- [x] Export markdown
- [x] **Menu bar recording indicator**: tray tooltip reflects Recording / Paused /
      transitional states (OS trays rarely support true animated level bars).
- [x] Dark mode

## UI polish

- [x] **Typefaces**: Inter Variable (body) + Lora Variable (display) via fontsource
      in `app.css` (`--font-sans` / `--font-display`).
- [x] Paper theme, home empty state, a11y sidebar rows

## Docs

- [ ] **Regenerate README screenshots/GIFs** (needs real UI capture session).

## Copy & positioning

- [x] **README** Why/Features reframed for speech-to-text + calendar/dictation.
- [x] **About subtitle** updated to speech-to-text positioning.
