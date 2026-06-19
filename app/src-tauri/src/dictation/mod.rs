//! Push-to-talk dictation: capture a mic-only burst, transcribe it, and return
//! the text. Mic capture is confined to a dedicated thread because cpal's stream
//! is `!Send`. Mutual exclusion with meeting recording lives in
//! `crate::audio::recording_commands` (`DICTATION_ACTIVE` / `can_start`).

pub mod capture;
pub mod commands;
pub mod inject;
