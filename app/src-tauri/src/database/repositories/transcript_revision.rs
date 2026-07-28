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

        // The snapshot preserves the transcript the meetings row currently
        // attributes, so capture that provenance for a later true restore.
        let (prov_provider, prov_model, prov_reason): (
            Option<String>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT transcription_provider, transcription_model, transcription_reason \
             FROM meetings WHERE id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(&mut **tx)
        .await?
        .unwrap_or_default();

        let revision_id = format!("transcript-revision-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO transcript_revisions \
             (id, meeting_id, reason, model, language, character_count, average_confidence, \
              transcription_provider, transcription_model, transcription_reason, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&revision_id)
        .bind(meeting_id)
        .bind(reason)
        .bind(model)
        .bind(language)
        .bind(character_count)
        .bind(average_confidence)
        .bind(&prov_provider)
        .bind(&prov_model)
        .bind(&prov_reason)
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
        let target: Option<(String, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT id, transcription_provider, transcription_model, transcription_reason \
                 FROM transcript_revisions WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .bind(meeting_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((target, prov_provider, prov_model, prov_reason)) = target else {
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
            .bind(&target)
            .execute(&mut *tx)
            .await?;
        // Restore the provenance the snapshot captured (NULL for revisions
        // from before it was tracked, which stays the honest "unknown").
        sqlx::query(
            "UPDATE meetings SET transcription_provider = ?, transcription_model = ?, \
             transcription_reason = ? WHERE id = ?",
        )
        .bind(prov_provider)
        .bind(prov_model)
        .bind(prov_reason)
        .bind(meeting_id)
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

        assert!(
            TranscriptRevisionRepository::restore_latest(&pool, "m1")
                .await
                .unwrap()
        );
        let text: String =
            sqlx::query_scalar("SELECT transcript FROM transcripts WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(text, "original");

        assert!(
            TranscriptRevisionRepository::restore_latest(&pool, "m1")
                .await
                .unwrap()
        );
        let text: String =
            sqlx::query_scalar("SELECT transcript FROM transcripts WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(text, "refined");
    }

    #[tokio::test]
    async fn restore_brings_back_the_snapshotted_provenance() {
        let pool = test_pool().await;
        // Live transcription with small-q5_1.
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, transcription_provider, \
             transcription_model, transcription_reason) VALUES ('m1', 'Test', ?, ?, 'localWhisper', \
             'small-q5_1', 'Selected manually')",
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

        // A retranscription pass snapshots the live transcript, then replaces
        // both the segments and the meetings-row provenance.
        let mut tx = pool.begin().await.unwrap();
        TranscriptRevisionRepository::snapshot_current(
            &mut tx,
            "m1",
            "retranscription",
            Some("large-v3-turbo"),
            Some("en"),
            Some(0.9),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE transcripts SET transcript = 'refined' WHERE meeting_id = 'm1'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE meetings SET transcription_model = 'large-v3-turbo', \
             transcription_reason = 'Best quality' WHERE id = 'm1'",
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();

        // Undo restores both the original transcript and its true provenance.
        assert!(
            TranscriptRevisionRepository::restore_latest(&pool, "m1")
                .await
                .unwrap()
        );
        let (text, model, reason): (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT t.transcript, m.transcription_model, m.transcription_reason \
             FROM transcripts t JOIN meetings m ON m.id = t.meeting_id WHERE m.id = 'm1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(text, "original");
        assert_eq!(model.as_deref(), Some("small-q5_1"));
        assert_eq!(reason.as_deref(), Some("Selected manually"));

        // Undo again toggles back to the refined pass with its provenance.
        assert!(
            TranscriptRevisionRepository::restore_latest(&pool, "m1")
                .await
                .unwrap()
        );
        let (text, model): (String, Option<String>) = sqlx::query_as(
            "SELECT t.transcript, m.transcription_model \
             FROM transcripts t JOIN meetings m ON m.id = t.meeting_id WHERE m.id = 'm1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(text, "refined");
        assert_eq!(model.as_deref(), Some("large-v3-turbo"));
    }

    #[tokio::test]
    async fn restore_without_captured_provenance_stays_unknown() {
        let pool = test_pool().await;
        // Meeting with no provenance (e.g. recorded before it was tracked):
        // the snapshot captures NULLs and undo must not invent attribution.
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
        TranscriptRevisionRepository::snapshot_current(&mut tx, "m1", "test", None, None, None)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert!(
            TranscriptRevisionRepository::restore_latest(&pool, "m1")
                .await
                .unwrap()
        );
        let model: Option<String> =
            sqlx::query_scalar("SELECT transcription_model FROM meetings WHERE id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(model, None);
    }
}
