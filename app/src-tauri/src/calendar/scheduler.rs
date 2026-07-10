//! Meeting-start scheduler: when a calendar meeting begins, auto-start recording
//! it, optionally open its conference link, and notify.
//!
//! In-process only. It fires while the app runs; macOS sleep suspends the loop
//! (it resumes late, and the freshness guard then retires long-past starts), and a
//! terminated app never fires — OS-level "fire while closed" scheduling is out of
//! scope. Fire-once is persisted in `scheduler_fired`, so a restart mid-meeting
//! doesn't re-fire. Spawned once at startup; it re-reads the enable flag each tick
//! so toggling it on after launch takes effect (and while off there is no fetch).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration as StdDuration, Instant};

use chrono::{DateTime, Duration, Utc};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::audio::recording_commands;
use crate::calendar::matching::{CalendarEventCandidate, ParticipantStatus};
use crate::calendar::{conference, dedup, matching, service};
use crate::database::repositories::setting::SettingsRepository;
use crate::notifications::commands::{show_recording_started_notification, NotificationManagerState};

/// How often the fire-check runs.
const TICK: StdDuration = StdDuration::from_secs(30);
/// How often calendar candidates are refetched into the cache (so the loop isn't a
/// per-tick network poll).
const REFETCH_AFTER: StdDuration = StdDuration::from_secs(300);
/// A started meeting only auto-fires within this window of its start, so a late
/// wake never acts on a long-past (but still "ongoing") meeting.
const MAX_STALE_MINUTES: i64 = 10;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Pure fire decision (unit-tested): the occurrence has started, hasn't ended, and
/// started recently enough to still be worth acting on.
pub fn should_fire(
    now: DateTime<Utc>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    max_stale: Duration,
) -> bool {
    now >= start && now < end && now <= start + max_stale
}

/// Claim the fire for an occurrence atomically. True exactly once per
/// `(uid, minute)`: the INSERT succeeds for the first caller and conflicts for the
/// rest, so no tick (or restart) can double-fire.
async fn claim_fire(pool: &sqlx::SqlitePool, ical_uid: &str, minute: i64) -> bool {
    match sqlx::query(
        "INSERT INTO scheduler_fired (ical_uid, occurrence_minute, fired_at) \
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(ical_uid)
    .bind(minute)
    .bind(Utc::now())
    .execute(pool)
    .await
    {
        Ok(r) => r.rows_affected() == 1,
        Err(e) => {
            // Safe direction (skip + retry next tick), but a persistent fault would
            // silently disable all firing, so surface it.
            log::warn!("scheduler claim_fire failed: {e}");
            false
        }
    }
}

/// Drop a fire claim so a later tick can retry. Used when auto-start fails
/// transiently (model still downloading, mic busy) so the occurrence is not
/// permanently skipped within `MAX_STALE_MINUTES`.
async fn unclaim_fire(pool: &sqlx::SqlitePool, ical_uid: &str, minute: i64) {
    if let Err(e) = sqlx::query(
        "DELETE FROM scheduler_fired WHERE ical_uid = ? AND occurrence_minute = ?",
    )
    .bind(ical_uid)
    .bind(minute)
    .execute(pool)
    .await
    {
        log::warn!("scheduler unclaim_fire failed: {e}");
    }
}

/// Pure helper for tests: whether a failed start should release the fire claim.
/// Capture-already-active is a permanent claim (we intentionally skip); hard
/// start failure is not.
pub fn should_unclaim_on_start_failure(start_failed: bool, capture_already_active: bool) -> bool {
    start_failed && !capture_already_active
}

/// Drop fire markers older than ~30 days so the table doesn't grow unbounded.
async fn prune_old_fired(pool: &sqlx::SqlitePool) {
    let cutoff = Utc::now() - Duration::days(30);
    let _ = sqlx::query("DELETE FROM scheduler_fired WHERE fired_at < ?")
        .bind(cutoff)
        .execute(pool)
        .await;
}

/// Host only, for redacted logging (a conference URL can embed a passcode).
fn host_of(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
}

pub fn spawn_meeting_scheduler<R: Runtime>(app: AppHandle<R>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            prune_old_fired(state.db_manager.pool()).await;
        }
        let mut cache: Vec<CalendarEventCandidate> = Vec::new();
        let mut last_fetch: Option<Instant> = None;
        loop {
            tokio::time::sleep(TICK).await;

            let pool = match app.try_state::<crate::state::AppState>() {
                Some(state) => state.db_manager.pool().clone(),
                None => continue,
            };

            // Feature off → no fetch, negligible idle cost.
            if !SettingsRepository::get_auto_start_on_event(&pool)
                .await
                .unwrap_or(false)
            {
                continue;
            }

            let now = Utc::now();
            if last_fetch.map_or(true, |t| t.elapsed() >= REFETCH_AFTER) {
                cache = service::fetch_all_candidates(&pool, now).await;
                last_fetch = Some(Instant::now());
            }
            let auto_join = SettingsRepository::get_auto_join_meeting(&pool)
                .await
                .unwrap_or(false);
            let max_stale = Duration::minutes(MAX_STALE_MINUTES);

            for c in &cache {
                // Only real, eligible meetings (drops all-day/declined/canceled/
                // excluded and solo blocks) that have just begun.
                if !matching::is_eligible(c, now) || c.attendee_count == 0 {
                    continue;
                }
                // Only meetings the user actually accepted (or organizes) — never
                // auto-record a pending/tentative invite.
                let accepted = c.i_am_organizer
                    || matches!(c.my_participation, Some(ParticipantStatus::Accepted));
                if !accepted {
                    continue;
                }
                if !should_fire(now, c.start, c.end, max_stale) {
                    continue;
                }
                let Some(uid_raw) = c.ical_uid.as_deref() else {
                    continue; // un-keyable event: can't guarantee fire-once
                };
                let uid = dedup::norm_uid(uid_raw);
                let minute = dedup::minute_bucket(c.start);
                if !claim_fire(&pool, &uid, minute).await {
                    continue;
                }

                // If any capture is already live, don't start a second one (or open a
                // link for a meeting we aren't recording); the fire is still marked.
                if recording_commands::is_recording_active()
                    || recording_commands::is_dictation_active()
                {
                    continue;
                }

                let title = c.title.clone().unwrap_or_else(|| "Meeting".to_string());
                log::info!("Meeting scheduler firing for '{title}'");

                match recording_commands::start_recording_with_meeting_name(
                    app.clone(),
                    Some(title.clone()),
                )
                .await
                {
                    Ok(()) => {
                        let nstate = app.state::<NotificationManagerState<R>>();
                        let _ =
                            show_recording_started_notification(&app, &nstate, Some(title)).await;
                        // Pin the event so its pre-assigned folder is applied at save
                        // time even when calendar context is off (frontend consumes it).
                        let _ = app.emit(
                            "recording-folder-pin",
                            serde_json::json!({ "icalUid": uid, "occurrenceMinute": minute }),
                        );
                        // Auto-join only the meeting we actually started recording.
                        if auto_join {
                            if let Some(u) = c.conference_url.as_deref() {
                                if conference::is_allowed_conference_url(u)
                                    && open::that_detached(u).is_err()
                                {
                                    log::warn!(
                                        "scheduler auto-join failed for host {:?}",
                                        host_of(u)
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // Transient start failure (model loading, mic unavailable):
                        // release the claim so a later tick within MAX_STALE can retry.
                        log::warn!("scheduler auto-start failed: {e}");
                        if should_unclaim_on_start_failure(true, false) {
                            unclaim_fire(&pool, &uid, minute).await;
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 8, h, m, 0).unwrap()
    }

    #[test]
    fn fires_only_when_started_ongoing_and_fresh() {
        let (start, end, stale) = (at(10, 0), at(11, 0), Duration::minutes(10));
        assert!(!should_fire(at(9, 59), start, end, stale)); // not started
        assert!(should_fire(at(10, 0), start, end, stale)); // at start
        assert!(should_fire(at(10, 8), start, end, stale)); // just started
        assert!(!should_fire(at(10, 30), start, end, stale)); // ongoing but stale
        assert!(!should_fire(at(11, 1), start, end, stale)); // ended
    }

    #[test]
    fn unclaim_policy_for_start_failure() {
        // Hard start failure → release claim so a later tick can retry.
        assert!(should_unclaim_on_start_failure(true, false));
        // Capture already active: claim stays (intentional skip).
        assert!(!should_unclaim_on_start_failure(true, true));
        // Success: never unclaim.
        assert!(!should_unclaim_on_start_failure(false, false));
    }

    async fn test_pool() -> sqlx::SqlitePool {
        use sqlx::sqlite::SqlitePoolOptions;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE scheduler_fired (
                ical_uid TEXT NOT NULL,
                occurrence_minute INTEGER NOT NULL,
                fired_at TEXT NOT NULL,
                PRIMARY KEY (ical_uid, occurrence_minute)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn claim_fire_is_once_and_unclaim_allows_retry() {
        let pool = test_pool().await;
        assert!(claim_fire(&pool, "uid-1", 100).await);
        assert!(!claim_fire(&pool, "uid-1", 100).await, "second claim must fail");
        unclaim_fire(&pool, "uid-1", 100).await;
        assert!(
            claim_fire(&pool, "uid-1", 100).await,
            "after unclaim the occurrence can fire again"
        );
    }
}
