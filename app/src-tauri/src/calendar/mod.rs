//! Local calendar (macOS EventKit) meeting-context integration.
//!
//! Reads the user's local calendar read-only to enrich recordings and summaries
//! with the meeting happening at record time. macOS-only; other platforms compile
//! the native pieces to no-ops. Nothing leaves the device on this path.

pub mod commands;
pub mod conference;
pub mod context;
pub mod dedup;
pub mod eventkit;
pub mod google;
pub mod matching;
pub mod permissions;
pub mod scheduler;
pub mod service;

use serde::{Deserialize, Serialize};

/// Read access state for the local calendar, mirroring `EKAuthorizationStatus`.
/// `WriteOnly` is treated as insufficient (same as `Denied`) - we only read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CalendarAuthStatus {
    NotDetermined,
    Restricted,
    Denied,
    WriteOnly,
    Granted,
}

/// Which kind of source produced a candidate. Used by dedup precedence
/// (Google wins over the EventKit mirror) and snapshot attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceKind {
    EventKit,
    Google,
}

/// A calendar the user can include or exclude from matching.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CalendarInfo {
    pub id: String,
    pub title: String,
    /// True for noise calendars (subscriptions, birthdays) excluded by default.
    pub excluded_by_default: bool,
}
