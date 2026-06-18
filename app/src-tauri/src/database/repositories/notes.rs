use crate::database::models::MeetingNotes;
use chrono::Utc;
use sqlx::SqlitePool;
use tracing::info as log_info;

pub struct MeetingNotesRepository;

impl MeetingNotesRepository {
    /// Fetch the user notes for a meeting, if any have been saved.
    pub async fn get_notes(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingNotes>, sqlx::Error> {
        sqlx::query_as::<_, MeetingNotes>("SELECT * FROM meeting_notes WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
    }

    /// Insert or replace the markdown notes for a meeting. Returns `false` if
    /// the meeting does not exist. Bumps `meetings.updated_at` in the same
    /// transaction so the note shows as recently touched, mirroring the summary
    /// repository.
    pub async fn upsert_notes(
        pool: &SqlitePool,
        meeting_id: &str,
        notes_markdown: &str,
    ) -> Result<bool, sqlx::Error> {
        let mut transaction = pool.begin().await?;

        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();

        if !meeting_exists {
            log_info!(
                "Attempted to save notes for a non-existent meeting_id: {}",
                meeting_id
            );
            transaction.rollback().await?;
            return Ok(false);
        }

        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO meeting_notes (meeting_id, notes_markdown, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(meeting_id) DO UPDATE SET
                notes_markdown = excluded.notes_markdown,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(meeting_id)
        .bind(notes_markdown)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;

        sqlx::query("UPDATE meetings SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;

        log_info!("Successfully saved notes for meeting_id: {}", meeting_id);
        Ok(true)
    }

    /// Insert or replace the per-meeting summary context (the prompt the user
    /// types to steer AI summary generation) on the meeting's notes row. Returns
    /// `false` if the meeting does not exist. Unlike `upsert_notes`, this does not
    /// bump `meetings.updated_at`: the context is a generation aid, not visible
    /// content, so editing it should not reorder the meeting list.
    pub async fn upsert_summary_context(
        pool: &SqlitePool,
        meeting_id: &str,
        summary_context: &str,
    ) -> Result<bool, sqlx::Error> {
        let mut transaction = pool.begin().await?;

        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();

        if !meeting_exists {
            log_info!(
                "Attempted to save summary context for a non-existent meeting_id: {}",
                meeting_id
            );
            transaction.rollback().await?;
            return Ok(false);
        }

        let now = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO meeting_notes (meeting_id, summary_context, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(meeting_id) DO UPDATE SET
                summary_context = excluded.summary_context,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(meeting_id)
        .bind(summary_context)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;

        transaction.commit().await?;

        log_info!(
            "Successfully saved summary context for meeting_id: {}",
            meeting_id
        );
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Single-connection in-memory pool so every query hits the same database,
    /// with all real migrations applied. No mocking.
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

    #[tokio::test]
    async fn get_notes_missing_returns_none() {
        let pool = test_pool().await;
        let notes = MeetingNotesRepository::get_notes(&pool, "missing")
            .await
            .expect("query");
        assert!(notes.is_none());
    }

    #[tokio::test]
    async fn upsert_inserts_then_get_returns_markdown() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        let ok = MeetingNotesRepository::upsert_notes(&pool, "meeting-1", "hello notes")
            .await
            .expect("upsert");
        assert!(ok);

        let notes = MeetingNotesRepository::get_notes(&pool, "meeting-1")
            .await
            .expect("query")
            .expect("notes present");
        assert_eq!(notes.notes_markdown.as_deref(), Some("hello notes"));
        assert!(notes.notes_json.is_none());
    }

    #[tokio::test]
    async fn upsert_overwrites_existing_markdown() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        MeetingNotesRepository::upsert_notes(&pool, "meeting-1", "first")
            .await
            .expect("first upsert");
        MeetingNotesRepository::upsert_notes(&pool, "meeting-1", "second")
            .await
            .expect("second upsert");

        let notes = MeetingNotesRepository::get_notes(&pool, "meeting-1")
            .await
            .expect("query")
            .expect("notes present");
        assert_eq!(notes.notes_markdown.as_deref(), Some("second"));
    }

    #[tokio::test]
    async fn upsert_missing_meeting_returns_false() {
        let pool = test_pool().await;
        let ok = MeetingNotesRepository::upsert_notes(&pool, "nope", "x")
            .await
            .expect("upsert");
        assert!(!ok);
    }

    #[tokio::test]
    async fn upsert_summary_context_persists_and_get_returns_it() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        let ok = MeetingNotesRepository::upsert_summary_context(
            &pool,
            "meeting-1",
            "Attendees: Ana, Bruno. Goal: agree on Q3 roadmap.",
        )
        .await
        .expect("upsert context");
        assert!(ok);

        let notes = MeetingNotesRepository::get_notes(&pool, "meeting-1")
            .await
            .expect("query")
            .expect("notes present");
        assert_eq!(
            notes.summary_context.as_deref(),
            Some("Attendees: Ana, Bruno. Goal: agree on Q3 roadmap.")
        );
        // Context lives on the same row but does not touch the markdown notes.
        assert!(notes.notes_markdown.is_none());
    }

    #[tokio::test]
    async fn upsert_summary_context_and_notes_coexist() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        MeetingNotesRepository::upsert_notes(&pool, "meeting-1", "my notes")
            .await
            .expect("upsert notes");
        MeetingNotesRepository::upsert_summary_context(&pool, "meeting-1", "my context")
            .await
            .expect("upsert context");

        let notes = MeetingNotesRepository::get_notes(&pool, "meeting-1")
            .await
            .expect("query")
            .expect("notes present");
        assert_eq!(notes.notes_markdown.as_deref(), Some("my notes"));
        assert_eq!(notes.summary_context.as_deref(), Some("my context"));
    }

    #[tokio::test]
    async fn upsert_summary_context_missing_meeting_returns_false() {
        let pool = test_pool().await;
        let ok = MeetingNotesRepository::upsert_summary_context(&pool, "nope", "x")
            .await
            .expect("upsert context");
        assert!(!ok);
    }
}
