//! macOS EventKit access. All Objective-C interop lives here; the rest of the
//! `calendar` module stays platform-free.
//!
//! Threading (see plan / swift-expert review): the authorization *request* is
//! fired on the main thread (it drives the TCC prompt, which needs the run
//! loop), its completion handler runs on a background queue and only signals a
//! channel, and the caller never blocks the main thread on it. `events(matching:)`
//! is a synchronous, blocking call and runs on the (background) calling thread,
//! never marshaled onto main. The authorization *status* check is a cheap static
//! call with no threading requirement. A fresh `EKEventStore` is created per
//! call inside an autorelease pool, which keeps the data fresh (no stale
//! snapshot) and avoids any managed-state coupling.

use crate::calendar::matching::CalendarEventCandidate;
use crate::calendar::{CalendarAuthStatus, CalendarInfo, SourceKind};
use chrono::{DateTime, Utc};
use std::collections::HashSet;
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::calendar::matching::{Attendee, EventStatus, ParticipantStatus};
    use block2::RcBlock;
    use chrono::Duration;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::Bool;
    use objc2_event_kit::{
        EKAuthorizationStatus, EKCalendarType, EKEntityType, EKEvent, EKEventStatus, EKEventStore,
        EKParticipantStatus,
    };
    use objc2_foundation::{NSDate, NSError};
    use std::sync::mpsc::sync_channel;
    use std::time::Duration as StdDuration;

    /// Hosts we recognise as video-conferencing links.
    const CONF_HOSTS: [&str; 5] = [
        "zoom.us",
        "meet.google.com",
        "teams.microsoft.com",
        "webex.com",
        "whereby.com",
    ];

    fn map_auth(status: EKAuthorizationStatus) -> CalendarAuthStatus {
        if status.0 == EKAuthorizationStatus::FullAccess.0 {
            CalendarAuthStatus::Granted
        } else if status.0 == EKAuthorizationStatus::WriteOnly.0 {
            CalendarAuthStatus::WriteOnly
        } else if status.0 == EKAuthorizationStatus::Denied.0 {
            CalendarAuthStatus::Denied
        } else if status.0 == EKAuthorizationStatus::Restricted.0 {
            CalendarAuthStatus::Restricted
        } else {
            CalendarAuthStatus::NotDetermined
        }
    }

    pub fn authorization_status() -> CalendarAuthStatus {
        // Static, synchronous, thread-agnostic.
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        map_auth(status)
    }

    pub fn request_access<R: Runtime>(app: &AppHandle<R>) -> CalendarAuthStatus {
        let (tx, rx) = sync_channel::<bool>(1);

        // Fire the request on the main thread; never block main on the result.
        let dispatched = app.run_on_main_thread(move || {
            autoreleasepool(|_| {
                let store = unsafe { EKEventStore::new() };
                // Keep the store alive until the (async) completion fires by moving
                // a retained clone into the completion block.
                let store_keepalive = store.clone();
                let completion = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
                    let _keep = &store_keepalive;
                    let _ = tx.send(granted.as_bool());
                });
                unsafe {
                    store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&completion));
                }
                // `completion` is copied by the ObjC method, so dropping the
                // RcBlock here is safe.
            });
        });

        if dispatched.is_err() {
            return authorization_status();
        }

        // Block the (background) calling thread, not main, awaiting the prompt.
        let _ = rx.recv_timeout(StdDuration::from_secs(60));
        authorization_status()
    }

    fn nsdate_to_utc(date: &NSDate) -> Option<DateTime<Utc>> {
        let secs = date.timeIntervalSince1970();
        if !secs.is_finite() {
            return None;
        }
        let nanos = ((secs.fract().abs()) * 1_000_000_000.0) as u32;
        DateTime::from_timestamp(secs as i64, nanos)
    }

    fn map_event_status(s: EKEventStatus) -> EventStatus {
        match s.0 {
            1 => EventStatus::Confirmed,
            2 => EventStatus::Tentative,
            3 => EventStatus::Canceled,
            _ => EventStatus::None,
        }
    }

    fn map_participant_status(s: EKParticipantStatus) -> ParticipantStatus {
        match s.0 {
            1 => ParticipantStatus::Pending,
            2 => ParticipantStatus::Accepted,
            3 => ParticipantStatus::Declined,
            4 => ParticipantStatus::Tentative,
            _ => ParticipantStatus::Unknown,
        }
    }

    fn is_conf_url(s: &str) -> bool {
        CONF_HOSTS.iter().any(|h| s.contains(h))
    }

    /// Extract the first conferencing URL token from free text.
    fn find_conf_url(text: &str) -> Option<String> {
        text.split_whitespace()
            .find(|tok| {
                (tok.starts_with("http://") || tok.starts_with("https://")) && is_conf_url(tok)
            })
            .map(|tok| tok.trim_end_matches(['.', ',', ')', '>']).to_string())
    }

    fn resolve_conference_url(
        event: &EKEvent,
        location: Option<&str>,
        notes: Option<&str>,
    ) -> Option<String> {
        if let Some(url) = unsafe { event.URL() } {
            if let Some(abs) = url.absoluteString() {
                let s = abs.to_string();
                if is_conf_url(&s) {
                    return Some(s);
                }
            }
        }
        location
            .and_then(find_conf_url)
            .or_else(|| notes.and_then(find_conf_url))
    }

    fn candidate_from_event(
        event: &EKEvent,
        excluded_ids: &HashSet<String>,
    ) -> Option<CalendarEventCandidate> {
        let start_date = unsafe { event.startDate() };
        let end_date = unsafe { event.endDate() };
        let start = nsdate_to_utc(&start_date)?;
        let end = nsdate_to_utc(&end_date)?;
        let title = Some(unsafe { event.title() }.to_string());
        let is_all_day = unsafe { event.isAllDay() };
        let event_status = map_event_status(unsafe { event.status() });

        let mut attendees = Vec::new();
        let mut my_participation = None;
        let mut attendee_count = 0;
        if let Some(arr) = unsafe { event.attendees() } {
            let count = arr.count();
            attendee_count = count;
            for i in 0..count {
                let p = arr.objectAtIndex(i);
                let name = unsafe { p.name() }.map(|n| n.to_string());
                let status = map_participant_status(unsafe { p.participantStatus() });
                if unsafe { p.isCurrentUser() } {
                    my_participation = Some(status);
                }
                attendees.push(Attendee { name, status });
            }
        }

        let organizer = unsafe { event.organizer() };
        let i_am_organizer = organizer
            .as_ref()
            .map(|o| unsafe { o.isCurrentUser() })
            .unwrap_or(false);
        let organizer_name = organizer
            .as_ref()
            .and_then(|o| unsafe { o.name() })
            .map(|n| n.to_string());

        let (calendar_name, calendar_excluded) = match unsafe { event.calendar() } {
            Some(cal) => {
                let id = unsafe { cal.calendarIdentifier() }.to_string();
                let cal_title = unsafe { cal.title() }.to_string();
                let ty = unsafe { cal.r#type() };
                let noise =
                    ty.0 == EKCalendarType::Subscription.0 || ty.0 == EKCalendarType::Birthday.0;
                let excluded = noise || excluded_ids.contains(&id);
                (Some(cal_title), excluded)
            }
            None => (None, false),
        };

        let location = unsafe { event.location() }.map(|l| l.to_string());
        let notes = unsafe { event.notes() }.map(|n| n.to_string());
        let conference_url = resolve_conference_url(event, location.as_deref(), notes.as_deref());
        let identifier = unsafe { event.eventIdentifier() }.map(|s| s.to_string());
        // Cross-system UID for dedup against a Google-OAuth copy of the same
        // event (EventKit syncs Google over CalDAV, preserving the iCalUID).
        let ical_uid = unsafe { event.calendarItemExternalIdentifier() }.map(|s| s.to_string());

        Some(CalendarEventCandidate {
            identifier,
            title,
            start,
            end,
            is_all_day,
            event_status,
            my_participation,
            i_am_organizer,
            attendee_count,
            calendar_excluded,
            ical_uid,
            source: SourceKind::EventKit,
            account_id: "eventkit-local".to_string(),
            organizer_name,
            attendees,
            location,
            conference_url,
            notes,
            calendar_name,
        })
    }

    pub fn fetch_candidates(
        now: DateTime<Utc>,
        excluded_ids: &HashSet<String>,
    ) -> Vec<CalendarEventCandidate> {
        // Fetch window wider than the candidate-eligibility window so the
        // matcher's back-to-back tie-break has the neighbouring events.
        fetch_candidates_in(
            now - Duration::hours(2),
            now + Duration::hours(2),
            excluded_ids,
        )
    }

    pub fn fetch_candidates_in(
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        excluded_ids: &HashSet<String>,
    ) -> Vec<CalendarEventCandidate> {
        autoreleasepool(|_| {
            let store = unsafe { EKEventStore::new() };
            let start_date = NSDate::dateWithTimeIntervalSince1970(start.timestamp() as f64);
            let end_date = NSDate::dateWithTimeIntervalSince1970(end.timestamp() as f64);
            let predicate = unsafe {
                store.predicateForEventsWithStartDate_endDate_calendars(
                    &start_date,
                    &end_date,
                    None,
                )
            };
            let events = unsafe { store.eventsMatchingPredicate(&predicate) };
            let count = events.count();
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let event = events.objectAtIndex(i);
                if let Some(c) = candidate_from_event(&event, excluded_ids) {
                    out.push(c);
                }
            }
            out
        })
    }

    pub fn list_calendars(excluded_ids: &HashSet<String>) -> Vec<CalendarInfo> {
        autoreleasepool(|_| {
            let store = unsafe { EKEventStore::new() };
            let cals = unsafe { store.calendarsForEntityType(EKEntityType::Event) };
            let count = cals.count();
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let cal = cals.objectAtIndex(i);
                let id = unsafe { cal.calendarIdentifier() }.to_string();
                let title = unsafe { cal.title() }.to_string();
                let ty = unsafe { cal.r#type() };
                let noise =
                    ty.0 == EKCalendarType::Subscription.0 || ty.0 == EKCalendarType::Birthday.0;
                let _ = &excluded_ids; // user exclusions are applied in the frontend list state
                out.push(CalendarInfo {
                    id,
                    title,
                    excluded_by_default: noise,
                });
            }
            out
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn authorization_status() -> CalendarAuthStatus {
        CalendarAuthStatus::NotDetermined
    }

    pub fn request_access<R: Runtime>(_app: &AppHandle<R>) -> CalendarAuthStatus {
        CalendarAuthStatus::NotDetermined
    }

    pub fn fetch_candidates(
        _now: DateTime<Utc>,
        _excluded_ids: &HashSet<String>,
    ) -> Vec<CalendarEventCandidate> {
        Vec::new()
    }

    pub fn fetch_candidates_in(
        _start: DateTime<Utc>,
        _end: DateTime<Utc>,
        _excluded_ids: &HashSet<String>,
    ) -> Vec<CalendarEventCandidate> {
        Vec::new()
    }

    pub fn list_calendars(_excluded_ids: &HashSet<String>) -> Vec<CalendarInfo> {
        Vec::new()
    }
}

pub use imp::*;
