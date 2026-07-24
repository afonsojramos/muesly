//! Vector storage for on-device semantic search.
//!
//! Chunks of transcript/summary text with their L2-normalized embeddings
//! (f32 little-endian BLOBs). Retrieval is a brute-force dot product over a
//! meeting-scoped or library-wide fetch — at personal scale (thousands of
//! chunks) this is milliseconds and needs no vector index. Rows are scoped by
//! `model_id`, so a model change invalidates old vectors by mismatch instead
//! of migration.

use chrono::Utc;
use sqlx::SqlitePool;

/// Target window size for chunking, in characters. Windows end on segment
/// boundaries, so real chunks run slightly over.
const CHUNK_TARGET_CHARS: usize = 1_200;
/// Snippet stored per chunk (the chunk head), used for search-result display.
const EXCERPT_CHARS: usize = 240;

/// One chunk of meeting text ready to embed.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub text: String,
    pub audio_start_time: Option<f64>,
}

/// One semantic search hit (already scored).
#[derive(Debug, Clone)]
pub struct SemanticHit {
    pub meeting_id: String,
    pub excerpt: String,
    pub audio_start_time: Option<f64>,
    pub score: f32,
}

/// Group consecutive transcript segments into ~CHUNK_TARGET_CHARS windows.
/// Each line carries its speaker label (mirroring the chat's transcript
/// formatting) and each chunk remembers the first segment's audio start so
/// hits can cite a moment. Pure for testability.
pub fn chunk_transcript(segments: &[(Option<String>, String, Option<f64>)]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_start: Option<f64> = None;
    for (speaker, text, start) in segments {
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let line = match speaker.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(speaker) => format!("{speaker}: {text}\n"),
            None => format!("{text}\n"),
        };
        if current.is_empty() {
            current_start = *start;
        }
        current.push_str(&line);
        if current.len() >= CHUNK_TARGET_CHARS {
            chunks.push(Chunk {
                text: std::mem::take(&mut current).trim_end().to_string(),
                audio_start_time: current_start,
            });
            current_start = None;
        }
    }
    if !current.trim().is_empty() {
        chunks.push(Chunk {
            text: current.trim_end().to_string(),
            audio_start_time: current_start,
        });
    }
    chunks
}

/// Split summary markdown into paragraph-bounded ~CHUNK_TARGET_CHARS windows.
/// Summaries carry no audio timestamps. Pure for testability.
pub fn chunk_summary(markdown: &str) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for paragraph in markdown.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        current.push_str(paragraph);
        current.push_str("\n\n");
        if current.len() >= CHUNK_TARGET_CHARS {
            chunks.push(Chunk {
                text: std::mem::take(&mut current).trim_end().to_string(),
                audio_start_time: None,
            });
        }
    }
    if !current.trim().is_empty() {
        chunks.push(Chunk {
            text: current.trim_end().to_string(),
            audio_start_time: None,
        });
    }
    chunks
}

fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        blob.extend_from_slice(&value.to_le_bytes());
    }
    blob
}

fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect()
}

fn excerpt_of(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= EXCERPT_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(EXCERPT_CHARS).collect();
    format!("{}…", head.trim_end())
}

pub struct MeetingEmbeddingsRepository;

impl MeetingEmbeddingsRepository {
    /// Replace one source's chunks for a meeting with freshly embedded ones.
    /// Transactional: readers never observe a half-indexed meeting.
    pub async fn replace_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
        source: &str,
        model_id: &str,
        chunks: &[Chunk],
        vectors: &[Vec<f32>],
    ) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM meeting_embeddings WHERE meeting_id = ? AND source = ?")
            .bind(meeting_id)
            .bind(source)
            .execute(&mut *tx)
            .await?;
        let now = Utc::now().to_rfc3339();
        for (index, (chunk, vector)) in chunks.iter().zip(vectors.iter()).enumerate() {
            sqlx::query(
                "INSERT INTO meeting_embeddings \
                 (id, meeting_id, source, chunk_index, excerpt, audio_start_time, model_id, \
                  vector, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(format!("emb-{}", uuid::Uuid::new_v4()))
            .bind(meeting_id)
            .bind(source)
            .bind(index as i64)
            .bind(excerpt_of(&chunk.text))
            .bind(chunk.audio_start_time)
            .bind(model_id)
            .bind(vector_to_blob(vector))
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }

    /// Meetings (non-trashed) lacking any current-model transcript chunks —
    /// the startup backfill work list, newest first.
    pub async fn meetings_missing_index(
        pool: &SqlitePool,
        model_id: &str,
        limit: i64,
    ) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT m.id FROM meetings m \
             WHERE m.deleted_at IS NULL \
               AND NOT EXISTS (\
                   SELECT 1 FROM meeting_embeddings e \
                   WHERE e.meeting_id = m.id AND e.model_id = ?) \
             ORDER BY m.created_at DESC LIMIT ?",
        )
        .bind(model_id)
        .bind(limit)
        .fetch_all(pool)
        .await
    }

    /// Brute-force cosine scan (vectors are pre-normalized, so dot product).
    /// Optionally folder-scoped; trashed meetings excluded; best chunk per
    /// meeting wins. Returns the top `limit` meetings by similarity.
    pub async fn scan(
        pool: &SqlitePool,
        model_id: &str,
        folder_id: Option<&str>,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<SemanticHit>, sqlx::Error> {
        let rows: Vec<(String, String, Option<f64>, Vec<u8>)> = match folder_id {
            Some(folder_id) => {
                sqlx::query_as(
                    "SELECT e.meeting_id, e.excerpt, e.audio_start_time, e.vector \
                     FROM meeting_embeddings e JOIN meetings m ON m.id = e.meeting_id \
                     WHERE e.model_id = ? AND m.deleted_at IS NULL AND m.folder_id = ?",
                )
                .bind(model_id)
                .bind(folder_id)
                .fetch_all(pool)
                .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT e.meeting_id, e.excerpt, e.audio_start_time, e.vector \
                     FROM meeting_embeddings e JOIN meetings m ON m.id = e.meeting_id \
                     WHERE e.model_id = ? AND m.deleted_at IS NULL",
                )
                .bind(model_id)
                .fetch_all(pool)
                .await?
            }
        };

        // Best chunk per meeting.
        let mut best: std::collections::HashMap<String, SemanticHit> = std::collections::HashMap::new();
        for (meeting_id, excerpt, audio_start_time, blob) in rows {
            let vector = blob_to_vector(&blob);
            if vector.len() != query_vector.len() {
                continue; // defensive: dims drift means a foreign model row
            }
            let score: f32 = vector
                .iter()
                .zip(query_vector.iter())
                .map(|(a, b)| a * b)
                .sum();
            let entry = best.entry(meeting_id.clone());
            match entry {
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    if score > slot.get().score {
                        slot.insert(SemanticHit {
                            meeting_id,
                            excerpt,
                            audio_start_time,
                            score,
                        });
                    }
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(SemanticHit {
                        meeting_id,
                        excerpt,
                        audio_start_time,
                        score,
                    });
                }
            }
        }
        let mut hits: Vec<SemanticHit> = best.into_values().collect();
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.meeting_id.cmp(&b.meeting_id))
        });
        hits.truncate(limit);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', \
             created_at TEXT NOT NULL DEFAULT 'x', deleted_at TEXT, folder_id TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE meeting_embeddings (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL \
             REFERENCES meetings(id) ON DELETE CASCADE, source TEXT NOT NULL, \
             chunk_index INTEGER NOT NULL, excerpt TEXT NOT NULL, audio_start_time REAL, \
             model_id TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (id, folder) in [("m1", Some("f1")), ("m2", None), ("m3", None)] {
            sqlx::query("INSERT INTO meetings (id, folder_id) VALUES (?, ?)")
                .bind(id)
                .bind(folder)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    fn seg(speaker: Option<&str>, text: &str, start: Option<f64>) -> (Option<String>, String, Option<f64>) {
        (speaker.map(str::to_string), text.to_string(), start)
    }

    #[test]
    fn transcript_chunks_carry_speakers_and_first_start_time() {
        let segments = vec![
            seg(Some("Maya"), "We should revisit pricing.", Some(12.0)),
            seg(None, "Agreed.", Some(19.0)),
        ];
        let chunks = chunk_transcript(&segments);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].text.contains("Maya: We should revisit pricing."));
        assert!(chunks[0].text.contains("Agreed."));
        assert_eq!(chunks[0].audio_start_time, Some(12.0));
    }

    #[test]
    fn transcript_chunks_split_on_target_size() {
        let long = "word ".repeat(200); // ~1000 chars per segment
        let segments = vec![
            seg(None, &long, Some(0.0)),
            seg(None, &long, Some(60.0)),
            seg(None, &long, Some(120.0)),
        ];
        let chunks = chunk_transcript(&segments);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].audio_start_time, Some(0.0));
        // Second chunk starts at the first segment that opened it, not 0.
        assert!(chunks[1].audio_start_time > Some(0.0));
    }

    #[test]
    fn empty_transcript_and_summary_produce_no_chunks() {
        assert!(chunk_transcript(&[]).is_empty());
        assert!(chunk_transcript(&[seg(None, "   ", None)]).is_empty());
        assert!(chunk_summary("\n\n  \n").is_empty());
    }

    #[test]
    fn summary_chunks_split_on_paragraphs() {
        let markdown = format!("{}\n\n{}", "a".repeat(1_300), "b".repeat(100));
        let chunks = chunk_summary(&markdown);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].audio_start_time.is_none());
    }

    #[test]
    fn vector_blob_roundtrips() {
        let vector = vec![0.25f32, -1.5, 3.75];
        assert_eq!(blob_to_vector(&vector_to_blob(&vector)), vector);
    }

    fn chunk(text: &str, start: Option<f64>) -> Chunk {
        Chunk {
            text: text.to_string(),
            audio_start_time: start,
        }
    }

    #[tokio::test]
    async fn scan_ranks_by_cosine_and_scopes() {
        let pool = test_pool().await;
        // m1 (folder f1) points along x; m2 along y; m3 diagonal-ish.
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m1",
            "transcript",
            "test-model",
            &[chunk("about pricing", Some(3.0))],
            &[vec![1.0, 0.0]],
        )
        .await
        .unwrap();
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m2",
            "transcript",
            "test-model",
            &[chunk("about hiring", None)],
            &[vec![0.0, 1.0]],
        )
        .await
        .unwrap();
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m3",
            "transcript",
            "test-model",
            &[chunk("mixed", None)],
            &[vec![0.7, 0.7]],
        )
        .await
        .unwrap();

        let hits = MeetingEmbeddingsRepository::scan(&pool, "test-model", None, &[1.0, 0.0], 10)
            .await
            .unwrap();
        assert_eq!(hits[0].meeting_id, "m1");
        assert_eq!(hits[0].excerpt, "about pricing");
        assert_eq!(hits[0].audio_start_time, Some(3.0));
        assert_eq!(hits[1].meeting_id, "m3");

        // Folder scope keeps only m1.
        let scoped =
            MeetingEmbeddingsRepository::scan(&pool, "test-model", Some("f1"), &[1.0, 0.0], 10)
                .await
                .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].meeting_id, "m1");

        // Foreign model rows are invisible.
        assert!(
            MeetingEmbeddingsRepository::scan(&pool, "other-model", None, &[1.0, 0.0], 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn replace_is_idempotent_and_source_scoped() {
        let pool = test_pool().await;
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m1",
            "transcript",
            "test-model",
            &[chunk("v1", None)],
            &[vec![1.0, 0.0]],
        )
        .await
        .unwrap();
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m1",
            "summary",
            "test-model",
            &[chunk("sum", None)],
            &[vec![0.0, 1.0]],
        )
        .await
        .unwrap();
        // Re-indexing transcripts replaces the transcript rows only.
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m1",
            "transcript",
            "test-model",
            &[chunk("v2", None)],
            &[vec![1.0, 0.0]],
        )
        .await
        .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meeting_embeddings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
        let excerpts: Vec<String> =
            sqlx::query_scalar("SELECT excerpt FROM meeting_embeddings ORDER BY source")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(excerpts, vec!["sum".to_string(), "v2".to_string()]);
    }

    #[tokio::test]
    async fn cascade_and_trash_and_backfill() {
        let pool = test_pool().await;
        MeetingEmbeddingsRepository::replace_for_meeting(
            &pool,
            "m1",
            "transcript",
            "test-model",
            &[chunk("x", None)],
            &[vec![1.0, 0.0]],
        )
        .await
        .unwrap();

        // m2/m3 lack current-model rows → backfill candidates.
        let missing =
            MeetingEmbeddingsRepository::meetings_missing_index(&pool, "test-model", 10)
                .await
                .unwrap();
        assert_eq!(missing.len(), 2);
        assert!(!missing.contains(&"m1".to_string()));

        // Trashed meetings are neither scanned nor backfilled.
        sqlx::query("UPDATE meetings SET deleted_at = 'now' WHERE id = 'm2'")
            .execute(&pool)
            .await
            .unwrap();
        let missing =
            MeetingEmbeddingsRepository::meetings_missing_index(&pool, "test-model", 10)
                .await
                .unwrap();
        assert_eq!(missing, vec!["m3".to_string()]);

        // Deleting the meeting cascades its vectors away.
        sqlx::query("DELETE FROM meetings WHERE id = 'm1'")
            .execute(&pool)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meeting_embeddings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn excerpts_are_capped() {
        let text = "x".repeat(1_000);
        let excerpt = excerpt_of(&text);
        assert!(excerpt.chars().count() <= EXCERPT_CHARS + 1);
        assert!(excerpt.ends_with('…'));
    }
}
