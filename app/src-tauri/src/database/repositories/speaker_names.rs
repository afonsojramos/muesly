//! Per-meeting names for diarized speaker clusters.
//!
//! A diarized `speaker_id` is an anonymous cluster index. This table records the
//! name the user assigned to a cluster (a calendar attendee, or free text),
//! scoped to a single meeting. It is cleared and recomputed on re-diarization
//! because cluster numbering is not stable across runs.

use crate::database::models::SpeakerName;
use sqlx::SqlitePool;

pub struct SpeakerNamesRepository;

impl SpeakerNamesRepository {
    /// Every assigned name for a meeting, ordered by cluster index.
    pub async fn get_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<SpeakerName>, sqlx::Error> {
        sqlx::query_as::<_, SpeakerName>(
            "SELECT meeting_id, speaker_id, name FROM speaker_names \
             WHERE meeting_id = ? ORDER BY speaker_id",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
    }

    /// Assign (or rename) the name for a cluster within a meeting. Generic over
    /// the executor so it can run standalone or inside a transaction.
    pub async fn upsert<'e, E>(
        executor: E,
        meeting_id: &str,
        speaker_id: i64,
        name: &str,
    ) -> Result<(), sqlx::Error>
    where
        E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
    {
        sqlx::query(
            "INSERT INTO speaker_names (meeting_id, speaker_id, name) VALUES (?, ?, ?) \
             ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET name = excluded.name",
        )
        .bind(meeting_id)
        .bind(speaker_id)
        .bind(name)
        .execute(executor)
        .await?;
        Ok(())
    }

    /// Drop every name for a meeting (used before a fresh diarization run).
    /// Generic over the executor so it can run inside a transaction.
    pub async fn clear_for_meeting<'e, E>(executor: E, meeting_id: &str) -> Result<(), sqlx::Error>
    where
        E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
    {
        sqlx::query("DELETE FROM speaker_names WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(executor)
            .await?;
        Ok(())
    }

    /// Remove the assigned name for a single speaker, reverting it to "Speaker N".
    pub async fn clear_one<'e, E>(
        executor: E,
        meeting_id: &str,
        speaker_id: i64,
    ) -> Result<(), sqlx::Error>
    where
        E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
    {
        sqlx::query("DELETE FROM speaker_names WHERE meeting_id = ? AND speaker_id = ?")
            .bind(meeting_id)
            .bind(speaker_id)
            .execute(executor)
            .await?;
        Ok(())
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
        // Foreign keys are off by default in SQLite; enable so the CASCADE test is real.
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .expect("enable foreign keys");
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
    async fn upsert_then_get_returns_the_name() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        SpeakerNamesRepository::upsert(&pool, "meeting-1", 0, "Ana")
            .await
            .expect("upsert");

        let names = SpeakerNamesRepository::get_for_meeting(&pool, "meeting-1")
            .await
            .expect("get");
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].speaker_id, 0);
        assert_eq!(names[0].name, "Ana");
    }

    #[tokio::test]
    async fn upsert_overwrites_rather_than_duplicates() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        SpeakerNamesRepository::upsert(&pool, "meeting-1", 1, "Speaker")
            .await
            .expect("first");
        SpeakerNamesRepository::upsert(&pool, "meeting-1", 1, "Bruno")
            .await
            .expect("second");

        let names = SpeakerNamesRepository::get_for_meeting(&pool, "meeting-1")
            .await
            .expect("get");
        assert_eq!(names.len(), 1);
        assert_eq!(names[0].name, "Bruno");
    }

    #[tokio::test]
    async fn names_are_scoped_to_the_meeting() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-a").await;
        insert_meeting(&pool, "meeting-b").await;

        SpeakerNamesRepository::upsert(&pool, "meeting-a", 0, "Ana")
            .await
            .expect("a");

        let b = SpeakerNamesRepository::get_for_meeting(&pool, "meeting-b")
            .await
            .expect("get b");
        assert!(
            b.is_empty(),
            "a name in meeting-a must not leak into meeting-b"
        );
    }

    #[tokio::test]
    async fn clear_removes_only_that_meetings_names() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-a").await;
        insert_meeting(&pool, "meeting-b").await;
        SpeakerNamesRepository::upsert(&pool, "meeting-a", 0, "Ana")
            .await
            .expect("a");
        SpeakerNamesRepository::upsert(&pool, "meeting-b", 0, "Bruno")
            .await
            .expect("b");

        SpeakerNamesRepository::clear_for_meeting(&pool, "meeting-a")
            .await
            .expect("clear");

        assert!(SpeakerNamesRepository::get_for_meeting(&pool, "meeting-a")
            .await
            .expect("get a")
            .is_empty());
        assert_eq!(
            SpeakerNamesRepository::get_for_meeting(&pool, "meeting-b")
                .await
                .expect("get b")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn deleting_the_meeting_cascades() {
        let pool = test_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        SpeakerNamesRepository::upsert(&pool, "meeting-1", 0, "Ana")
            .await
            .expect("upsert");

        sqlx::query("DELETE FROM meetings WHERE id = ?")
            .bind("meeting-1")
            .execute(&pool)
            .await
            .expect("delete meeting");

        assert!(SpeakerNamesRepository::get_for_meeting(&pool, "meeting-1")
            .await
            .expect("get")
            .is_empty());
    }
}
