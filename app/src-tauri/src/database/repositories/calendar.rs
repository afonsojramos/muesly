use crate::database::models::CalendarEvent;
use sqlx::SqlitePool;
use tracing::info as log_info;

pub struct CalendarEventsRepository;

impl CalendarEventsRepository {
    /// Fetch the calendar snapshot for a meeting, if one was attached.
    pub async fn get(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<CalendarEvent>, sqlx::Error> {
        sqlx::query_as::<_, CalendarEvent>("SELECT * FROM calendar_events WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
    }

    /// Insert or replace the calendar snapshot for a meeting. Returns `false` if
    /// the meeting does not exist (the meetings row is written by the frontend
    /// after a recording stops, so the snapshot is only persisted once it does).
    pub async fn upsert(pool: &SqlitePool, event: &CalendarEvent) -> Result<bool, sqlx::Error> {
        let mut transaction = pool.begin().await?;

        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = ?")
            .bind(&event.meeting_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();

        if !meeting_exists {
            log_info!(
                "Attempted to attach calendar event to a non-existent meeting_id: {}",
                event.meeting_id
            );
            transaction.rollback().await?;
            return Ok(false);
        }

        sqlx::query(
            r#"
            INSERT INTO calendar_events (
                meeting_id, event_identifier, occurrence_start, title,
                start_time, end_time, organizer_name, attendees_json,
                location, conference_url, notes, calendar_name,
                source, account_id, ical_uid, match_confidence, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(meeting_id) DO UPDATE SET
                event_identifier = excluded.event_identifier,
                occurrence_start = excluded.occurrence_start,
                title = excluded.title,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                organizer_name = excluded.organizer_name,
                attendees_json = excluded.attendees_json,
                location = excluded.location,
                conference_url = excluded.conference_url,
                notes = excluded.notes,
                calendar_name = excluded.calendar_name,
                source = excluded.source,
                account_id = excluded.account_id,
                ical_uid = excluded.ical_uid,
                match_confidence = excluded.match_confidence
            "#,
        )
        .bind(&event.meeting_id)
        .bind(&event.event_identifier)
        .bind(&event.occurrence_start)
        .bind(&event.title)
        .bind(&event.start_time)
        .bind(&event.end_time)
        .bind(&event.organizer_name)
        .bind(&event.attendees_json)
        .bind(&event.location)
        .bind(&event.conference_url)
        .bind(&event.notes)
        .bind(&event.calendar_name)
        .bind(&event.source)
        .bind(&event.account_id)
        .bind(&event.ical_uid)
        .bind(&event.match_confidence)
        .bind(event.created_at)
        .execute(&mut *transaction)
        .await?;

        transaction.commit().await?;
        log_info!(
            "Attached calendar event to meeting_id: {} (confidence: {})",
            event.meeting_id,
            event.match_confidence
        );
        Ok(true)
    }

    /// Detach (delete) the calendar snapshot for a single meeting.
    pub async fn delete(pool: &SqlitePool, meeting_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM calendar_events WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Delete every stored calendar snapshot, independent of recordings. Used
    /// when the user disables calendar context and wants the gathered
    /// third-party data removed. Returns the number of rows deleted.
    pub async fn purge_all(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("DELETE FROM calendar_events")
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Single-connection in-memory pool with all real migrations applied. No mocking.
    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn insert_meeting(pool: &SqlitePool, id: &str) {
        let now = Utc::now();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind("Test meeting")
            .bind(now)
            .bind(now)
            .execute(pool)
            .await
            .expect("insert meeting");
    }

    fn sample_event(meeting_id: &str) -> CalendarEvent {
        CalendarEvent {
            meeting_id: meeting_id.to_string(),
            event_identifier: Some("EV-123".to_string()),
            occurrence_start: Some("2026-06-28T15:00:00Z".to_string()),
            title: Some("Q3 Roadmap".to_string()),
            start_time: Some("2026-06-28T15:00:00Z".to_string()),
            end_time: Some("2026-06-28T16:00:00Z".to_string()),
            organizer_name: Some("Ana".to_string()),
            attendees_json: Some(r#"[{"name":"Ana","status":"accepted"}]"#.to_string()),
            location: Some("Room 4".to_string()),
            conference_url: Some("https://meet.google.com/abc".to_string()),
            notes: Some("Agenda: roadmap".to_string()),
            calendar_name: Some("Work".to_string()),
            source: "eventkit".to_string(),
            account_id: Some("eventkit-local".to_string()),
            ical_uid: Some("UID-1".to_string()),
            match_confidence: "high".to_string(),
            created_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let pool = test_pool().await;
        let event = CalendarEventsRepository::get(&pool, "missing")
            .await
            .expect("query");
        assert!(event.is_none());
    }

    #[tokio::test]
    async fn upsert_then_get_roundtrips() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        let ok = CalendarEventsRepository::upsert(&pool, &sample_event("meeting-1"))
            .await
            .expect("upsert");
        assert!(ok);

        let event = CalendarEventsRepository::get(&pool, "meeting-1")
            .await
            .expect("query")
            .expect("event present");
        assert_eq!(event.title.as_deref(), Some("Q3 Roadmap"));
        assert_eq!(event.match_confidence, "high");
        assert_eq!(event.source, "eventkit");
    }

    #[tokio::test]
    async fn upsert_overwrites_existing() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        CalendarEventsRepository::upsert(&pool, &sample_event("meeting-1"))
            .await
            .expect("first upsert");

        let mut updated = sample_event("meeting-1");
        updated.title = Some("Renamed".to_string());
        updated.match_confidence = "manual".to_string();
        CalendarEventsRepository::upsert(&pool, &updated)
            .await
            .expect("second upsert");

        let event = CalendarEventsRepository::get(&pool, "meeting-1")
            .await
            .expect("query")
            .expect("event present");
        assert_eq!(event.title.as_deref(), Some("Renamed"));
        assert_eq!(event.match_confidence, "manual");
    }

    #[tokio::test]
    async fn upsert_missing_meeting_returns_false() {
        let pool = test_pool().await;
        let ok = CalendarEventsRepository::upsert(&pool, &sample_event("nope"))
            .await
            .expect("upsert");
        assert!(!ok);
        // Nothing was written.
        assert!(CalendarEventsRepository::get(&pool, "nope")
            .await
            .expect("query")
            .is_none());
    }

    #[tokio::test]
    async fn delete_removes_snapshot() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        CalendarEventsRepository::upsert(&pool, &sample_event("meeting-1"))
            .await
            .expect("upsert");

        CalendarEventsRepository::delete(&pool, "meeting-1")
            .await
            .expect("delete");

        assert!(CalendarEventsRepository::get(&pool, "meeting-1")
            .await
            .expect("query")
            .is_none());
    }

    #[tokio::test]
    async fn purge_all_clears_every_snapshot() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_meeting(&pool, "meeting-2").await;
        CalendarEventsRepository::upsert(&pool, &sample_event("meeting-1"))
            .await
            .expect("upsert 1");
        CalendarEventsRepository::upsert(&pool, &sample_event("meeting-2"))
            .await
            .expect("upsert 2");

        let deleted = CalendarEventsRepository::purge_all(&pool)
            .await
            .expect("purge");
        assert_eq!(deleted, 2);
        assert!(CalendarEventsRepository::get(&pool, "meeting-1")
            .await
            .expect("query")
            .is_none());
    }
}
