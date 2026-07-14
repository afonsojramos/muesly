use crate::api::{MeetingDetails, MeetingTranscript};
use crate::database::models::{MeetingModel, Transcript};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqliteConnection, SqlitePool};
use tracing::{error, info};

pub struct MeetingsRepository;

impl MeetingsRepository {
    pub async fn get_meetings(
        pool: &SqlitePool,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Vec<MeetingModel>, sqlx::Error> {
        // Active meetings only; trashed ones (deleted_at set) live in the Trash view.
        // When limit is None the query is unbounded (current behavior).
        let meetings = match limit {
            Some(lim) => {
                sqlx::query_as::<_, MeetingModel>(
                    "SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?",
                )
                .bind(lim)
                .bind(offset.unwrap_or(0))
                .fetch_all(pool)
                .await?
            }
            None => {
                sqlx::query_as::<_, MeetingModel>(
                    "SELECT * FROM meetings WHERE deleted_at IS NULL ORDER BY created_at DESC",
                )
                .fetch_all(pool)
                .await?
            }
        };
        Ok(meetings)
    }

    /// Meetings currently in the trash, most-recently-deleted first.
    pub async fn get_trashed_meetings(pool: &SqlitePool) -> Result<Vec<MeetingModel>, sqlx::Error> {
        sqlx::query_as::<_, MeetingModel>(
            "SELECT id, title, created_at, updated_at, folder_path, folder_id FROM meetings \
             WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
        .fetch_all(pool)
        .await
    }

    /// Move a meeting to the trash (recoverable). Returns false if it doesn't
    /// exist or is already trashed.
    pub async fn soft_delete_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }
        let now = Utc::now();
        let result = sqlx::query(
            "UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Restore a trashed meeting back to the active list.
    pub async fn restore_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }
        let now = Utc::now();
        let result = sqlx::query(
            "UPDATE meetings SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
        )
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        match delete_meeting_with_transaction(&mut transaction, meeting_id).await {
            Ok(success) => {
                if success {
                    transaction.commit().await?;
                    info!(
                        "Successfully deleted meeting {} and all associated data",
                        meeting_id
                    );
                    Ok(true)
                } else {
                    transaction.rollback().await?;
                    Ok(false)
                }
            }
            Err(e) => {
                let _ = transaction.rollback().await;
                error!("Failed to delete meeting {}: {}", meeting_id, e);
                Err(e)
            }
        }
    }

    pub async fn get_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingDetails>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        // Get meeting details
        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path, folder_id FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(&mut *transaction)
                .await?;

        if meeting.is_none() {
            transaction.rollback().await?;
            return Err(SqlxError::RowNotFound);
        }

        if let Some(meeting) = meeting {
            // Get all transcripts for this meeting
            let transcripts =
                sqlx::query_as::<_, Transcript>(
                    "SELECT * FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time ASC, id ASC",
                )
                    .bind(meeting_id)
                    .fetch_all(&mut *transaction)
                    .await?;

            transaction.commit().await?;

            // Convert Transcript to MeetingTranscript
            let meeting_transcripts = transcripts
                .into_iter()
                .map(|t| MeetingTranscript {
                    id: t.id,
                    text: t.transcript,
                    timestamp: t.timestamp,
                    audio_start_time: t.audio_start_time,
                    audio_end_time: t.audio_end_time,
                    duration: t.duration,
                    speaker: t.speaker,
                    speaker_id: t.speaker_id,
                })
                .collect::<Vec<_>>();

            Ok(Some(MeetingDetails {
                id: meeting.id,
                title: meeting.title,
                created_at: meeting.created_at.0.to_rfc3339(),
                updated_at: meeting.updated_at.0.to_rfc3339(),
                transcripts: meeting_transcripts,
            }))
        } else {
            transaction.rollback().await?;
            Ok(None)
        }
    }

    /// Get meeting metadata without transcripts (for pagination)
    pub async fn get_meeting_metadata(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<MeetingModel>, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let meeting: Option<MeetingModel> =
            sqlx::query_as("SELECT id, title, created_at, updated_at, folder_path, folder_id FROM meetings WHERE id = ?")
                .bind(meeting_id)
                .fetch_optional(pool)
                .await?;

        Ok(meeting)
    }

    /// Get meeting transcripts with pagination support
    pub async fn get_meeting_transcripts_paginated(
        pool: &SqlitePool,
        meeting_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<Transcript>, i64), SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        // Get total count of transcripts for this meeting
        let total: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_one(pool)
            .await?;

        // Get paginated transcripts ordered by audio_start_time
        let transcripts = sqlx::query_as::<_, Transcript>(
            "SELECT * FROM transcripts
             WHERE meeting_id = ?
             ORDER BY audio_start_time ASC
             LIMIT ? OFFSET ?",
        )
        .bind(meeting_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

        Ok((transcripts, total.0))
    }

    pub async fn update_meeting_title(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        if meeting_id.trim().is_empty() {
            return Err(SqlxError::Protocol(
                "meeting_id cannot be empty".to_string(),
            ));
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now().naive_utc();

        let rows_affected =
            sqlx::query("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;
        if rows_affected.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        transaction.commit().await?;
        Ok(true)
    }

    pub async fn update_meeting_title_if_current(
        pool: &SqlitePool,
        meeting_id: &str,
        expected_title: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let now = Utc::now().naive_utc();
        let result =
            sqlx::query("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ? AND title = ?")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .bind(expected_title)
                .execute(pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn update_meeting_name(
        pool: &SqlitePool,
        meeting_id: &str,
        new_title: &str,
    ) -> Result<bool, SqlxError> {
        let mut transaction = pool.begin().await?;
        let now = Utc::now();

        // Update meetings table
        let meeting_update =
            sqlx::query("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
                .bind(new_title)
                .bind(now)
                .bind(meeting_id)
                .execute(&mut *transaction)
                .await?;

        if meeting_update.rows_affected() == 0 {
            transaction.rollback().await?;
            return Ok(false); // Meeting not found
        }

        // Update transcript_chunks table
        sqlx::query("UPDATE transcript_chunks SET meeting_name = ? WHERE meeting_id = ?")
            .bind(new_title)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(true)
    }
}

async fn delete_meeting_with_transaction(
    transaction: &mut SqliteConnection,
    meeting_id: &str,
) -> Result<bool, SqlxError> {
    // Check if meeting exists
    let meeting_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *transaction)
        .await?;

    if meeting_exists.is_none() {
        error!("Meeting {} not found for deletion", meeting_id);
        return Ok(false);
    }

    // Delete from related tables in proper order
    // 1. Delete from transcript_chunks
    sqlx::query("DELETE FROM transcript_chunks WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 2. Delete from summary_processes
    sqlx::query("DELETE FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 3. Delete from transcripts
    sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 3b. Delete from speaker_names. The table declares ON DELETE CASCADE and
    // the pool enforces foreign keys (pinned in manager.rs tests), but child
    // rows are still deleted explicitly like every other related table so the
    // cleanup never silently depends on connection pragmas.
    sqlx::query("DELETE FROM speaker_names WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 4. Delete from meeting_notes
    sqlx::query("DELETE FROM meeting_notes WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 5. Delete from calendar_events (snapshot may hold third-party PII)
    sqlx::query("DELETE FROM calendar_events WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    // 6. Finally, delete the meeting (hard delete — used by permanent trash removal)
    let result = sqlx::query("DELETE FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .execute(&mut *transaction)
        .await?;

    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use sqlx::sqlite::SqlitePoolOptions;

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
    async fn delete_meeting_removes_speaker_names() {
        use crate::database::repositories::speaker_names::SpeakerNamesRepository;
        let pool = test_pool().await;
        // Disable FK enforcement so this test proves the EXPLICIT delete in
        // delete_meeting_with_transaction works on its own, without the CASCADE
        // (which the pool otherwise enforces) masking a missing cleanup step.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable fk");
        insert_meeting(&pool, "m1").await;
        SpeakerNamesRepository::upsert(&pool, "m1", 0, "Ana")
            .await
            .expect("name");

        assert!(
            MeetingsRepository::delete_meeting(&pool, "m1")
                .await
                .unwrap()
        );

        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM speaker_names WHERE meeting_id = ?")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(
            remaining, 0,
            "speaker_names must be cleaned up on hard delete"
        );
    }

    #[tokio::test]
    async fn soft_delete_hides_from_active_and_shows_in_trash() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_meeting(&pool, "m2").await;

        assert_eq!(
            MeetingsRepository::get_meetings(&pool, None, None)
                .await
                .unwrap()
                .len(),
            2
        );

        assert!(
            MeetingsRepository::soft_delete_meeting(&pool, "m1")
                .await
                .unwrap()
        );

        let active = MeetingsRepository::get_meetings(&pool, None, None)
            .await
            .unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "m2");

        let trashed = MeetingsRepository::get_trashed_meetings(&pool)
            .await
            .unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].id, "m1");
    }

    #[tokio::test]
    async fn restore_returns_meeting_to_active() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        MeetingsRepository::soft_delete_meeting(&pool, "m1")
            .await
            .unwrap();

        assert!(
            MeetingsRepository::restore_meeting(&pool, "m1")
                .await
                .unwrap()
        );
        assert_eq!(
            MeetingsRepository::get_meetings(&pool, None, None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            MeetingsRepository::get_trashed_meetings(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn soft_delete_is_idempotent_and_restore_requires_trashed() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;

        assert!(
            MeetingsRepository::soft_delete_meeting(&pool, "m1")
                .await
                .unwrap()
        );
        // Already trashed → no rows affected.
        assert!(
            !MeetingsRepository::soft_delete_meeting(&pool, "m1")
                .await
                .unwrap()
        );
        // Restoring an active meeting → no rows affected.
        MeetingsRepository::restore_meeting(&pool, "m1")
            .await
            .unwrap();
        assert!(
            !MeetingsRepository::restore_meeting(&pool, "m1")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn hard_delete_removes_trashed_meeting() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        MeetingsRepository::soft_delete_meeting(&pool, "m1")
            .await
            .unwrap();

        assert!(
            MeetingsRepository::delete_meeting(&pool, "m1")
                .await
                .unwrap()
        );
        assert!(
            MeetingsRepository::get_trashed_meetings(&pool)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            MeetingsRepository::get_meetings(&pool, None, None)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn get_meetings_respects_limit_and_offset() {
        let pool = test_pool().await;
        // Insert 5 meetings; created_at order may collapse within the same millisecond,
        // so we force distinct timestamps via sequential inserts with explicit ids.
        for i in 1..=5u32 {
            let id = format!("m{}", i);
            let ts = chrono::Utc::now() + chrono::Duration::seconds(i as i64);
            sqlx::query(
                "INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(format!("Meeting {}", i))
            .bind(ts)
            .bind(ts)
            .execute(&pool)
            .await
            .expect("insert meeting");
        }

        // Unbounded: all 5 rows returned.
        let all = MeetingsRepository::get_meetings(&pool, None, None)
            .await
            .unwrap();
        assert_eq!(all.len(), 5);

        // First page: 2 rows, offset 0 (most recent first: m5, m4).
        let page1 = MeetingsRepository::get_meetings(&pool, Some(2), Some(0))
            .await
            .unwrap();
        assert_eq!(page1.len(), 2);
        assert_eq!(page1[0].id, "m5");
        assert_eq!(page1[1].id, "m4");

        // Second page: 2 rows, offset 2 (m3, m2).
        let page2 = MeetingsRepository::get_meetings(&pool, Some(2), Some(2))
            .await
            .unwrap();
        assert_eq!(page2.len(), 2);
        assert_eq!(page2[0].id, "m3");
        assert_eq!(page2[1].id, "m2");

        // Third page: 1 remaining row (m1).
        let page3 = MeetingsRepository::get_meetings(&pool, Some(2), Some(4))
            .await
            .unwrap();
        assert_eq!(page3.len(), 1);
        assert_eq!(page3[0].id, "m1");
    }
}
