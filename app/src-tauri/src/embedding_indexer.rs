//! Keeps the semantic-search index in step with meeting content.
//!
//! One entry point (`index_meeting`) chunks a meeting's transcript and summary,
//! embeds them, and transactionally replaces that meeting's vectors. Triggers
//! are all fire-and-forget spawns — indexing must never block recording,
//! transcription, or summarization — and every path is a clean no-op while the
//! embedding model is unavailable (the startup backfill retries after the
//! model's one-time download).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::SqlitePool;

use crate::database::repositories::meeting::MeetingsRepository;
use crate::database::repositories::meeting_embeddings::{
    MeetingEmbeddingsRepository, chunk_summary, chunk_transcript,
};
use crate::embedding_engine::{self, EMBEDDING_MODEL_ID};

/// Meetings indexed per backfill batch before yielding.
const BACKFILL_BATCH: i64 = 8;
/// Chunks embedded per ONNX run, bounding memory and per-call latency for
/// long meetings.
const EMBED_BATCH: usize = 16;
/// Pause between backfill batches so the sweep never saturates a busy app.
const BACKFILL_PAUSE: Duration = Duration::from_secs(2);
/// Delay before the startup backfill begins (let the app finish launching).
const STARTUP_DELAY: Duration = Duration::from_secs(30);

/// One sweep at a time; a second request while sweeping is a no-op because the
/// running sweep drains the same work list.
static SWEEP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Index (or re-index) one meeting's transcript and summary chunks.
/// No-op when the embedding model is unavailable.
pub async fn index_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<()> {
    if !embedding_engine::is_model_available() {
        return Ok(());
    }

    let details = MeetingsRepository::get_meeting(pool, meeting_id)
        .await
        .context("load meeting for embedding")?;
    let Some(details) = details else {
        return Ok(()); // deleted meanwhile; cascade owns cleanup
    };

    let segments: Vec<(Option<String>, String, Option<f64>)> = details
        .transcripts
        .iter()
        .map(|t| (t.speaker.clone(), t.text.clone(), t.audio_start_time))
        .collect();
    let transcript_chunks = chunk_transcript(&segments);
    if !transcript_chunks.is_empty() {
        let Some(vectors) = embed_chunks_batched(&transcript_chunks).await else {
            return Ok(()); // model vanished mid-run; next sweep retries
        };
        MeetingEmbeddingsRepository::replace_for_meeting(
            pool,
            meeting_id,
            "transcript",
            EMBEDDING_MODEL_ID,
            &transcript_chunks,
            &vectors,
        )
        .await
        .context("store transcript embeddings")?;
    }

    let summary = crate::summary::chat::load_meeting_summary(pool, meeting_id).await;
    let summary_chunks = chunk_summary(&summary);
    if !summary_chunks.is_empty() {
        let Some(vectors) = embed_chunks_batched(&summary_chunks).await else {
            return Ok(());
        };
        MeetingEmbeddingsRepository::replace_for_meeting(
            pool,
            meeting_id,
            "summary",
            EMBEDDING_MODEL_ID,
            &summary_chunks,
            &vectors,
        )
        .await
        .context("store summary embeddings")?;
    }

    log::debug!(
        "indexed meeting {meeting_id} for semantic search ({} transcript / {} summary chunks)",
        transcript_chunks.len(),
        summary_chunks.len()
    );
    Ok(())
}

/// Embed chunk texts in bounded batches so a long meeting never issues one
/// giant ONNX run. `None` bubbles model unavailability up unchanged.
async fn embed_chunks_batched(
    chunks: &[crate::database::repositories::meeting_embeddings::Chunk],
) -> Option<Vec<Vec<f32>>> {
    let mut vectors = Vec::with_capacity(chunks.len());
    for window in chunks.chunks(EMBED_BATCH) {
        let texts: Vec<String> = window.iter().map(|c| c.text.clone()).collect();
        vectors.extend(embedding_engine::embed_passages(texts).await?);
    }
    Some(vectors)
}

/// Fire-and-forget single-meeting index (summary done, retranscription done).
pub fn spawn_index_meeting(pool: SqlitePool, meeting_id: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = index_meeting(&pool, &meeting_id).await {
            log::warn!("semantic indexing failed for {meeting_id}: {e}");
        }
    });
}

/// Fire-and-forget sweep of meetings missing an index (new recordings land
/// here shortly after save; also the backfill workhorse).
pub fn spawn_index_sweep(pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        run_sweep(&pool).await;
    });
}

async fn run_sweep(pool: &SqlitePool) {
    if !embedding_engine::is_model_available() {
        return;
    }
    if SWEEP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    // Meetings that produce no chunks (e.g. zero transcript segments) never
    // leave the missing list; skipping ones already attempted this sweep
    // guarantees forward progress instead of refetching the same batch
    // forever.
    let mut attempted: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        let missing = match MeetingEmbeddingsRepository::meetings_missing_index(
            pool,
            EMBEDDING_MODEL_ID,
            BACKFILL_BATCH + attempted.len() as i64,
        )
        .await
        {
            Ok(list) => list,
            Err(e) => {
                log::warn!("semantic index sweep query failed: {e}");
                break;
            }
        };
        let fresh: Vec<String> = missing
            .iter()
            .filter(|id| !attempted.contains(*id))
            .take(BACKFILL_BATCH as usize)
            .cloned()
            .collect();
        if fresh.is_empty() {
            break;
        }
        for meeting_id in &fresh {
            attempted.insert(meeting_id.clone());
            if let Err(e) = index_meeting(pool, meeting_id).await {
                log::warn!("semantic indexing failed for {meeting_id}: {e}");
            }
        }
        tokio::time::sleep(BACKFILL_PAUSE).await;
    }
    SWEEP_RUNNING.store(false, Ordering::SeqCst);
}

/// Startup: after a settling delay, download the model if needed (one-time,
/// pinned + verified), then backfill every unindexed meeting.
pub fn spawn_startup_backfill(pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        if !embedding_engine::is_model_available()
            && let Err(e) = embedding_engine::ensure_model_available().await
        {
            log::info!("semantic search unavailable (model not downloaded): {e}");
            return;
        }
        run_sweep(&pool).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn index_meeting_is_a_clean_noop_without_the_model() {
        // No models dir in unit tests → unavailable → Ok(()) without touching
        // the database at all (the pool would reject unknown tables loudly).
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        index_meeting(&pool, "m1").await.unwrap();
    }

    #[tokio::test]
    async fn sweep_is_a_clean_noop_without_the_model() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_sweep(&pool).await;
        assert!(!SWEEP_RUNNING.load(Ordering::SeqCst));
    }
}
