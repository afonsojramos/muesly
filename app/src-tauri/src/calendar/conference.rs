//! Allowlist for auto-opening a meeting's conference URL. A stored
//! `conference_url` originates in attacker-influenceable free text (an event's
//! location/notes), and auto-join opens it with no user click — so gate it to an
//! https URL whose host *is* (or is a subdomain of) a known conferencing provider,
//! anchored on the parsed host rather than a substring match. Without this,
//! `https://phish-zoom.us.evil.io/creds` would pass a `.contains("zoom.us")` test.

use url::Url;

/// Known conferencing hosts (suffix-anchored). Kept in sync with the EventKit
/// extractor's `CONF_HOSTS`.
const CONF_HOSTS: [&str; 5] = [
    "zoom.us",
    "meet.google.com",
    "teams.microsoft.com",
    "webex.com",
    "whereby.com",
];

/// Whether `raw` is safe to auto-open: a valid https URL whose host equals, or is
/// a subdomain of, an allowlisted conferencing host.
pub fn is_allowed_conference_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    CONF_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_hosts_and_subdomains() {
        assert!(is_allowed_conference_url("https://zoom.us/j/123?pwd=x"));
        assert!(is_allowed_conference_url("https://acme.zoom.us/j/123"));
        assert!(is_allowed_conference_url(
            "https://meet.google.com/abc-defg-hij"
        ));
        assert!(is_allowed_conference_url(
            "https://teams.microsoft.com/l/meetup-join/x"
        ));
    }

    #[test]
    fn rejects_lookalikes_and_non_https() {
        // A substring host check would wrongly accept these.
        assert!(!is_allowed_conference_url(
            "https://phish-zoom.us.evil.io/creds"
        ));
        assert!(!is_allowed_conference_url(
            "https://evil.com/meet.google.com"
        ));
        assert!(!is_allowed_conference_url("https://notzoom.us.com/j/1"));
        assert!(!is_allowed_conference_url("http://zoom.us/j/1"));
        assert!(!is_allowed_conference_url("not a url"));
    }
}
