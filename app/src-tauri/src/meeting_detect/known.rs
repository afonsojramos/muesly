//! Known meeting applications, matched by macOS bundle identifier.

/// A meeting application muesly recognizes when it comes to the foreground.
pub struct KnownMeetingApp {
    /// macOS bundle identifier (e.g. `"us.zoom.xos"`).
    pub bundle_id: &'static str,
    /// Human-readable name shown in the "start recording?" prompt.
    pub name: &'static str,
}

/// Native meeting apps recognized by default. Browser-based meetings (e.g.
/// Google Meet) are intentionally excluded: foreground-app detection cannot tell
/// a meeting tab apart from any other browser tab.
pub const DEFAULT_MEETING_APPS: &[KnownMeetingApp] = &[
    KnownMeetingApp {
        bundle_id: "us.zoom.xos",
        name: "Zoom",
    },
    KnownMeetingApp {
        bundle_id: "com.microsoft.teams",
        name: "Microsoft Teams",
    },
    KnownMeetingApp {
        bundle_id: "com.microsoft.teams2",
        name: "Microsoft Teams",
    },
    KnownMeetingApp {
        bundle_id: "com.cisco.webexmeetingsapp",
        name: "Webex",
    },
];

/// Return the display name of the known meeting app with `bundle_id`, if any.
pub fn match_meeting_app<'a>(bundle_id: &str, known: &'a [KnownMeetingApp]) -> Option<&'a str> {
    known
        .iter()
        .find(|app| app.bundle_id == bundle_id)
        .map(|app| app.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_apps_by_bundle_id() {
        assert_eq!(
            match_meeting_app("us.zoom.xos", DEFAULT_MEETING_APPS),
            Some("Zoom")
        );
        assert_eq!(
            match_meeting_app("com.microsoft.teams2", DEFAULT_MEETING_APPS),
            Some("Microsoft Teams")
        );
    }

    #[test]
    fn ignores_unknown_or_empty_bundle_id() {
        assert_eq!(
            match_meeting_app("com.apple.Safari", DEFAULT_MEETING_APPS),
            None
        );
        assert_eq!(match_meeting_app("", DEFAULT_MEETING_APPS), None);
    }
}
