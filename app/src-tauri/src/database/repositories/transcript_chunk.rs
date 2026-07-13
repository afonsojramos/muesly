// src/database/repo/transcript_chunks.rs

use chrono::Utc;
use log::info as log_info;
use sqlx::SqlitePool;
pub struct TranscriptChunksRepository;

impl TranscriptChunksRepository {
    /// Saves the full transcript text and processing parameters.
    pub async fn save_transcript_data(
        pool: &SqlitePool,
        meeting_id: &str,
        text: &str,
        model: &str,
        model_name: &str,
        chunk_size: i32,
        overlap: i32,
    ) -> Result<(), sqlx::Error> {
        log_info!(
            "Saving transcript data to transcript_chunks for meeting_id: {}",
            meeting_id
        );
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO transcript_chunks (meeting_id, transcript_text, model, model_name, chunk_size, overlap, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(meeting_id) DO UPDATE SET
                transcript_text = excluded.transcript_text,
                model = excluded.model,
                model_name = excluded.model_name,
                chunk_size = excluded.chunk_size,
                overlap = excluded.overlap,
                created_at = excluded.created_at
            "#
        )
        .bind(meeting_id)
        .bind(text)
        .bind(model)
        .bind(model_name)
        .bind(chunk_size)
        .bind(overlap)
        .bind(now)
        .execute(pool)
        .await?;

        Ok(())
    }
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
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind("Test meeting")
        .bind(now)
        .bind(now)
        .execute(pool)
        .await
        .expect("insert meeting");
    }

    #[tokio::test]
    async fn save_transcript_data_inserts_row() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;

        TranscriptChunksRepository::save_transcript_data(
            &pool,
            "m1",
            "Hello world transcript",
            "whisper",
            "large-v3",
            512,
            50,
        )
        .await
        .expect("save");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_chunks WHERE meeting_id = ?")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn save_transcript_data_stores_correct_text_and_params() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;

        TranscriptChunksRepository::save_transcript_data(
            &pool,
            "m1",
            "Transcript text here",
            "whisper",
            "large-v3-turbo",
            1024,
            100,
        )
        .await
        .expect("save");

        let (text, model, model_name, chunk_size, overlap): (String, String, String, i64, i64) =
            sqlx::query_as(
                "SELECT transcript_text, model, model_name, chunk_size, overlap FROM transcript_chunks WHERE meeting_id = ?",
            )
            .bind("m1")
            .fetch_one(&pool)
            .await
            .expect("fetch");

        assert_eq!(text, "Transcript text here");
        assert_eq!(model, "whisper");
        assert_eq!(model_name, "large-v3-turbo");
        assert_eq!(chunk_size, 1024);
        assert_eq!(overlap, 100);
    }

    #[tokio::test]
    async fn save_transcript_data_upserts_on_conflict() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;

        // First insert.
        TranscriptChunksRepository::save_transcript_data(
            &pool,
            "m1",
            "Original transcript",
            "whisper",
            "large-v3",
            512,
            50,
        )
        .await
        .expect("first save");

        // Second save with the same meeting_id should overwrite, not error.
        TranscriptChunksRepository::save_transcript_data(
            &pool,
            "m1",
            "Updated transcript",
            "whisper",
            "medium",
            256,
            25,
        )
        .await
        .expect("second save");

        // Only one row should exist.
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcript_chunks WHERE meeting_id = ?")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 1, "upsert must not create a duplicate row");

        // The stored text should be the updated one.
        let text: String =
            sqlx::query_scalar("SELECT transcript_text FROM transcript_chunks WHERE meeting_id = ?")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .expect("fetch");
        assert_eq!(text, "Updated transcript");
    }

    #[tokio::test]
    async fn transcript_chunk_belongs_to_its_meeting() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_meeting(&pool, "m2").await;

        TranscriptChunksRepository::save_transcript_data(
            &pool, "m1", "For m1", "whisper", "large-v3", 512, 50,
        )
        .await
        .expect("save m1");
        TranscriptChunksRepository::save_transcript_data(
            &pool, "m2", "For m2", "whisper", "large-v3", 512, 50,
        )
        .await
        .expect("save m2");

        let text_m1: String =
            sqlx::query_scalar("SELECT transcript_text FROM transcript_chunks WHERE meeting_id = ?")
                .bind("m1")
                .fetch_one(&pool)
                .await
                .expect("fetch m1");
        let text_m2: String =
            sqlx::query_scalar("SELECT transcript_text FROM transcript_chunks WHERE meeting_id = ?")
                .bind("m2")
                .fetch_one(&pool)
                .await
                .expect("fetch m2");

        assert_eq!(text_m1, "For m1");
        assert_eq!(text_m2, "For m2");
    }
}
