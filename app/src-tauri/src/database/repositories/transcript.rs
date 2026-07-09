use crate::api::{TranscriptSearchResult, TranscriptSegment};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqlitePool};
use tracing::{error, info};
use uuid::Uuid;

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Load each transcript segment's id, audio time span, and source speaker
    /// (`"mic"`/`"system"`) for a meeting, ordered by start time. Segments without
    /// timing are skipped (they cannot be reconciled against speaker turns). The
    /// `speaker` lets diarization label only the `system` (remote) side.
    pub async fn segments_for_diarization(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<(String, f64, f64, Option<String>)>, SqlxError> {
        let rows: Vec<(String, Option<f64>, Option<f64>, Option<String>)> = sqlx::query_as(
            "SELECT id, audio_start_time, audio_end_time, speaker FROM transcripts \
             WHERE meeting_id = ? ORDER BY audio_start_time",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, start, end, speaker)| Some((id, start?, end?, speaker)))
            .collect())
    }

    /// Distinct diarized cluster indices present for a meeting (non-null
    /// `speaker_id`s), sorted. These are the "them"-side speakers to name.
    pub async fn distinct_speaker_ids(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<i64>, SqlxError> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT speaker_id FROM transcripts \
             WHERE meeting_id = ? AND speaker_id IS NOT NULL ORDER BY speaker_id",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Assign (or clear, with `None`) the diarized speaker cluster for a
    /// transcript segment.
    pub async fn set_segment_speaker_id(
        pool: &SqlitePool,
        transcript_id: &str,
        speaker_id: Option<i64>,
    ) -> Result<(), SqlxError> {
        sqlx::query("UPDATE transcripts SET speaker_id = ? WHERE id = ?")
            .bind(speaker_id)
            .bind(transcript_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    pub async fn save_transcript(
        pool: &SqlitePool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        // 1. Create the new meeting
        let result = sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&meeting_id)
        .bind(meeting_title)
        .bind(now)
        .bind(now)
        .bind(&folder_path)
        .execute(&mut *transaction)
        .await;

        if let Err(e) = result {
            error!("Failed to create meeting '{}': {}", meeting_title, e);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let result = sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(&segment.timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
            .bind(&segment.speaker)
            .execute(&mut *transaction)
            .await;

            if let Err(e) = result {
                error!(
                    "Failed to save transcript segment for meeting {}: {}",
                    meeting_id, e
                );
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }

    /// Searches for a query string within the transcripts.
    /// It returns a list of matching transcripts with context.
    pub async fn search_transcripts(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let search_query = format!("%{}%", query.to_lowercase());

        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, t.transcript, t.timestamp
             FROM meetings m
             JOIN transcripts t ON m.id = t.meeting_id
             WHERE LOWER(t.transcript) LIKE ? AND m.deleted_at IS NULL",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        let results = rows
            .into_iter()
            .map(|(id, title, transcript, timestamp)| {
                let match_context = Self::get_match_context(&transcript, query);
                TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                }
            })
            .collect();

        Ok(results)
    }

    /// Helper function to extract a snippet of text around the first match of a query.
    fn get_match_context(transcript: &str, query: &str) -> String {
        let transcript_lower = transcript.to_lowercase();
        let query_lower = query.to_lowercase();

        match transcript_lower.find(&query_lower) {
            Some(match_index) => {
                let start_index = match_index.saturating_sub(100);
                let end_index = (match_index + query.len() + 100).min(transcript.len());

                let mut context = String::new();
                if start_index > 0 {
                    context.push_str("...");
                }
                context.push_str(&transcript[start_index..end_index]);
                if end_index < transcript.len() {
                    context.push_str("...");
                }
                context
            }
            None => transcript.chars().take(200).collect(), // Fallback to the start of the transcript
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TranscriptSegment;
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

    fn make_segment(text: &str, timestamp: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: String::new(),
            text: text.to_string(),
            timestamp: timestamp.to_string(),
            audio_start_time: None,
            audio_end_time: None,
            duration: None,
            speaker: None,
        }
    }

    #[tokio::test]
    async fn save_transcript_creates_meeting_and_returns_id() {
        let pool = test_pool().await;
        let segments = vec![make_segment("Hello world", "00:00:01")];

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Test Meeting",
            &segments,
            None,
        )
        .await
        .expect("save");

        assert!(meeting_id.starts_with("meeting-"), "id should have meeting- prefix");

        // Verify the meeting row was actually inserted.
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn save_transcript_inserts_all_segments_with_correct_text() {
        let pool = test_pool().await;
        let segments = vec![
            make_segment("First segment", "00:00:01"),
            make_segment("Second segment", "00:00:05"),
            make_segment("Third segment", "00:00:10"),
        ];

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Multi-segment Meeting",
            &segments,
            None,
        )
        .await
        .expect("save");

        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY timestamp",
        )
        .bind(&meeting_id)
        .fetch_all(&pool)
        .await
        .expect("fetch");

        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], "First segment");
        assert_eq!(rows[1], "Second segment");
        assert_eq!(rows[2], "Third segment");
    }

    #[tokio::test]
    async fn save_transcript_empty_segments_creates_meeting_with_no_transcripts() {
        let pool = test_pool().await;

        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Empty Meeting", &[], None)
                .await
                .expect("save");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn save_transcript_stores_folder_path() {
        let pool = test_pool().await;

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Folder Meeting",
            &[],
            Some("work/engineering".to_string()),
        )
        .await
        .expect("save");

        let folder: Option<String> =
            sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
                .bind(&meeting_id)
                .fetch_optional(&pool)
                .await
                .expect("fetch")
                .flatten();
        assert_eq!(folder.as_deref(), Some("work/engineering"));
    }

    #[tokio::test]
    async fn search_transcripts_finds_matching_text() {
        let pool = test_pool().await;
        let segments = vec![
            make_segment("The deployment was successful", "00:00:01"),
            make_segment("We discussed the budget", "00:00:05"),
        ];
        TranscriptsRepository::save_transcript(&pool, "Sprint Review", &segments, None)
            .await
            .expect("save");

        let results = TranscriptsRepository::search_transcripts(&pool, "deployment")
            .await
            .expect("search");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Sprint Review");
        assert!(results[0].match_context.contains("deployment"));
    }

    #[tokio::test]
    async fn search_transcripts_empty_query_returns_empty() {
        let pool = test_pool().await;
        let results = TranscriptsRepository::search_transcripts(&pool, "   ")
            .await
            .expect("search");
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn search_transcripts_no_match_returns_empty() {
        let pool = test_pool().await;
        let segments = vec![make_segment("Hello world", "00:00:01")];
        TranscriptsRepository::save_transcript(&pool, "Meeting", &segments, None)
            .await
            .expect("save");

        let results = TranscriptsRepository::search_transcripts(&pool, "zzznomatch")
            .await
            .expect("search");
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn search_transcripts_is_case_insensitive() {
        let pool = test_pool().await;
        let segments = vec![make_segment("Kubernetes upgrade plan", "00:00:01")];
        TranscriptsRepository::save_transcript(&pool, "Infra sync", &segments, None)
            .await
            .expect("save");

        let results = TranscriptsRepository::search_transcripts(&pool, "KUBERNETES")
            .await
            .expect("search");
        assert_eq!(results.len(), 1);
    }

    #[tokio::test]
    async fn foreign_key_relationship_transcripts_belong_to_correct_meeting() {
        let pool = test_pool().await;

        let id_a = TranscriptsRepository::save_transcript(
            &pool,
            "Meeting A",
            &[make_segment("alpha", "00:00:01")],
            None,
        )
        .await
        .expect("save A");

        let id_b = TranscriptsRepository::save_transcript(
            &pool,
            "Meeting B",
            &[make_segment("beta", "00:00:01"), make_segment("gamma", "00:00:02")],
            None,
        )
        .await
        .expect("save B");

        let count_a: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
                .bind(&id_a)
                .fetch_one(&pool)
                .await
                .expect("count A");
        let count_b: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
                .bind(&id_b)
                .fetch_one(&pool)
                .await
                .expect("count B");

        assert_eq!(count_a, 1);
        assert_eq!(count_b, 2);
    }
}
