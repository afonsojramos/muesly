use crate::database::models::SummaryProcess;
use chrono::Utc;
use serde_json::Value;
use sqlx::SqlitePool;
use tracing::{error, info as log_info};

pub struct SummaryProcessesRepository;

impl SummaryProcessesRepository {
    /// Retrieves the current summary process state for a given meeting ID.
    pub async fn get_summary_data(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<SummaryProcess>, sqlx::Error> {
        sqlx::query_as::<_, SummaryProcess>("SELECT * FROM summary_processes WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
    }

    pub async fn update_meeting_summary(
        pool: &SqlitePool,
        meeting_id: &str,
        summary: &Value,
    ) -> Result<bool, sqlx::Error> {
        let mut transaction = pool.begin().await?;

        let meeting_exists: bool = sqlx::query("SELECT 1 FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();

        if !meeting_exists {
            log_info!(
                "Attempted to save summary for a non-existent meeting_id: {}",
                meeting_id
            );
            transaction.rollback().await?;
            return Ok(false);
        }

        let result_json = serde_json::to_string(summary);
        if result_json.is_err() {
            error!("Can't convert the json to string for saving to Database");
            transaction.rollback().await?;
            return Ok(false);
        }
        let now = Utc::now();

        sqlx::query("UPDATE summary_processes SET result = ?, updated_at = ? WHERE meeting_id = ?")
            .bind(&result_json.unwrap())
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        sqlx::query("UPDATE meetings SET updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;

        log_info!(
            "Successfully updated summary and timestamp for meeting_id: {}",
            meeting_id
        );
        Ok(true)
    }

    pub async fn get_summary_data_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Option<SummaryProcess>, sqlx::Error> {
        sqlx::query_as::<_, SummaryProcess>(
            "SELECT p.* FROM summary_processes p JOIN transcript_chunks t ON p.meeting_id = t.meeting_id WHERE p.meeting_id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
    }

    pub async fn create_or_reset_process(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        log_info!(
            "Creating or resetting summary process for meeting_id: {}",
            meeting_id
        );
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, start_time, result, error)
            VALUES (?, 'PENDING', ?, ?, ?, NULL, NULL)
            ON CONFLICT(meeting_id) DO UPDATE SET
                status = 'PENDING',
                updated_at = excluded.updated_at,
                start_time = excluded.start_time,
                result_backup = result,
                result_backup_timestamp = excluded.updated_at,
                result = result,
                error = NULL
            "#
        )
        .bind(meeting_id)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
        log_info!(
            "Backed up existing summary before regeneration for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_completed(
        pool: &SqlitePool,
        meeting_id: &str,
        result: Value, // Keep this as Value to handle both old and new formats if needed
        chunk_count: i64,
        processing_time: f64,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        let result_str = serde_json::to_string(&result)
            .map_err(|e| sqlx::Error::Protocol(format!("Failed to serialize result: {}", e)))?;

        sqlx::query(
            r#"
            UPDATE summary_processes
            SET status = 'completed', result = ?, updated_at = ?, end_time = ?, chunk_count = ?, processing_time = ?, error = NULL, result_backup = NULL, result_backup_timestamp = NULL
            WHERE meeting_id = ?
            "#
        )
        .bind(result_str)
        .bind(now)
        .bind(now)
        .bind(chunk_count)
        .bind(processing_time)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Summary completed and backup cleared for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_failed(
        pool: &SqlitePool,
        meeting_id: &str,
        error: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();

        // Restore from backup if it exists, otherwise keep current result
        sqlx::query(
            r#"
            UPDATE summary_processes
            SET
                status = 'failed',
                error = ?,
                updated_at = ?,
                end_time = ?,
                result = COALESCE(result_backup, result),
                result_backup = NULL,
                result_backup_timestamp = NULL
            WHERE meeting_id = ?
            "#,
        )
        .bind(error)
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Summary generation failed and backup restored for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }

    pub async fn update_process_cancelled(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();

        // Restore from backup if it exists, otherwise keep current result
        sqlx::query(
            r#"
            UPDATE summary_processes
            SET
                status = 'cancelled',
                updated_at = ?,
                end_time = ?,
                error = 'Generation was cancelled by user',
                result = COALESCE(result_backup, result),
                result_backup = NULL,
                result_backup_timestamp = NULL
            WHERE meeting_id = ?
            "#,
        )
        .bind(now)
        .bind(now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
        log_info!(
            "Marked summary process as cancelled and restored backup for meeting_id: {}",
            meeting_id
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;
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
    async fn create_or_reset_creates_pending_process() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;

        SummaryProcessesRepository::create_or_reset_process(&pool, "m1")
            .await
            .expect("create");

        let proc = SummaryProcessesRepository::get_summary_data(&pool, "m1")
            .await
            .expect("get")
            .expect("row should exist");
        assert_eq!(proc.meeting_id, "m1");
        assert_eq!(proc.status, "PENDING");
        assert!(proc.result.is_none());
    }

    #[tokio::test]
    async fn create_or_reset_resets_existing_process_to_pending() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;

        // Create it once, then mark completed so we can see it get reset.
        SummaryProcessesRepository::create_or_reset_process(&pool, "m1")
            .await
            .expect("create");
        SummaryProcessesRepository::update_process_completed(
            &pool,
            "m1",
            json!({"summary": "old summary"}),
            1,
            1.0,
        )
        .await
        .expect("complete");

        // Sanity: it's completed now.
        let before = SummaryProcessesRepository::get_summary_data(&pool, "m1")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(before.status, "completed");
        assert!(before.result.is_some());

        // Reset it.
        SummaryProcessesRepository::create_or_reset_process(&pool, "m1")
            .await
            .expect("reset");

        let after = SummaryProcessesRepository::get_summary_data(&pool, "m1")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(after.status, "PENDING");
        // result_backup should now hold the old result, and result stays as-is
        // (see the ON CONFLICT clause: result = result, result_backup = result).
        assert!(after.result_backup.is_some());
    }

    #[tokio::test]
    async fn update_meeting_summary_returns_false_for_missing_meeting() {
        let pool = test_pool().await;

        let updated = SummaryProcessesRepository::update_meeting_summary(
            &pool,
            "nonexistent",
            &json!({"summary": "hi"}),
        )
        .await
        .expect("call succeeds");
        assert!(!updated, "should return false when meeting does not exist");
    }

    #[tokio::test]
    async fn update_process_completed_sets_status_and_result() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        SummaryProcessesRepository::create_or_reset_process(&pool, "m1")
            .await
            .expect("create");

        let result_value = json!({"summary": "great meeting"});
        SummaryProcessesRepository::update_process_completed(
            &pool,
            "m1",
            result_value.clone(),
            3,
            2.5,
        )
        .await
        .expect("complete");

        let proc = SummaryProcessesRepository::get_summary_data(&pool, "m1")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(proc.status, "completed");
        assert_eq!(proc.chunk_count, 3);
        assert!(proc.result.is_some());
        let stored: serde_json::Value =
            serde_json::from_str(proc.result.as_ref().unwrap()).expect("valid json");
        assert_eq!(stored, result_value);
    }

    #[tokio::test]
    async fn update_process_failed_sets_status_and_error() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        SummaryProcessesRepository::create_or_reset_process(&pool, "m1")
            .await
            .expect("create");

        SummaryProcessesRepository::update_process_failed(&pool, "m1", "timeout")
            .await
            .expect("fail");

        let proc = SummaryProcessesRepository::get_summary_data(&pool, "m1")
            .await
            .expect("get")
            .expect("row");
        assert_eq!(proc.status, "failed");
        assert_eq!(proc.error.as_deref(), Some("timeout"));
    }

    #[tokio::test]
    async fn get_summary_data_returns_none_for_unknown_meeting() {
        let pool = test_pool().await;
        let result = SummaryProcessesRepository::get_summary_data(&pool, "no-such-meeting")
            .await
            .expect("query");
        assert!(result.is_none());
    }
}
