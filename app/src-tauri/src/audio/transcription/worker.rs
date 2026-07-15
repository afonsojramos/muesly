// audio/transcription/worker.rs
//
// Parallel transcription worker pool and chunk processing logic.

use super::engine::TranscriptionEngine;
use super::provider::TranscriptionError;
use crate::audio::AudioChunk;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Runtime};

// Sequence counter for transcript updates
static SEQUENCE_COUNTER: AtomicU64 = AtomicU64::new(0);

// Speech detection flag - reset per recording session
static SPEECH_DETECTED_EMITTED: AtomicBool = AtomicBool::new(false);

// Module-level transcription progress counters, reset per session.
static CHUNKS_QUEUED: AtomicU64 = AtomicU64::new(0);
static CHUNKS_COMPLETED: AtomicU64 = AtomicU64::new(0);
static TRANSCRIPTION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Reset the speech detected flag for a new recording session
pub fn reset_speech_detected_flag() {
    SPEECH_DETECTED_EMITTED.store(false, Ordering::SeqCst);
    info!(
        "🔍 SPEECH_DETECTED_EMITTED reset to: {}",
        SPEECH_DETECTED_EMITTED.load(Ordering::SeqCst)
    );
}

/// Reset transcription progress counters for a new recording/import session.
pub fn reset_transcription_progress() {
    CHUNKS_QUEUED.store(0, Ordering::SeqCst);
    CHUNKS_COMPLETED.store(0, Ordering::SeqCst);
    TRANSCRIPTION_ACTIVE.store(true, Ordering::SeqCst);
}

/// Returns `(chunks_queued, chunks_completed)`. Queue depth = queued - completed.
pub fn transcription_progress() -> (u64, u64) {
    (
        CHUNKS_QUEUED.load(Ordering::SeqCst),
        CHUNKS_COMPLETED.load(Ordering::SeqCst),
    )
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptUpdate {
    pub text: String,
    pub timestamp: String, // Wall-clock time for reference (e.g., "14:30:05")
    pub source: String,
    pub sequence_id: u64,
    pub chunk_start_time: f64, // Legacy field, kept for compatibility
    pub is_partial: bool,
    /// Measured ASR confidence, or `None` when the provider does not expose one.
    pub confidence: Option<f32>,
    // NEW: Recording-relative timestamps for playback sync
    pub audio_start_time: f64, // Seconds from recording start (e.g., 125.3)
    pub audio_end_time: f64,   // Seconds from recording start (e.g., 128.6)
    pub duration: f64,         // Segment duration in seconds (e.g., 3.3)
}

struct VocabularyLearningCandidate {
    audio: Arc<Vec<f32>>,
    prompted: String,
    prompted_confidence: f32,
    preferred: String,
    language: String,
    baseline_prompt: Option<String>,
}

const MAX_VOCABULARY_LEARNING_CANDIDATES: usize = 2;

/// One transcribed chunk, plus the exact 16 kHz samples the engine saw so a
/// Deciding-phase segment can be re-decoded once the session language locks.
struct ChunkTranscription {
    text: String,
    confidence: Option<f32>,
    is_partial: bool,
    learning_candidate: Option<VocabularyLearningCandidate>,
    samples_16k: Arc<Vec<f32>>,
}

/// A segment already emitted while the auto-detect language was still
/// deciding, kept (with its audio) so it can be re-checked against the stable
/// language once the lock settles.
struct PendingLangRepair {
    samples: Arc<Vec<f32>>,
    original_text: String,
    update: TranscriptUpdate,
}

/// Upper bound on Deciding-phase segments retained for repair. The lock
/// normally settles within a handful of segments; if pathological audio keeps
/// it deciding, stop accumulating audio rather than growing without bound.
const MAX_PENDING_LANG_REPAIRS: usize = 12;

/// Prompt-continuity stream key for repair re-decodes, distinct from the live
/// "mic"/"system" keys so a repair never rewinds a live stream's prompt tail.
const REPAIR_PROMPT_STREAM: &str = "lang-repair";

/// Confidence floor a repair re-decode must meet to replace the original text,
/// matching the bar the live emission path enforces (`confidence_threshold`).
const REPAIR_MIN_CONFIDENCE: f32 = 0.3;

/// Re-decode one Deciding-phase segment forced to the stable language and
/// return the replacement `(text, confidence)` when it should supersede the
/// original: non-empty, actually different, past the hallucination gate, and
/// at least as confident as the live emission floor. Shared by the live
/// worker's post-lock repair and the offline import/retranscription repairs.
pub(crate) async fn redecode_deciding_segment(
    engine: &crate::whisper_engine::WhisperEngine,
    samples: Arc<Vec<f32>>,
    stable_code: &str,
    original_text: &str,
) -> Option<(String, f32)> {
    let (text, confidence, _, _) = match engine
        .transcribe_audio_with_learning_context(
            samples,
            Some(stable_code.to_string()),
            REPAIR_PROMPT_STREAM,
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            warn!("Language repair decode failed: {}", error);
            return None;
        }
    };
    let text = text.trim().to_string();
    // Keep the original when the forced decode agrees, comes back empty or
    // weak, or trips the hallucination gate: the original already passed the
    // live path's gates.
    if text.is_empty() || text == original_text.trim() || confidence < REPAIR_MIN_CONFIDENCE {
        return None;
    }
    if super::segment_filter::should_drop_segment(&text, Some(confidence)).is_some() {
        return None;
    }
    Some((text, confidence))
}

// NOTE: get_transcript_history and get_recording_meeting_name functions
// have been moved to recording_commands.rs where they have access to RECORDING_MANAGER

/// Optimized parallel transcription task ensuring ZERO chunk loss
pub fn start_transcription_task<R: Runtime>(
    app: AppHandle<R>,
    transcription_receiver: tokio::sync::mpsc::UnboundedReceiver<AudioChunk>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!("🚀 Starting optimized parallel transcription task - guaranteeing zero chunk loss");

        // Reset module-level progress counters for this session.
        reset_transcription_progress();

        // Initialize the local Whisper engine.
        let transcription_engine = match super::engine::get_or_init_transcription_engine(&app).await
        {
            Ok(engine) => engine,
            Err(e) => {
                error!("Failed to initialize transcription engine: {}", e);
                let _ = app.emit("transcription-error", serde_json::json!({
                    "error": e,
                    "userMessage": "Recording failed: Unable to initialize speech recognition. Please check your model settings.",
                    "actionable": true
                }));
                return;
            }
        };

        // New recording session: do not carry prior-meeting text into Whisper prompts.
        transcription_engine.reset_segment_context().await;
        let vocabulary_learning_session = uuid::Uuid::new_v4().to_string();
        let vocabulary_learning_candidates = Arc::new(tokio::sync::Mutex::new(Vec::new()));

        // Bound the worker handoff so a slow model cannot create a second,
        // unbounded copy of the pending audio. The dispatcher awaits capacity
        // here while the capture-side queue remains lossless.
        const NUM_WORKERS: usize = 1; // Serial processing ensures transcripts emit in chronological order
        const WORK_QUEUE_CAPACITY: usize = 16;
        let (work_sender, work_receiver) =
            tokio::sync::mpsc::channel::<AudioChunk>(WORK_QUEUE_CAPACITY);
        let work_receiver = Arc::new(tokio::sync::Mutex::new(work_receiver));

        // Track completion: AtomicU64 for chunks queued, AtomicU64 for chunks completed
        let chunks_queued = Arc::new(AtomicU64::new(0));
        let chunks_completed = Arc::new(AtomicU64::new(0));
        let input_finished = Arc::new(AtomicBool::new(false));

        // Text-level mic/system dedup for speaker-playback echo (see crosstalk.rs).
        let crosstalk_filter = Arc::new(tokio::sync::Mutex::new(
            super::crosstalk::CrosstalkFilter::new(),
        ));

        info!(
            "📊 Starting {} transcription worker{} (serial mode for ordered emission)",
            NUM_WORKERS,
            if NUM_WORKERS == 1 { "" } else { "s" }
        );

        // Spawn worker tasks
        let mut worker_handles = Vec::new();
        for worker_id in 0..NUM_WORKERS {
            let engine_clone = transcription_engine.clone();
            let app_clone = app.clone();
            let work_receiver_clone = work_receiver.clone();
            let chunks_completed_clone = chunks_completed.clone();
            let input_finished_clone = input_finished.clone();
            let chunks_queued_clone = chunks_queued.clone();
            let crosstalk_clone = crosstalk_filter.clone();
            let learning_candidates_clone = Arc::clone(&vocabulary_learning_candidates);

            let worker_handle = tokio::spawn(async move {
                info!("👷 Worker {} started", worker_id);

                // Segments emitted while the auto-detect language was still
                // deciding; re-checked (and re-emitted if wrong) once it locks.
                let mut pending_lang_repairs: Vec<PendingLangRepair> = Vec::new();

                // PRE-VALIDATE model state to avoid repeated async calls per chunk
                let initial_model_loaded = engine_clone.is_model_loaded().await;
                let current_model = engine_clone
                    .get_current_model()
                    .await
                    .unwrap_or_else(|| "unknown".to_string());

                if initial_model_loaded {
                    info!(
                        "✅ Worker {} pre-validation: transcription model '{}' is loaded and ready",
                        worker_id, current_model
                    );
                } else {
                    warn!(
                        "⚠️ Worker {} pre-validation: transcription model not loaded - chunks may be skipped",
                        worker_id
                    );
                }

                loop {
                    // Try to get a chunk to process
                    let chunk = {
                        let mut receiver = work_receiver_clone.lock().await;
                        receiver.recv().await
                    };

                    match chunk {
                        Some(chunk) => {
                            // PERFORMANCE OPTIMIZATION: Reduce logging in hot path
                            // Only log every 10th chunk per worker to reduce I/O overhead
                            let should_log_this_chunk = chunk.chunk_id % 10 == 0;

                            if should_log_this_chunk {
                                info!(
                                    "👷 Worker {} processing chunk {} with {} samples",
                                    worker_id,
                                    chunk.chunk_id,
                                    chunk.data.len()
                                );
                            }

                            // Check if model is still loaded before processing
                            if !engine_clone.is_model_loaded().await {
                                warn!(
                                    "⚠️ Worker {}: transcription model unloaded; recovering before chunk {}",
                                    worker_id, chunk.chunk_id
                                );
                                if let Err(error) = engine_clone.load_model(&current_model).await {
                                    error!(
                                        "Worker {} could not recover transcription model '{}': {}",
                                        worker_id, current_model, error
                                    );
                                    let _ = app_clone.emit("transcription-error", serde_json::json!({
                                        "error": error.to_string(),
                                        "userMessage": "Transcription paused because the local model could not be reloaded.",
                                        "actionable": true
                                    }));
                                    chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                    CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);
                                    continue;
                                }
                            }

                            let chunk_timestamp = chunk.timestamp;
                            let chunk_duration = chunk.data.len() as f64 / chunk.sample_rate as f64;
                            // Speaker attribution: which VAD lane produced this chunk.
                            let chunk_source = match chunk.device_type {
                                crate::audio::recording_state::DeviceType::Microphone => "mic",
                                crate::audio::recording_state::DeviceType::System => "system",
                            };

                            // Whether the auto-detect language is still deciding
                            // going INTO this chunk: such chunks are candidates
                            // for the post-lock repair pass below. Whisper-only:
                            // Parakeet has no language lock to repair against.
                            let deciding_before = engine_clone.as_whisper().is_some()
                                && matches!(
                                    crate::get_language_preference_internal().as_deref(),
                                    None | Some("auto")
                                )
                                && crate::whisper_engine::lang_lock::current_stable().is_none();

                            let first_attempt = transcribe_chunk(
                                &engine_clone,
                                chunk.clone(),
                                chunk_source,
                                &app_clone,
                            )
                            .await;
                            let result = if matches!(
                                &first_attempt,
                                Err(TranscriptionError::EngineFailed(_))
                            ) {
                                warn!(
                                    "Worker {}: transcription failed on chunk {}; reloading and retrying once",
                                    worker_id, chunk.chunk_id
                                );
                                engine_clone.unload_model().await;
                                match engine_clone.load_model(&current_model).await {
                                    Ok(()) => {
                                        transcribe_chunk(
                                            &engine_clone,
                                            chunk,
                                            chunk_source,
                                            &app_clone,
                                        )
                                        .await
                                    }
                                    Err(error) => Err(TranscriptionError::EngineFailed(format!(
                                        "failed to reload model '{}': {}",
                                        current_model, error
                                    ))),
                                }
                            } else {
                                first_attempt
                            };
                            match result {
                                Ok(ChunkTranscription {
                                    text: transcript,
                                    confidence: confidence_opt,
                                    is_partial,
                                    learning_candidate,
                                    samples_16k,
                                }) => {
                                    let confidence_threshold = 0.3;

                                    let confidence_str = match confidence_opt {
                                        Some(c) => format!("{:.2}", c),
                                        None => "N/A".to_string(),
                                    };

                                    info!(
                                        "🔍 Worker {} transcription result: characters={}, confidence={}, partial={}, threshold={:.2}",
                                        worker_id,
                                        transcript.chars().count(),
                                        confidence_str,
                                        is_partial,
                                        confidence_threshold
                                    );

                                    // Check confidence threshold (or accept if no confidence provided)
                                    let meets_threshold =
                                        confidence_opt.map_or(true, |c| c >= confidence_threshold);

                                    // Quality gate: silence hallucinations and repetition loops.
                                    let quality_drop =
                                        if !transcript.trim().is_empty() && meets_threshold {
                                            super::segment_filter::should_drop_segment(
                                                &transcript,
                                                confidence_opt,
                                            )
                                        } else {
                                            None
                                        };
                                    if let Some(reason) = &quality_drop {
                                        info!(
                                            "🚮 Worker {} dropped segment ({:?})",
                                            worker_id, reason
                                        );
                                    }

                                    // Drop mic segments that duplicate a recent, overlapping
                                    // system segment (speaker playback picked up by the mic).
                                    let admitted = if !transcript.trim().is_empty()
                                        && meets_threshold
                                        && quality_drop.is_none()
                                    {
                                        let mut filter = crosstalk_clone.lock().await;
                                        filter.admit(
                                            chunk_source == "mic",
                                            &transcript,
                                            chunk_timestamp,
                                            chunk_timestamp + chunk_duration,
                                        )
                                    } else {
                                        true
                                    };
                                    if !admitted {
                                        info!(
                                            "🔇 Worker {} dropped mic segment as system cross-talk",
                                            worker_id
                                        );
                                    }

                                    if !transcript.trim().is_empty()
                                        && meets_threshold
                                        && quality_drop.is_none()
                                        && admitted
                                    {
                                        if let Some(candidate) = learning_candidate {
                                            let mut candidates =
                                                learning_candidates_clone.lock().await;
                                            if candidates.len() < MAX_VOCABULARY_LEARNING_CANDIDATES
                                                && !candidates.iter().any(
                                                    |saved: &VocabularyLearningCandidate| {
                                                        saved.preferred.eq_ignore_ascii_case(
                                                            &candidate.preferred,
                                                        )
                                                    },
                                                )
                                            {
                                                candidates.push(candidate);
                                            }
                                        }

                                        // PERFORMANCE: Only log transcription results, not every processing step
                                        info!(
                                            "✅ Worker {} transcribed {} characters (confidence: {}, partial: {})",
                                            worker_id,
                                            transcript.chars().count(),
                                            confidence_str,
                                            is_partial
                                        );

                                        // Emit speech-detected event for frontend UX (only on first detection per session)
                                        // This is lightweight and provides better user feedback
                                        let current_flag =
                                            SPEECH_DETECTED_EMITTED.load(Ordering::SeqCst);
                                        info!(
                                            "🔍 Checking speech-detected flag: current={}, will_emit={}",
                                            current_flag, !current_flag
                                        );

                                        if !current_flag {
                                            SPEECH_DETECTED_EMITTED.store(true, Ordering::SeqCst);
                                            match app_clone.emit(
                                                "speech-detected",
                                                serde_json::json!({
                                                    "message": "Speech activity detected"
                                                }),
                                            ) {
                                                Ok(_) => info!(
                                                    "🎤 ✅ First speech detected - successfully emitted speech-detected event"
                                                ),
                                                Err(e) => error!(
                                                    "🎤 ❌ Failed to emit speech-detected event: {}",
                                                    e
                                                ),
                                            }
                                        } else {
                                            info!(
                                                "🔍 Speech already detected in this session, not re-emitting"
                                            );
                                        }

                                        // Generate sequence ID and calculate timestamps FIRST
                                        let sequence_id =
                                            SEQUENCE_COUNTER.fetch_add(1, Ordering::SeqCst);
                                        let audio_start_time = chunk_timestamp; // Already in seconds from recording start
                                        let audio_end_time = chunk_timestamp + chunk_duration;

                                        // Save structured transcript segment to recording manager (only final results)
                                        // Save ALL segments (partial and final) to ensure complete JSON
                                        // Create structured segment with full timestamp data
                                        // NOTE: This is now handled via the transcript-update event emission below
                                        // The recording_commands module listens to these events and saves them
                                        // This decouples the transcription worker from direct RECORDING_MANAGER access

                                        // Emit transcript update with NEW recording-relative timestamps

                                        let update = TranscriptUpdate {
                                            text: transcript,
                                            timestamp: format_current_timestamp(), // Wall-clock for reference
                                            source: chunk_source.to_string(),
                                            sequence_id,
                                            chunk_start_time: chunk_timestamp, // Legacy compatibility
                                            is_partial,
                                            confidence: confidence_opt,
                                            // NEW: Recording-relative timestamps for sync
                                            audio_start_time,
                                            audio_end_time,
                                            duration: chunk_duration,
                                        };

                                        if let Err(e) = app_clone.emit("transcript-update", &update)
                                        {
                                            error!(
                                                "Worker {}: Failed to emit transcript update: {}",
                                                worker_id, e
                                            );
                                        }

                                        // Emitted while the language was still
                                        // deciding: keep for the post-lock repair.
                                        if deciding_before
                                            && pending_lang_repairs.len() < MAX_PENDING_LANG_REPAIRS
                                        {
                                            pending_lang_repairs.push(PendingLangRepair {
                                                samples: samples_16k,
                                                original_text: update.text.clone(),
                                                update,
                                            });
                                        }
                                        // PERFORMANCE: Removed verbose logging of every emission
                                    } else if !transcript.trim().is_empty() && should_log_this_chunk
                                    {
                                        // PERFORMANCE: Only log low-confidence results occasionally
                                        if let Some(c) = confidence_opt {
                                            info!(
                                                "Worker {} low-confidence transcription (confidence: {:.2}), skipping",
                                                worker_id, c
                                            );
                                        }
                                    }
                                }
                                Err(e) => {
                                    // Improved error handling with specific cases
                                    match e {
                                        TranscriptionError::AudioTooShort { .. } => {
                                            // Skip silently, this is expected for very short chunks
                                            info!("Worker {}: {}", worker_id, e);
                                            chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                            CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);
                                            continue;
                                        }
                                        TranscriptionError::ModelNotLoaded => {
                                            warn!(
                                                "Worker {}: Model unloaded during transcription",
                                                worker_id
                                            );
                                            chunks_completed_clone.fetch_add(1, Ordering::SeqCst);
                                            CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);
                                            continue;
                                        }
                                        _ => {
                                            warn!(
                                                "Worker {}: Transcription failed: {}",
                                                worker_id, e
                                            );
                                            let _ = app_clone
                                                .emit("transcription-warning", e.to_string());
                                        }
                                    }
                                }
                            }

                            // The language lock settled on this chunk: re-check
                            // every segment emitted while it was still deciding.
                            // Detached so the re-decodes (which contend for the
                            // model, not the worker) never stall live captions;
                            // re-emits are order-safe because the sink and the
                            // frontend both upsert by sequence_id.
                            if deciding_before && !pending_lang_repairs.is_empty() {
                                if let (Some(stable_id), Some(whisper)) = (
                                    crate::whisper_engine::lang_lock::current_stable(),
                                    engine_clone.as_whisper(),
                                ) {
                                    let pending = std::mem::take(&mut pending_lang_repairs);
                                    let repair_engine = whisper.clone();
                                    let repair_app = app_clone.clone();
                                    tokio::spawn(async move {
                                        repair_deciding_segments(
                                            &repair_engine,
                                            &repair_app,
                                            stable_id,
                                            pending,
                                        )
                                        .await;
                                    });
                                }
                            }

                            // Mark chunk as completed
                            let completed =
                                chunks_completed_clone.fetch_add(1, Ordering::SeqCst) + 1;
                            CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);
                            let queued = chunks_queued_clone.load(Ordering::SeqCst);

                            // PERFORMANCE: Only log progress every 5th chunk to reduce I/O overhead
                            if completed % 5 == 0 || should_log_this_chunk {
                                info!(
                                    "Worker {}: Progress {}/{} chunks ({:.1}%)",
                                    worker_id,
                                    completed,
                                    queued,
                                    (completed as f64 / queued.max(1) as f64 * 100.0)
                                );
                            }

                            // Emit progress event for frontend
                            let progress_percentage = if queued > 0 {
                                (completed as f64 / queued as f64 * 100.0) as u32
                            } else {
                                100
                            };

                            let _ = app_clone.emit("transcription-progress", serde_json::json!({
                                "worker_id": worker_id,
                                "chunks_completed": completed,
                                "chunks_queued": queued,
                                "progress_percentage": progress_percentage,
                                "message": format!("Worker {} processing... ({}/{})", worker_id, completed, queued)
                            }));
                        }
                        None => {
                            // No more chunks available
                            if input_finished_clone.load(Ordering::SeqCst) {
                                // Double-check that all queued chunks are actually completed
                                let final_queued = chunks_queued_clone.load(Ordering::SeqCst);
                                let final_completed = chunks_completed_clone.load(Ordering::SeqCst);

                                if final_completed >= final_queued {
                                    info!(
                                        "👷 Worker {} finishing - all {}/{} chunks processed",
                                        worker_id, final_completed, final_queued
                                    );
                                    break;
                                } else {
                                    warn!(
                                        "👷 Worker {} detected potential chunk loss: {}/{} completed, waiting...",
                                        worker_id, final_completed, final_queued
                                    );
                                    // AGGRESSIVE POLLING: Reduced from 50ms to 5ms for faster chunk detection during shutdown
                                    tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
                                }
                            } else {
                                // AGGRESSIVE POLLING: Reduced from 10ms to 1ms for faster response during shutdown
                                tokio::time::sleep(tokio::time::Duration::from_millis(1)).await;
                            }
                        }
                    }
                }

                info!("👷 Worker {} completed", worker_id);
            });

            worker_handles.push(worker_handle);
        }

        // Main dispatcher: receive chunks and distribute to workers
        let mut receiver = transcription_receiver;
        while let Some(chunk) = receiver.recv().await {
            let queued = chunks_queued.fetch_add(1, Ordering::SeqCst) + 1;
            CHUNKS_QUEUED.fetch_add(1, Ordering::SeqCst);
            info!(
                "📥 Dispatching chunk {} to workers (total queued: {})",
                chunk.chunk_id, queued
            );

            if let Err(_) = work_sender.send(chunk).await {
                error!("❌ Failed to send chunk to workers - this should not happen!");
                break;
            }
        }

        // Signal that input is finished
        input_finished.store(true, Ordering::SeqCst);
        drop(work_sender); // Close the channel to signal workers

        let total_chunks_queued = chunks_queued.load(Ordering::SeqCst);
        info!(
            "📭 Input finished with {} total chunks queued. Waiting for all {} workers to complete...",
            total_chunks_queued, NUM_WORKERS
        );

        // Emit final chunk count to frontend
        let _ = app.emit("transcription-queue-complete", serde_json::json!({
            "total_chunks": total_chunks_queued,
            "message": format!("{} chunks queued for processing - waiting for completion", total_chunks_queued)
        }));

        // Wait for all workers to complete
        for (worker_id, handle) in worker_handles.into_iter().enumerate() {
            match handle.await {
                Err(e) => {
                    error!("❌ Worker {} panicked: {:?}", worker_id, e);
                }
                _ => {
                    info!("✅ Worker {} completed successfully", worker_id);
                }
            }
        }

        let learning_candidates = {
            let mut candidates = vocabulary_learning_candidates.lock().await;
            std::mem::take(&mut *candidates)
        };
        // Vocabulary learning is whisper-only (candidates are only produced by
        // the whisper chunk path, so this is empty for Parakeet sessions).
        if let (false, Some(whisper_engine)) = (
            learning_candidates.is_empty(),
            transcription_engine.as_whisper(),
        ) {
            match whisper_engine.prepare_vocabulary_learning_decoder().await {
                Ok(decoder) => {
                    for candidate in learning_candidates {
                        match decoder
                            .transcribe(
                                candidate.audio,
                                candidate.language,
                                candidate.baseline_prompt,
                            )
                            .await
                        {
                            Ok((baseline, baseline_confidence)) => {
                                if let Some(observation) =
                                    crate::vocabulary::infer_learning_observation_for(
                                        &candidate.preferred,
                                        &candidate.prompted,
                                        candidate.prompted_confidence,
                                        baseline.trim(),
                                        baseline_confidence,
                                    )
                                {
                                    if observation
                                        .preferred
                                        .eq_ignore_ascii_case(&candidate.preferred)
                                    {
                                        if let Err(error) =
                                            crate::vocabulary::record_learning_observation(
                                                &app,
                                                &vocabulary_learning_session,
                                                observation,
                                            )
                                            .await
                                        {
                                            warn!(
                                                "Could not persist a vocabulary learning observation: {}",
                                                error
                                            );
                                        }
                                    }
                                }
                            }
                            Err(error) => log::debug!(
                                "Vocabulary comparison decode skipped after error: {}",
                                error
                            ),
                        }
                    }
                }
                Err(error) => log::debug!(
                    "Vocabulary learning skipped because the model context was unavailable: {}",
                    error
                ),
            }
        }

        // Final verification with retry logic to catch any stragglers
        let mut verification_attempts = 0;
        const MAX_VERIFICATION_ATTEMPTS: u32 = 10;

        loop {
            let final_queued = chunks_queued.load(Ordering::SeqCst);
            let final_completed = chunks_completed.load(Ordering::SeqCst);

            if final_queued == final_completed {
                info!(
                    "🎉 ALL {} chunks processed successfully - ZERO chunks lost!",
                    final_completed
                );
                break;
            } else if verification_attempts < MAX_VERIFICATION_ATTEMPTS {
                verification_attempts += 1;
                warn!(
                    "⚠️ Chunk count mismatch (attempt {}): {} queued, {} completed - waiting for stragglers...",
                    verification_attempts, final_queued, final_completed
                );

                // Wait a bit for any remaining chunks to be processed
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            } else {
                error!(
                    "❌ CRITICAL: After {} attempts, chunk loss detected: {} queued, {} completed",
                    MAX_VERIFICATION_ATTEMPTS, final_queued, final_completed
                );

                // Emit critical error event
                let _ = app.emit(
                    "transcript-chunk-loss-detected",
                    serde_json::json!({
                        "chunks_queued": final_queued,
                        "chunks_completed": final_completed,
                        "chunks_lost": final_queued - final_completed,
                        "message": "Some transcript chunks may have been lost during shutdown"
                    }),
                );
                break;
            }
        }

        TRANSCRIPTION_ACTIVE.store(false, Ordering::SeqCst);
        info!(
            "✅ Parallel transcription task completed - all workers finished, ready for model unload"
        );
    })
}

/// Re-transcribe segments that were emitted while the auto-detect language was
/// still deciding, forced to the now-stable language, and re-emit the ones
/// whose text changed. Deciding-phase segments transcribe in whatever language
/// each individually detected, so the first line(s) of a meeting can come out
/// in the wrong language; the transcript sink and the frontend both upsert by
/// `sequence_id`, so a re-emitted update replaces the original segment in the
/// live UI and in the saved transcript.
async fn repair_deciding_segments<R: Runtime>(
    engine: &Arc<crate::whisper_engine::WhisperEngine>,
    app: &AppHandle<R>,
    stable_id: i32,
    pending: Vec<PendingLangRepair>,
) {
    let Some(stable_code) = whisper_rs::get_lang_str(stable_id) else {
        warn!(
            "Language repair skipped: no language code for stable id {}",
            stable_id
        );
        return;
    };
    info!(
        "🔁 Language locked to '{}'; re-checking {} early segment(s)",
        stable_code,
        pending.len()
    );
    for item in pending {
        let Some((text, confidence)) = redecode_deciding_segment(
            engine,
            Arc::clone(&item.samples),
            stable_code,
            &item.original_text,
        )
        .await
        else {
            continue;
        };
        info!(
            "🔁 Repaired early segment {} into '{}'",
            item.update.sequence_id, stable_code
        );
        let update = TranscriptUpdate {
            text,
            confidence: Some(confidence),
            ..item.update
        };
        if let Err(error) = app.emit("transcript-update", &update) {
            error!(
                "Failed to emit language-repair transcript update: {}",
                error
            );
        }
    }
}

/// Transcribe an audio chunk with the configured local engine.
async fn transcribe_chunk<R: Runtime>(
    engine: &TranscriptionEngine,
    chunk: AudioChunk,
    chunk_source: &str,
    _app: &AppHandle<R>,
) -> std::result::Result<ChunkTranscription, TranscriptionError> {
    // Convert to 16kHz mono for transcription. Propagate failures instead of
    // silently feeding wrong-rate audio to the model, which would otherwise be
    // transcribed at the wrong speed and produce garbage.
    let transcription_data = if chunk.sample_rate != 16000 {
        crate::audio::audio_processing::resample(&chunk.data, chunk.sample_rate, 16000).map_err(
            |e| {
                TranscriptionError::EngineFailed(format!(
                    "Failed to resample chunk {} from {}Hz to 16000Hz: {}",
                    chunk.chunk_id, chunk.sample_rate, e
                ))
            },
        )?
    } else {
        chunk.data
    };

    // Skip VAD processing here since the pipeline already extracted speech using VAD
    let speech_samples = transcription_data;

    // Check for empty samples - improved error handling
    if speech_samples.is_empty() {
        warn!(
            "Audio chunk {} is empty, skipping transcription",
            chunk.chunk_id
        );
        return Err(TranscriptionError::AudioTooShort {
            samples: 0,
            minimum: 1600, // 100ms at 16kHz
        });
    }

    // Calculate energy for logging/monitoring only
    let energy: f32 =
        speech_samples.iter().map(|&x| x * x).sum::<f32>() / speech_samples.len() as f32;
    info!(
        "Processing speech audio chunk {} with {} samples (energy: {:.6})",
        chunk.chunk_id,
        speech_samples.len(),
        energy
    );

    let language = crate::get_language_preference_internal();

    // Parakeet: a single fast pass, no prompts, no confidence, no language
    // machinery. The worker's downstream gates treat the absent confidence as
    // low, so the hallucination phrase filter still applies. Dispatched before
    // the Arc wrap so the owned samples move straight into the engine; the
    // empty `samples_16k` is correct because its only consumer (the deciding-
    // language repair) is whisper-only and never runs for Parakeet.
    let whisper = match engine {
        TranscriptionEngine::Whisper(whisper) => whisper,
        TranscriptionEngine::Parakeet(parakeet) => {
            let duration_seconds = speech_samples.len() as f64 / 16000.0;
            return match parakeet.transcribe_audio(speech_samples).await {
                Ok(text) => Ok(ChunkTranscription {
                    text: text.trim().to_string(),
                    confidence: None,
                    is_partial: duration_seconds < 15.0,
                    learning_candidate: None,
                    samples_16k: Arc::new(Vec::new()),
                }),
                Err(error) => {
                    error!(
                        "Parakeet transcription failed for chunk {}: {}",
                        chunk.chunk_id, error
                    );
                    Err(TranscriptionError::EngineFailed(error.to_string()))
                }
            };
        }
    };

    let speech_samples = Arc::new(speech_samples);
    match whisper
        .transcribe_audio_with_learning_context(
            Arc::clone(&speech_samples),
            language.clone(),
            chunk_source,
        )
        .await
    {
        Ok((text, confidence, is_partial, learning_prompt)) => {
            let cleaned_text = text.trim().to_string();
            if cleaned_text.is_empty() {
                return Ok(ChunkTranscription {
                    text: String::new(),
                    confidence: Some(confidence),
                    is_partial,
                    learning_candidate: None,
                    samples_16k: speech_samples,
                });
            }

            let learning_candidate = (0.45..=0.85)
                .contains(&confidence)
                .then(|| {
                    crate::vocabulary::learnable_preferred_in_text_from(
                        &cleaned_text,
                        &learning_prompt.preferred_terms,
                    )
                })
                .flatten()
                .and_then(|preferred| {
                    let baseline_prompt =
                        learning_prompt
                            .initial_prompt
                            .as_deref()
                            .and_then(|prompt| {
                                crate::vocabulary::remove_term_from_initial_prompt(
                                    prompt, &preferred,
                                )
                            });
                    vocabulary_learning_language(language.as_deref()).and_then(
                        |learning_language| {
                            baseline_prompt.map(|baseline_prompt| VocabularyLearningCandidate {
                                audio: Arc::clone(&speech_samples),
                                prompted: cleaned_text.clone(),
                                prompted_confidence: confidence,
                                preferred,
                                language: learning_language,
                                baseline_prompt: (!baseline_prompt.is_empty())
                                    .then_some(baseline_prompt),
                            })
                        },
                    )
                });

            info!(
                "Whisper transcription complete for chunk {}: {} characters (confidence: {:.2}, partial: {})",
                chunk.chunk_id,
                cleaned_text.chars().count(),
                confidence,
                is_partial
            );
            Ok(ChunkTranscription {
                text: cleaned_text,
                confidence: Some(confidence),
                is_partial,
                learning_candidate,
                samples_16k: speech_samples,
            })
        }
        Err(error) => {
            error!(
                "Whisper transcription failed for chunk {}: {}",
                chunk.chunk_id, error
            );
            let transcription_error = TranscriptionError::EngineFailed(error.to_string());
            Err(transcription_error)
        }
    }
}

fn vocabulary_learning_language(language: Option<&str>) -> Option<String> {
    match language {
        Some("en") => Some("en".to_string()),
        Some("auto") | None => crate::whisper_engine::lang_lock::current_stable()
            .and_then(whisper_rs::get_lang_str)
            .filter(|detected| *detected == "en")
            .map(str::to_string),
        _ => None,
    }
}

/// Format current timestamp (wall-clock time)
fn format_current_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();

    let hours = (now.as_secs() / 3600) % 24;
    let minutes = (now.as_secs() / 60) % 60;
    let seconds = now.as_secs() % 60;

    format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
}

/// Format recording-relative time as [MM:SS]
#[allow(dead_code)]
fn format_recording_time(seconds: f64) -> String {
    let total_seconds = seconds.floor() as u64;
    let minutes = total_seconds / 60;
    let secs = total_seconds % 60;

    format!("[{:02}:{:02}]", minutes, secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_status_reports_queue_depth() {
        // Reset to a clean state for this test.
        reset_transcription_progress();

        let (queued, completed) = transcription_progress();
        assert_eq!(queued, 0, "queued should be 0 after reset");
        assert_eq!(completed, 0, "completed should be 0 after reset");
        assert_eq!(
            queued.saturating_sub(completed),
            0,
            "queue depth should be 0"
        );

        // Simulate enqueuing 3 chunks.
        CHUNKS_QUEUED.fetch_add(1, Ordering::SeqCst);
        CHUNKS_QUEUED.fetch_add(1, Ordering::SeqCst);
        CHUNKS_QUEUED.fetch_add(1, Ordering::SeqCst);

        let (queued, completed) = transcription_progress();
        assert_eq!(queued, 3);
        assert_eq!(completed, 0);
        assert_eq!(
            queued.saturating_sub(completed),
            3,
            "queue depth should be 3"
        );

        // Simulate completing 2 chunks.
        CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);
        CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);

        let (queued, completed) = transcription_progress();
        assert_eq!(queued, 3);
        assert_eq!(completed, 2);
        assert_eq!(
            queued.saturating_sub(completed),
            1,
            "queue depth should be 1"
        );

        // Complete the last chunk.
        CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);

        let (queued, completed) = transcription_progress();
        assert_eq!(
            queued.saturating_sub(completed),
            0,
            "queue depth should be 0 when all done"
        );

        // saturating_sub must not underflow if completed somehow exceeds queued.
        CHUNKS_COMPLETED.fetch_add(1, Ordering::SeqCst);
        let (queued, completed) = transcription_progress();
        assert_eq!(
            queued.saturating_sub(completed),
            0,
            "saturating_sub must not underflow"
        );
    }
}
