use chrono::Utc;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

pub struct TranscriptRevisionRepository;

impl TranscriptRevisionRepository {
    /// Snapshot the active transcript inside the caller's transaction. Empty
    /// meetings do not create revisions.
    pub async fn snapshot_current(
        tx: &mut Transaction<'_, Sqlite>,
        meeting_id: &str,
        reason: &str,
        model: Option<&str>,
        language: Option<&str>,
        average_confidence: Option<f32>,
    ) -> Result<Option<String>, sqlx::Error> {
        let (segment_count, character_count): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(transcript)), 0) FROM transcripts WHERE meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_one(&mut **tx)
        .await?;
        if segment_count == 0 {
            return Ok(None);
        }

        let revision_id = format!("transcript-revision-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO transcript_revisions \
             (id, meeting_id, reason, model, language, character_count, average_confidence, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&revision_id)
        .bind(meeting_id)
        .bind(reason)
        .bind(model)
        .bind(language)
        .bind(character_count)
        .bind(average_confidence)
        .bind(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .execute(&mut **tx)
        .await?;

        sqlx::query(
            "INSERT INTO transcript_revision_segments \
             (revision_id, position, transcript_id, transcript, timestamp, summary, action_items, key_points, \
              audio_start_time, audio_end_time, duration, speaker, speaker_id) \
             SELECT ?, ROW_NUMBER() OVER (ORDER BY COALESCE(audio_start_time, 1e30), timestamp, id) - 1, \
                    id, transcript, timestamp, summary, action_items, key_points, audio_start_time, \
                    audio_end_time, duration, speaker, speaker_id \
             FROM transcripts WHERE meeting_id = ?",
        )
        .bind(&revision_id)
        .bind(meeting_id)
        .execute(&mut **tx)
        .await?;

        Ok(Some(revision_id))
    }

    /// Restore the newest snapshot and preserve the transcript being replaced,
    /// making undo itself reversible. The consumed target is removed so a
    /// second invocation toggles back to the transcript that was just active.
    pub async fn restore_latest(pool: &SqlitePool, meeting_id: &str) -> Result<bool, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let target: Option<String> = sqlx::query_scalar(
            "SELECT id FROM transcript_revisions WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(meeting_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(target) = target else {
            return Ok(false);
        };

        Self::snapshot_current(&mut tx, meeting_id, "undo_checkpoint", None, None, None).await?;

        sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO transcripts \
             (id, meeting_id, transcript, timestamp, summary, action_items, key_points, audio_start_time, \
              audio_end_time, duration, speaker, speaker_id) \
             SELECT transcript_id, ?, transcript, timestamp, summary, action_items, key_points, \
                    audio_start_time, audio_end_time, duration, speaker, speaker_id \
             FROM transcript_revision_segments WHERE revision_id = ? ORDER BY position",
        )
        .bind(meeting_id)
        .bind(&target)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM transcript_revisions WHERE id = ?")
            .bind(target)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn restore_is_reversible() {
        let pool = test_pool().await;
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at) VALUES ('m1', 'Test', ?, ?)",
        )
        .bind(Utc::now())
        .bind(Utc::now())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp) VALUES ('t1', 'm1', 'original', ?)",
        )
        .bind(Utc::now())
        .execute(&pool)
        .await
        .unwrap();

        let mut tx = pool.begin().await.unwrap();
        TranscriptRevisionRepository::snapshot_current(
            &mut tx,
            "m1",
            "test",
            Some("small"),
            Some("en"),
            Some(0.8),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE transcripts SET transcript = 'refined' WHERE meeting_id = 'm1'")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert!(TranscriptRevisionRepository::restore_latest(&pool, "m1")
            .await
            .unwrap());
        let text: String =
            sqlx::query_scalar("SELECT transcript FROM transcripts WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(text, "original");

        assert!(TranscriptRevisionRepository::restore_latest(&pool, "m1")
            .await
            .unwrap());
        let text: String =
            sqlx::query_scalar("SELECT transcript FROM transcripts WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(text, "refined");
    }
}
