use anyhow::Result;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc;

use super::audio_processing::create_meeting_folder;
use super::incremental_saver::IncrementalAudioSaver;
use super::recording_state::AudioChunk;

/// Structured transcript segment for JSON export
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub audio_start_time: f64, // Seconds from recording start
    pub audio_end_time: f64,   // Seconds from recording start
    pub duration: f64,          // Segment duration in seconds
    pub display_time: String,   // Formatted time for display like "[02:15]"
    /// Measured ASR confidence; absent for engines such as Parakeet.
    pub confidence: Option<f32>,
    pub sequence_id: u64,
    /// Audio source: "mic" (the user) or "system" (other participants)
    #[serde(default)]
    pub speaker: Option<String>,
}

/// Meeting metadata structure
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MeetingMetadata {
    pub version: String,
    pub meeting_id: Option<String>,
    pub meeting_name: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub duration_seconds: Option<f64>,
    pub devices: DeviceInfo,
    pub audio_file: String,
    pub transcript_file: String,
    pub sample_rate: u32,
    pub status: String, // "recording", "completed", "error"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription: Option<TranscriptionMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription_diagnostics: Option<TranscriptionDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DeviceInfo {
    pub microphone: Option<String>,
    pub system_audio: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TranscriptionMetadata {
    pub provider: String,
    pub model: String,
    pub post_meeting_quality_pass_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TranscriptionDiagnostics {
    pub segment_count: usize,
    pub segments_under_three_seconds: usize,
    pub average_segment_seconds: f64,
}

/// New recording saver using incremental saving strategy
pub struct RecordingSaver {
    incremental_saver: Option<Arc<AsyncMutex<IncrementalAudioSaver>>>,
    meeting_folder: Option<PathBuf>,
    meeting_name: Option<String>,
    transcription: Option<TranscriptionMetadata>,
    metadata: Option<MeetingMetadata>,
    transcript_segments: Arc<Mutex<Vec<TranscriptSegment>>>,
    chunk_receiver: Option<mpsc::UnboundedReceiver<AudioChunk>>,
    is_saving: Arc<Mutex<bool>>,
}

impl RecordingSaver {
    /// Cloneable segment storage used by the event listener during shutdown,
    /// when the RecordingManager is temporarily moved out of global state.
    pub fn transcript_segment_sink(&self) -> Arc<Mutex<Vec<TranscriptSegment>>> {
        self.transcript_segments.clone()
    }

    pub fn add_transcript_segment_to_sink(
        sink: &Arc<Mutex<Vec<TranscriptSegment>>>,
        segment: TranscriptSegment,
    ) {
        if let Ok(mut segments) = sink.lock() {
            if let Some(existing) = segments
                .iter_mut()
                .find(|s| s.sequence_id == segment.sequence_id)
            {
                *existing = segment;
            } else {
                segments.push(segment);
            }
        }
    }

    pub fn new() -> Self {
        Self {
            incremental_saver: None,
            meeting_folder: None,
            meeting_name: None,
            transcription: None,
            metadata: None,
            transcript_segments: Arc::new(Mutex::new(Vec::new())),
            chunk_receiver: None,
            is_saving: Arc::new(Mutex::new(false)),
        }
    }

    /// Set the meeting name for this recording session
    pub fn set_meeting_name(&mut self, name: Option<String>) {
        self.meeting_name = name;
    }

    /// Persist the exact ASR configuration used for this recording. This is set
    /// before the meeting folder exists and copied into metadata at initialization.
    pub fn set_transcription_metadata(&mut self, transcription: TranscriptionMetadata) {
        self.transcription = Some(transcription.clone());
        if let Some(ref mut metadata) = self.metadata {
            metadata.transcription = Some(transcription);
        }
    }

    /// Set device information in metadata
    pub fn set_device_info(&mut self, mic_name: Option<String>, sys_name: Option<String>) {
        if let Some(ref mut metadata) = self.metadata {
            metadata.devices.microphone = mic_name;
            metadata.devices.system_audio = sys_name;

            // Write updated metadata to disk if folder exists
            if let Some(folder) = &self.meeting_folder {
                let metadata_clone = metadata.clone();
                if let Err(e) = self.write_metadata(folder, &metadata_clone) {
                    warn!("Failed to update metadata with device info: {}", e);
                }
            }
        }
    }

    /// Add or update a structured transcript segment (upserts based on sequence_id)
    /// Also saves incrementally to disk
    pub fn add_transcript_segment(&self, segment: TranscriptSegment) {
        Self::add_transcript_segment_to_sink(&self.transcript_segments, segment);

        // NEW: Save incrementally to disk
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                warn!("Failed to write incremental transcript update: {}", e);
            }
        }
    }

    /// Legacy method for backward compatibility - converts text to basic segment
    pub fn add_transcript_chunk(&self, text: String) {
        let segment = TranscriptSegment {
            id: format!("seg_{}", chrono::Utc::now().timestamp_millis()),
            text,
            audio_start_time: 0.0,
            audio_end_time: 0.0,
            duration: 0.0,
            display_time: "[00:00]".to_string(),
            confidence: None,
            sequence_id: 0,
            speaker: None,
        };
        self.add_transcript_segment(segment);
    }

    /// Start accumulation with optional incremental saving
    ///
    /// # Arguments
    /// * `auto_save` - If true, creates checkpoints and enables saving. If false, audio chunks are discarded.
    pub fn start_accumulation(&mut self, auto_save: bool) -> mpsc::UnboundedSender<AudioChunk> {
        if auto_save {
            info!("Initializing incremental audio saver for recording (auto-save ENABLED)");
        } else {
            info!(
                "Starting recording without audio saving (auto-save DISABLED - transcripts only)"
            );
        }

        // Create channel for receiving audio chunks
        let (sender, receiver) = mpsc::unbounded_channel::<AudioChunk>();
        self.chunk_receiver = Some(receiver);

        // Initialize meeting folder and incremental saver ONLY if auto_save is enabled
        if auto_save {
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, true) {
                    Ok(()) => info!("Successfully initialized meeting folder with checkpoints"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                        // Continue anyway - will use fallback flat structure
                    }
                }
            }
        } else {
            // When auto_save is false, still create meeting folder for transcripts/metadata
            // but skip .checkpoints directory
            if let Some(name) = self.meeting_name.clone() {
                match self.initialize_meeting_folder(&name, false) {
                    Ok(()) => info!("Successfully initialized meeting folder (transcripts only)"),
                    Err(e) => {
                        error!("Failed to initialize meeting folder: {}", e);
                    }
                }
            }
        }

        // Mark as saving BEFORE spawning the task. The accumulation loop reads
        // this flag on every chunk; if it were set after spawn, a chunk arriving
        // first would observe `false` and terminate the saver prematurely.
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = true;
        }

        // Start accumulation task
        let is_saving_clone = self.is_saving.clone();
        let incremental_saver_arc = self.incremental_saver.clone();
        let save_audio = auto_save;

        if let Some(mut receiver) = self.chunk_receiver.take() {
            tokio::spawn(async move {
                info!(
                    "Recording saver accumulation task started (save_audio: {})",
                    save_audio
                );

                while let Some(chunk) = receiver.recv().await {
                    // Persist the chunk we just received *before* honoring a stop
                    // request. The previous `break`-before-add dropped this chunk
                    // (and anything already queued) the moment `is_saving` flipped,
                    // losing trailing audio at the end of every recording.
                    if save_audio {
                        if let Some(saver_arc) = &incremental_saver_arc {
                            let mut saver_guard = saver_arc.lock().await;
                            if let Err(e) = saver_guard.add_chunk(chunk) {
                                error!("Failed to add chunk to incremental saver: {}", e);
                            }
                        } else {
                            error!("Incremental saver not available while accumulating");
                        }
                    }
                    // (auto_save disabled → chunk discarded; transcription already ran upstream.)

                    // Stop requested: drain whatever is still buffered (chunks that
                    // arrived before the flag flipped) via non-blocking `try_recv`,
                    // then finish — otherwise those queued chunks would be lost.
                    let stopped = match is_saving_clone.lock() {
                        Ok(is_saving) => !*is_saving,
                        _ => true,
                    };
                    if stopped {
                        while let Ok(chunk) = receiver.try_recv() {
                            if save_audio {
                                if let Some(saver_arc) = &incremental_saver_arc {
                                    let mut saver_guard = saver_arc.lock().await;
                                    if let Err(e) = saver_guard.add_chunk(chunk) {
                                        error!("Failed to add chunk to incremental saver: {}", e);
                                    }
                                }
                            }
                        }
                        break;
                    }
                }

                info!("Recording saver accumulation task ended");
            });
        }

        sender
    }

    /// Initialize meeting folder structure and metadata
    ///
    /// # Arguments
    /// * `meeting_name` - Name of the meeting
    /// * `create_checkpoints` - Whether to create .checkpoints/ directory and IncrementalAudioSaver
    fn initialize_meeting_folder(
        &mut self,
        meeting_name: &str,
        create_checkpoints: bool,
    ) -> Result<()> {
        // Load preferences to get base recordings folder
        let base_folder = super::recording_preferences::get_default_recordings_folder();

        // Create meeting folder structure (with or without .checkpoints/ subdirectory)
        let meeting_folder = create_meeting_folder(&base_folder, meeting_name, create_checkpoints)?;

        // Only initialize incremental saver if checkpoints are needed (auto_save is true)
        if create_checkpoints {
            let incremental_saver = IncrementalAudioSaver::new(meeting_folder.clone(), 48000)?;
            self.incremental_saver = Some(Arc::new(AsyncMutex::new(incremental_saver)));
            info!(
                "✅ Incremental audio saver initialized for meeting: {}",
                meeting_name
            );
        } else {
            info!("⚠️  Skipped incremental audio saver (auto-save disabled)");
        }

        // Create initial metadata
        let metadata = MeetingMetadata {
            version: "1.0".to_string(),
            meeting_id: None, // Will be set by backend
            meeting_name: Some(meeting_name.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
            duration_seconds: None,
            devices: DeviceInfo {
                microphone: None, // Could be enhanced to store actual device names
                system_audio: None,
            },
            audio_file: if create_checkpoints {
                "audio.mp4".to_string()
            } else {
                "".to_string()
            },
            transcript_file: "transcripts.json".to_string(),
            sample_rate: 48000,
            status: "recording".to_string(),
            transcription: self.transcription.clone(),
            transcription_diagnostics: None,
        };

        // Write initial metadata.json
        self.write_metadata(&meeting_folder, &metadata)?;

        self.meeting_folder = Some(meeting_folder);
        self.metadata = Some(metadata);

        Ok(())
    }

    /// Write metadata.json to disk (atomic write with temp file)
    fn write_metadata(&self, folder: &PathBuf, metadata: &MeetingMetadata) -> Result<()> {
        let metadata_path = folder.join("metadata.json");
        let temp_path = folder.join(".metadata.json.tmp");

        let json_string = serde_json::to_string_pretty(metadata)?;
        std::fs::write(&temp_path, json_string)?;
        std::fs::rename(&temp_path, &metadata_path)?; // Atomic

        Ok(())
    }

    fn finalize_metadata(&self, recording_duration: Option<f64>) -> Result<(), String> {
        let (Some(folder), Some(mut metadata)) = (&self.meeting_folder, self.metadata.clone())
        else {
            return Ok(());
        };

        metadata.status = "completed".to_string();
        metadata.completed_at = Some(chrono::Utc::now().to_rfc3339());
        metadata.duration_seconds = recording_duration.or_else(|| {
            self.transcript_segments
                .lock()
                .ok()
                .and_then(|segments| segments.last().map(|segment| segment.audio_end_time))
        });

        if let Ok(segments) = self.transcript_segments.lock() {
            let segment_count = segments.len();
            let total_duration: f64 = segments.iter().map(|segment| segment.duration).sum();
            metadata.transcription_diagnostics = Some(TranscriptionDiagnostics {
                segment_count,
                segments_under_three_seconds: segments
                    .iter()
                    .filter(|segment| segment.duration < 3.0)
                    .count(),
                average_segment_seconds: if segment_count == 0 {
                    0.0
                } else {
                    total_duration / segment_count as f64
                },
            });
        }

        self.write_metadata(folder, &metadata).map_err(|error| {
            error!("❌ Failed to update metadata to completed: {}", error);
            format!("Failed to update metadata: {}", error)
        })?;

        info!(
            "✅ Metadata updated with duration: {:?}s",
            metadata.duration_seconds
        );
        Ok(())
    }

    /// Write transcripts.json to disk (atomic write with temp file and validation)
    fn write_transcripts_json(&self, folder: &PathBuf) -> Result<()> {
        // Clone segments to avoid holding lock during I/O
        let segments_clone = match self.transcript_segments.lock() {
            Ok(segments) => segments.clone(),
            _ => {
                error!("Failed to lock transcript segments for writing");
                return Err(anyhow::anyhow!("Failed to lock transcript segments"));
            }
        };

        info!(
            "Writing {} transcript segments to JSON",
            segments_clone.len()
        );

        // Create JSON structure (live-recording schema: serializes the IPC
        // TranscriptSegment directly, which carries display_time/confidence).
        let json = serde_json::json!({
            "version": "1.0",
            "segments": segments_clone,
            "last_updated": chrono::Utc::now().to_rfc3339(),
            "total_segments": segments_clone.len()
        });

        // Atomic temp-write + rename via the shared helper.
        super::common::write_json_atomic(folder, "transcripts.json", &json).map_err(|e| {
            error!("Failed to write transcripts.json: {}", e);
            e
        })?;

        info!(
            "Successfully wrote transcripts.json with {} segments",
            segments_clone.len()
        );
        Ok(())
    }

    // in app/src-tauri/src/audio/recording_saver.rs
    pub fn get_stats(&self) -> (usize, u32) {
        if let Some(ref saver) = self.incremental_saver {
            match saver.try_lock() {
                Ok(guard) => (guard.get_checkpoint_count() as usize, 48000),
                _ => (0, 48000),
            }
        } else {
            (0, 48000)
        }
    }

    /// Stop and save using incremental saving approach
    ///
    /// # Arguments
    /// * `app` - Tauri app handle for emitting events
    /// * `recording_duration` - Actual recording duration in seconds (from RecordingState)
    pub async fn stop_and_save<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        recording_duration: Option<f64>,
    ) -> Result<Option<String>, String> {
        info!("Stopping recording saver");

        // Stop accumulation
        if let Ok(mut is_saving) = self.is_saving.lock() {
            *is_saving = false;
        }

        // Give time for final chunks
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        // Check if incremental saver exists (indicates auto_save was enabled)
        let should_save_audio = self.incremental_saver.is_some();

        // Always rewrite the final transcript snapshot after transcription workers
        // finish. In transcript-only mode there is no audio saver, but late shutdown
        // segments may have arrived since the last incremental write.
        if let Some(folder) = &self.meeting_folder {
            if let Err(e) = self.write_transcripts_json(folder) {
                error!("❌ Failed to write final transcripts: {}", e);
                return Err(format!("Failed to save transcripts: {}", e));
            }

            let transcript_path = folder.join("transcripts.json");
            if !transcript_path.exists() {
                error!(
                    "❌ Transcript file was not created at: {}",
                    transcript_path.display()
                );
                return Err("Transcript file verification failed".to_string());
            }
            info!(
                "✅ Transcripts saved and verified at: {}",
                transcript_path.display()
            );
        }

        if !should_save_audio {
            info!(
                "⚠️  No audio saver initialized (auto-save was disabled) - skipping audio finalization"
            );
            self.finalize_metadata(recording_duration)?;
            info!("✅ Final transcript snapshot saved");
            return Ok(None);
        }

        // Finalize incremental saver (merge checkpoints into final audio.mp4)
        let final_audio_path = if let Some(saver_arc) = &self.incremental_saver {
            let mut saver = saver_arc.lock().await;
            match saver.finalize().await {
                Ok(path) => {
                    info!("✅ Successfully finalized audio: {}", path.display());
                    path
                }
                Err(e) => {
                    error!("❌ Failed to finalize incremental saver: {}", e);
                    return Err(format!("Failed to finalize audio: {}", e));
                }
            }
        } else {
            error!("No incremental saver initialized - cannot save recording");
            return Err("No incremental saver initialized".to_string());
        };

        // Update metadata to completed status with actual recording duration.
        self.finalize_metadata(recording_duration)?;

        // Emit save event with audio and transcript paths
        let save_event = serde_json::json!({
            "audio_file": final_audio_path.to_string_lossy(),
            "transcript_file": self.meeting_folder.as_ref()
                .map(|f| f.join("transcripts.json").to_string_lossy().to_string()),
            "meeting_name": self.meeting_name,
            "meeting_folder": self.meeting_folder.as_ref()
                .map(|f| f.to_string_lossy().to_string())
        });

        if let Err(e) = app.emit("recording-saved", &save_event) {
            warn!("Failed to emit recording-saved event: {}", e);
        }

        // Clean up transcript segments
        if let Ok(mut segments) = self.transcript_segments.lock() {
            segments.clear();
        }

        Ok(Some(final_audio_path.to_string_lossy().to_string()))
    }

    /// Get the meeting folder path (for passing to backend)
    pub fn get_meeting_folder(&self) -> Option<&PathBuf> {
        self.meeting_folder.as_ref()
    }

    /// Get accumulated transcript segments (for reload sync)
    pub fn get_transcript_segments(&self) -> Vec<TranscriptSegment> {
        match self.transcript_segments.lock() {
            Ok(segments) => segments.clone(),
            _ => Vec::new(),
        }
    }

    /// Get meeting name (for reload sync)
    pub fn get_meeting_name(&self) -> Option<String> {
        self.meeting_name.clone()
    }
}

impl Default for RecordingSaver {
    fn default() -> Self {
        Self::new()
    }
}
