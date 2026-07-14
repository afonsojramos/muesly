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

    /// Distinct diarized cluster indices present on the `system` (remote) side of
    /// a meeting, sorted. These are the "them"-side speakers to name. Restricted
    /// to `system` so a legacy mic segment carrying a stale `speaker_id` can't
    /// surface as a phantom cluster.
    pub async fn distinct_speaker_ids(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<i64>, SqlxError> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT DISTINCT speaker_id FROM transcripts \
             WHERE meeting_id = ? AND speaker_id IS NOT NULL AND speaker = 'system' \
             ORDER BY speaker_id",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(|(id,)| id).collect())
    }

    /// Total speech seconds per `(speaker, speaker_id)` group for a meeting,
    /// with each group's first appearance time (drives the UI's "Speaker N"
    /// numbering). Aggregated in SQL so the result is complete regardless of how
    /// many transcript pages the frontend has loaded. Duration falls back to
    /// `end - start` when the stored duration is NULL or <= 0 (legacy chunk rows
    /// wrote 0.0 with zeroed times); groups with no usable signal are dropped.
    pub async fn talk_time_groups(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<(Option<String>, Option<i64>, f64, Option<f64>)>, SqlxError> {
        sqlx::query_as(
            "SELECT speaker, speaker_id, \
                    SUM(CASE \
                        WHEN duration IS NOT NULL AND duration > 0 THEN duration \
                        WHEN audio_start_time IS NOT NULL AND audio_end_time IS NOT NULL \
                             AND audio_end_time > audio_start_time \
                            THEN audio_end_time - audio_start_time \
                        ELSE 0 END) AS seconds, \
                    MIN(audio_start_time) AS first_start \
             FROM transcripts WHERE meeting_id = ? \
             GROUP BY speaker, speaker_id \
             HAVING seconds > 0 \
             ORDER BY first_start",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await
    }

    /// Assign (or clear, with `None`) the diarized speaker cluster for a
    /// transcript segment. Generic over the executor so it can run inside a
    /// transaction.
    pub async fn set_segment_speaker_id<'e, E>(
        executor: E,
        transcript_id: &str,
        speaker_id: Option<i64>,
    ) -> Result<(), SqlxError>
    where
        E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
    {
        sqlx::query("UPDATE transcripts SET speaker_id = ? WHERE id = ?")
            .bind(speaker_id)
            .bind(transcript_id)
            .execute(executor)
            .await?;
        Ok(())
    }

    /// Insert many transcript segments via multi-value INSERT batches.
    pub async fn bulk_insert_segments(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        meeting_id: &str,
        segments: &[TranscriptSegment],
    ) -> Result<(), SqlxError> {
        use sqlx::QueryBuilder;
        const BATCH: usize = 40;
        let mut i = 0;
        while i < segments.len() {
            let end = (i + BATCH).min(segments.len());
            let batch = &segments[i..end];
            let mut qb = QueryBuilder::new(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker) ",
            );
            qb.push_values(batch, |mut b, segment| {
                // Client segment IDs are session-local and can repeat after an
                // app restart or recovery. Database IDs must be globally unique.
                let transcript_id = format!("transcript-{}", Uuid::new_v4());
                b.push_bind(transcript_id)
                    .push_bind(meeting_id)
                    .push_bind(&segment.text)
                    .push_bind(&segment.timestamp)
                    .push_bind(segment.audio_start_time)
                    .push_bind(segment.audio_end_time)
                    .push_bind(segment.duration)
                    .push_bind(&segment.speaker);
            });
            qb.build().execute(&mut **tx).await?;
            i = end;
        }
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
        if !transcripts
            .iter()
            .any(|segment| !segment.text.trim().is_empty())
        {
            return Err(SqlxError::Protocol(
                "cannot create a meeting without transcript text".to_string(),
            ));
        }

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

        // 2. Bulk-insert segments in batches (fewer round-trips for long meetings).
        if let Err(e) = Self::bulk_insert_segments(&mut transaction, &meeting_id, transcripts).await
        {
            error!(
                "Failed to save transcript segments for meeting {}: {}",
                meeting_id, e
            );
            transaction.rollback().await?;
            return Err(e);
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
    /// Prefers FTS5 (`transcripts_fts`) when available; falls back to multi-token
    /// LIKE if FTS is missing or the MATCH fails.
    pub async fn search_transcripts(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        if let Some(match_q) = crate::database::fts::build_fts_match_query(query) {
            match Self::search_transcripts_fts(pool, &match_q).await {
                Ok(rows) if !rows.is_empty() => return Ok(rows),
                Ok(_) => {
                    // FTS ran but no hits — still try LIKE fallback for partials.
                }
                Err(e) => {
                    log::debug!("FTS search unavailable or failed ({e}); using LIKE fallback");
                }
            }
        }

        Self::search_transcripts_like(pool, query).await
    }

    /// FTS5 primary search path. The left-hand side of `MATCH` must be the bare
    /// virtual-table name (`transcripts_fts`), not a table alias — FTS5 rejects
    /// `WHERE f MATCH ?` with "no such column: f".
    async fn search_transcripts_fts(
        pool: &SqlitePool,
        match_q: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        // snippet() centers the context on the actual FTS hit (stemming- and
        // multi-token-aware); a literal re-scan of the query string would miss
        // stemmed matches. Column 0 is `transcript`, the vtable's only indexed
        // column; meeting_id / timestamp come from the external-content rowid join.
        // `snippet()` can't be used under GROUP BY (FTS5 restriction), so fetch the
        // best-ranked matches with headroom and cap to one row per meeting in Rust —
        // otherwise a single meeting with many hits could fill all 50 slots.
        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title,
                    snippet(transcripts_fts, 0, '', '', '...', 24),
                    t.timestamp
             FROM transcripts_fts
             JOIN transcripts t ON t.rowid = transcripts_fts.rowid
             JOIN meetings m ON m.id = t.meeting_id
             WHERE transcripts_fts MATCH ? AND m.deleted_at IS NULL
             ORDER BY rank
             LIMIT 500",
        )
        .bind(match_q)
        .fetch_all(pool)
        .await?;

        Ok(Self::dedupe_by_meeting(rows))
    }

    /// Keep only the first (best-ranked) hit per meeting, capped at 50 meetings, so
    /// one noisy meeting can't monopolize the results.
    fn dedupe_by_meeting(
        rows: Vec<(String, String, String, String)>,
    ) -> Vec<TranscriptSearchResult> {
        let mut seen = std::collections::HashSet::new();
        rows.into_iter()
            .filter(|(id, ..)| seen.insert(id.clone()))
            .take(50)
            .map(
                |(id, title, match_context, timestamp)| TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                },
            )
            .collect()
    }

    async fn search_transcripts_like(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        // Multi-word: OR across up to 4 tokens (NL-friendly). Bind params only.
        let mut tokens: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|w| w.len() >= 2)
            .take(4)
            .map(|w| format!("%{w}%"))
            .collect();
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        while tokens.len() < 4 {
            tokens.push("%\u{FFFF}%".to_string());
        }
        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, t.transcript, t.timestamp
             FROM meetings m
             JOIN transcripts t ON m.id = t.meeting_id
             WHERE m.deleted_at IS NULL AND (
               LOWER(t.transcript) LIKE ? OR LOWER(t.transcript) LIKE ?
               OR LOWER(t.transcript) LIKE ? OR LOWER(t.transcript) LIKE ?
             )
             LIMIT 500",
        )
        .bind(&tokens[0])
        .bind(&tokens[1])
        .bind(&tokens[2])
        .bind(&tokens[3])
        .fetch_all(pool)
        .await?;

        // One row per meeting (best-effort: first match wins), capped at 50, so a
        // single meeting with many matches can't crowd out the rest.
        let mut seen = std::collections::HashSet::new();
        Ok(rows
            .into_iter()
            .filter(|(id, ..)| seen.insert(id.clone()))
            .take(50)
            .map(
                |(id, title, transcript, timestamp)| TranscriptSearchResult {
                    id,
                    title,
                    match_context: Self::get_match_context(&transcript, query),
                    timestamp,
                },
            )
            .collect())
    }

    /// Extracts a snippet around the first literal match of a query. Used by the
    /// LIKE fallback only; the FTS path gets its context from FTS5 `snippet()`.
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
mod talk_time_tests {
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

    #[allow(clippy::too_many_arguments)]
    async fn insert_timed_segment(
        pool: &SqlitePool,
        meeting_id: &str,
        id: &str,
        speaker: Option<&str>,
        speaker_id: Option<i64>,
        start: Option<f64>,
        end: Option<f64>,
        duration: Option<f64>,
    ) {
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker, speaker_id) \
             VALUES (?, ?, 'text', '00:00:01', ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(meeting_id)
        .bind(start)
        .bind(end)
        .bind(duration)
        .bind(speaker)
        .bind(speaker_id)
        .execute(pool)
        .await
        .expect("insert segment");
    }

    #[tokio::test]
    async fn groups_by_speaker_and_cluster_with_first_start_order() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        // Cluster 1 appears first (at 0s), mic second (at 5s), cluster 0 third.
        insert_timed_segment(
            &pool,
            "m1",
            "s1",
            Some("system"),
            Some(1),
            Some(0.0),
            Some(4.0),
            Some(4.0),
        )
        .await;
        insert_timed_segment(
            &pool,
            "m1",
            "s2",
            Some("mic"),
            None,
            Some(5.0),
            Some(8.0),
            Some(3.0),
        )
        .await;
        insert_timed_segment(
            &pool,
            "m1",
            "s3",
            Some("system"),
            Some(0),
            Some(9.0),
            Some(10.0),
            Some(1.0),
        )
        .await;
        insert_timed_segment(
            &pool,
            "m1",
            "s4",
            Some("system"),
            Some(1),
            Some(11.0),
            Some(13.0),
            Some(2.0),
        )
        .await;

        let groups = TranscriptsRepository::talk_time_groups(&pool, "m1")
            .await
            .expect("aggregate");

        assert_eq!(groups.len(), 3);
        // Ordered by first appearance: cluster 1, mic, cluster 0.
        assert_eq!(groups[0].1, Some(1));
        assert!(
            (groups[0].2 - 6.0).abs() < 1e-9,
            "cluster 1 sums both segments"
        );
        assert_eq!(groups[1].0.as_deref(), Some("mic"));
        assert!((groups[1].2 - 3.0).abs() < 1e-9);
        assert_eq!(groups[2].1, Some(0));
        assert_eq!(groups[0].3, Some(0.0));
    }

    #[tokio::test]
    async fn duration_falls_back_to_span_and_zero_rows_drop_out() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        // NULL duration but valid span -> contributes end - start.
        insert_timed_segment(
            &pool,
            "m1",
            "s1",
            Some("mic"),
            None,
            Some(0.0),
            Some(2.5),
            None,
        )
        .await;
        // Legacy chunk row: duration 0.0 with zeroed times -> contributes nothing.
        insert_timed_segment(
            &pool,
            "m1",
            "s2",
            Some("system"),
            None,
            Some(0.0),
            Some(0.0),
            Some(0.0),
        )
        .await;
        // No timing at all -> excluded.
        insert_timed_segment(&pool, "m1", "s3", Some("system"), Some(4), None, None, None).await;

        let groups = TranscriptsRepository::talk_time_groups(&pool, "m1")
            .await
            .expect("aggregate");

        assert_eq!(groups.len(), 1, "only the mic group has usable signal");
        assert_eq!(groups[0].0.as_deref(), Some("mic"));
        assert!((groups[0].2 - 2.5).abs() < 1e-9);
    }

    #[tokio::test]
    async fn undiarized_system_speech_groups_under_null_cluster() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        insert_timed_segment(
            &pool,
            "m1",
            "s1",
            Some("system"),
            None,
            Some(0.0),
            Some(3.0),
            Some(3.0),
        )
        .await;

        let groups = TranscriptsRepository::talk_time_groups(&pool, "m1")
            .await
            .expect("aggregate");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0.as_deref(), Some("system"));
        assert_eq!(groups[0].1, None);
    }

    #[tokio::test]
    async fn empty_meeting_yields_no_groups() {
        let pool = test_pool().await;
        insert_meeting(&pool, "m1").await;
        let groups = TranscriptsRepository::talk_time_groups(&pool, "m1")
            .await
            .expect("aggregate");
        assert!(groups.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TranscriptSegment;
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

        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Test Meeting", &segments, None)
                .await
                .expect("save");

        assert!(
            meeting_id.starts_with("meeting-"),
            "id should have meeting- prefix"
        );

        // Verify the meeting row was actually inserted.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE id = ?")
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

        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Multi-segment Meeting", &segments, None)
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
    async fn save_transcript_without_text_does_not_create_meeting() {
        let pool = test_pool().await;
        let segments = vec![make_segment("   ", "00:00:01")];

        let result =
            TranscriptsRepository::save_transcript(&pool, "Empty Meeting", &segments, None).await;

        assert!(result.is_err());

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn save_transcript_accepts_reused_client_segment_ids() {
        let pool = test_pool().await;
        let mut segment = make_segment("Repeated client id", "00:00:01");
        segment.id = "seg_1".to_string();

        let first = TranscriptsRepository::save_transcript(
            &pool,
            "First recording",
            std::slice::from_ref(&segment),
            None,
        )
        .await
        .expect("save first recording");
        let second =
            TranscriptsRepository::save_transcript(&pool, "Second recording", &[segment], None)
                .await
                .expect("save second recording");

        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM transcripts WHERE meeting_id IN (?, ?) ORDER BY meeting_id",
        )
        .bind(first)
        .bind(second)
        .fetch_all(&pool)
        .await
        .expect("fetch ids");
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
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
    async fn search_transcripts_multi_word_hits_any_token() {
        let pool = test_pool().await;
        let segments = vec![
            make_segment("We locked the quarterly budget yesterday", "00:00:01"),
            make_segment("Launch date remains open", "00:00:05"),
        ];
        TranscriptsRepository::save_transcript(&pool, "Planning", &segments, None)
            .await
            .expect("save");

        // Multi-word: FTS OR path should hit when any significant token matches.
        let results = TranscriptsRepository::search_transcripts(&pool, "budget launch")
            .await
            .expect("search");
        assert!(
            !results.is_empty(),
            "expected multi-word FTS/LIKE hit for budget|launch"
        );
        assert!(
            results.iter().any(|r| r.title == "Planning"),
            "expected Planning meeting in multi-word results"
        );
    }

    /// Proves the indexed FTS path actually runs (not silently erroring into LIKE).
    /// A broken MATCH (e.g. alias `f MATCH ?`) would make this `Err`.
    #[tokio::test]
    async fn search_transcripts_fts_path_succeeds_without_error() {
        let pool = test_pool().await;
        let segments = vec![
            make_segment("The deployment was successful", "00:00:01"),
            make_segment("We discussed the budget", "00:00:05"),
        ];
        TranscriptsRepository::save_transcript(&pool, "Sprint Review", &segments, None)
            .await
            .expect("save");

        // Trigger backfill is automatic; FTS table must contain the row.
        let fts_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts_fts")
            .fetch_one(&pool)
            .await
            .expect("count fts");
        assert!(
            fts_count >= 2,
            "FTS index should be populated by triggers, got {fts_count}"
        );

        let match_q =
            crate::database::fts::build_fts_match_query("deployment budget").expect("match query");
        let fts_results = TranscriptsRepository::search_transcripts_fts(&pool, &match_q)
            .await
            .expect("FTS MATCH must succeed (invalid alias would error here)");
        assert!(
            !fts_results.is_empty(),
            "FTS primary path must return hits for multi-word OR query"
        );
        assert!(
            fts_results
                .iter()
                .any(|r| r.match_context.to_lowercase().contains("deployment")
                    || r.match_context.to_lowercase().contains("budget")),
            "FTS hit context should mention a query token"
        );

        // Public search must also succeed (FTS first, not error-fallback).
        let public = TranscriptsRepository::search_transcripts(&pool, "deployment budget")
            .await
            .expect("public search");
        assert!(!public.is_empty());
    }

    /// Stemmed matches (query "deployments" vs stored "deployment") must still
    /// return context centered on the hit — FTS5 snippet(), not a literal re-scan
    /// that would fall back to the transcript head.
    #[tokio::test]
    async fn search_transcripts_stemmed_match_context_centers_on_hit() {
        let pool = test_pool().await;
        let filler = "unrelated preamble sentence repeated over and over. ".repeat(10);
        let text = format!("{filler}the deployment finished ahead of schedule");
        TranscriptsRepository::save_transcript(
            &pool,
            "Release Sync",
            &[make_segment(&text, "00:00:01")],
            None,
        )
        .await
        .expect("save");

        let results = TranscriptsRepository::search_transcripts(&pool, "deployments")
            .await
            .expect("search");
        assert_eq!(
            results.len(),
            1,
            "porter stemming should match 'deployment'"
        );
        assert!(
            results[0].match_context.contains("deployment"),
            "context must center on the stemmed hit, not the transcript head: {}",
            results[0].match_context
        );
    }

    /// FTS MATCH with a table alias is invalid; this pins the working SQL shape.
    #[tokio::test]
    async fn fts_match_requires_bare_table_name() {
        let pool = test_pool().await;
        TranscriptsRepository::save_transcript(
            &pool,
            "Pin",
            &[make_segment("alpha bravo charlie", "00:00:01")],
            None,
        )
        .await
        .expect("save");

        // Broken shape (what we shipped by mistake): alias on MATCH LHS.
        let broken =
            sqlx::query("SELECT f.transcript FROM transcripts_fts f WHERE f MATCH 'alpha'")
                .fetch_all(&pool)
                .await;
        assert!(
            broken.is_err(),
            "alias MATCH must fail so we do not reintroduce it"
        );

        // Correct shape: bare virtual-table name on MATCH LHS.
        let ok: Vec<(String,)> = sqlx::query_as(
            "SELECT transcripts_fts.transcript
             FROM transcripts_fts
             WHERE transcripts_fts MATCH 'alpha'
             LIMIT 5",
        )
        .fetch_all(&pool)
        .await
        .expect("bare-table MATCH must succeed");
        assert_eq!(ok.len(), 1);
        assert!(ok[0].0.contains("alpha"));
    }

    #[tokio::test]
    async fn bulk_insert_segments_writes_all_rows() {
        let pool = test_pool().await;
        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Bulk",
            &[make_segment("seed", "00:00:00")],
            None,
        )
        .await
        .expect("seed meeting");
        // Wipe seed segment so we only count bulk rows.
        sqlx::query("DELETE FROM transcripts WHERE meeting_id = ?")
            .bind(&meeting_id)
            .execute(&pool)
            .await
            .expect("clear");

        let many: Vec<_> = (0..50)
            .map(|i| make_segment(&format!("segment number {i}"), &format!("00:00:{i:02}")))
            .collect();
        let mut tx = pool.begin().await.expect("begin");
        TranscriptsRepository::bulk_insert_segments(&mut tx, &meeting_id, &many)
            .await
            .expect("bulk");
        tx.commit().await.expect("commit");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 50);
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
            &[
                make_segment("beta", "00:00:01"),
                make_segment("gamma", "00:00:02"),
            ],
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
