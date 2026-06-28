//! Local calendar (macOS EventKit) meeting-context integration.
//!
//! Reads the user's local calendar read-only to enrich recordings and summaries
//! with the meeting happening at record time. macOS-only; other platforms compile
//! the native pieces to no-ops. Nothing leaves the device on this path.

pub mod matching;
