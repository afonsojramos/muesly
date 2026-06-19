//! Meeting auto-detection.
//!
//! When enabled, a foreground-app [`watcher`] notices a known meeting app
//! ([`known`]) coming to the front and emits `meeting-app-detected` so the
//! frontend can offer to start recording. First-class on macOS, a clean no-op
//! elsewhere. The [`commands`] expose the enable/disable toggle.

pub mod commands;
pub mod known;
pub mod watcher;
