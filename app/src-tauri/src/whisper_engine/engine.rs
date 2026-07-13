// Commit name to recover the serial whisper engine processing for smaller meetings [Slower processing but dooes not fail] - "before parallel processing implementation"

use std::path::{PathBuf};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use whisper_rs::{WhisperContext, WhisperContextParameters, WhisperState, FullParams, SamplingStrategy};
use serde::{Serialize, Deserialize};
use anyhow::{Result, anyhow};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use crate::config::WHISPER_MODEL_CATALOG;
use super::acceleration::{whisper_context_acceleration_for, WhisperCompiledBackend};

// Shared with the frontend; defined once in
// `crate::transcription_models` and re-exported here for the existing
// `whisper_engine::ModelStatus` path.
pub use crate::transcription_models::ModelStatus;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WhisperModelInfo {
    pub name: String,
    pub path: PathBuf,
    pub size_mb: u32,
    pub accuracy: String,
    pub speed: String,
    #[specta(type = crate::json::Json)]
    pub status: ModelStatus,
    pub description: String,
}

pub struct WhisperEngine {
    models_dir: PathBuf,
    // Wrapped in `Arc` so a handle can be cloned out from under the read lock and
    // moved into `spawn_blocking` for the (multi-second, blocking) inference call,
    // releasing the lock so load/unload aren't blocked for the whole transcription.
    current_context: Arc<RwLock<Option<Arc<WhisperContext>>>>,
    current_model: Arc<RwLock<Option<String>>>,
    available_models: Arc<RwLock<HashMap<String, WhisperModelInfo>>>,
    // State tracking for smart logging
    last_transcription_was_short: Arc<RwLock<bool>>,
    short_audio_warning_logged: Arc<RwLock<bool>>,
    // Performance optimization: reduce logging frequency
    transcription_count: Arc<RwLock<u64>>,
    // Download cancellation tracking
    cancel_download_flag: Arc<RwLock<Option<String>>>, // Model name being cancelled
    // Active downloads tracking to prevent concurrent downloads
    active_downloads: Arc<RwLock<HashSet<String>>>, // Set of models currently being downloaded
    // Wall-clock of the last transcription, for the idle-unload watcher.
    last_used: Arc<RwLock<std::time::Instant>>,
    /// Tail of the last successful transcript for `initial_prompt` continuity.
    /// Cleared via [`Self::reset_segment_context`] at recording/job boundaries so
    /// prompts never leak across meetings.
    last_segment_text: Arc<RwLock<String>>,
}

/// A model-context snapshot used for bounded, post-recording vocabulary
/// comparisons. Holding the `Arc` keeps the model alive without blocking the
/// live transcription worker or preventing the global engine from unloading.
pub struct VocabularyLearningDecoder {
    context: Arc<WhisperContext>,
    beam_size: usize,
    temperature: f32,
}

pub struct VocabularyLearningPrompt {
    pub initial_prompt: Option<String>,
    pub preferred_terms: Vec<String>,
}

impl VocabularyLearningDecoder {
    pub async fn transcribe(
        &self,
        audio_data: Arc<Vec<f32>>,
        language: String,
        initial_prompt: Option<String>,
    ) -> Result<(String, f32)> {
        let context = Arc::clone(&self.context);
        let beam_size = self.beam_size;
        let temperature = self.temperature;
        tokio::task::spawn_blocking(move || {
            WhisperEngine::run_full_blocking(
                &context,
                &audio_data,
                Some(language),
                beam_size,
                temperature,
                initial_prompt,
            )
        })
        .await
        .map_err(|error| anyhow!("Vocabulary comparison task failed: {error}"))?
    }
}

impl WhisperEngine {
    /// Drop prior-segment prompt context (call at recording start / retranscribe start).
    pub async fn reset_segment_context(&self) {
        self.last_segment_text.write().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::WhisperEngine;

    #[test]
    fn token_confidence_uses_model_probabilities_not_text_length() {
        let short_utterance = WhisperEngine::token_confidence(&[0.92], 0.02).unwrap();
        let long_hallucination = WhisperEngine::token_confidence(&[0.18; 20], 0.65).unwrap();

        assert!(short_utterance > 0.8);
        assert!(long_hallucination < 0.1);
    }

    #[test]
    fn token_confidence_ignores_invalid_values_and_clamps_inputs() {
        let confidence = WhisperEngine::token_confidence(&[f32::NAN, 1.4, -0.2], -1.0).unwrap();

        assert!((confidence - 0.5).abs() < f32::EPSILON);
        assert_eq!(WhisperEngine::token_confidence(&[f32::NAN], 0.0), None);
    }
}

impl WhisperEngine {
    /// Detect available GPU acceleration capabilities
    fn detect_gpu_acceleration() -> bool {
        match WhisperCompiledBackend::current() {
            WhisperCompiledBackend::Metal => {
                log::info!("macOS detected - attempting to enable Metal GPU acceleration");
                true
            }
            WhisperCompiledBackend::Cuda => {
                log::info!("CUDA feature enabled - attempting GPU acceleration");
                true
            }
            WhisperCompiledBackend::Vulkan => {
                log::info!("Vulkan feature enabled - attempting GPU acceleration");
                true
            }
            WhisperCompiledBackend::HipBlas => {
                log::info!("HIP BLAS feature enabled - attempting GPU acceleration");
                true
            }
            WhisperCompiledBackend::Cpu => {
                log::info!("No GPU acceleration features detected - using CPU processing");
                false
            }
        }
    }

    pub fn new() -> Result<Self> {
        Self::new_with_models_dir(None)
    }

    /// Create a new WhisperEngine with optional custom models directory
    /// If models_dir is None, uses default location (app data dir for production, local for dev)
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        // PERFORMANCE: Suppress verbose whisper.cpp and Metal logs
        // These C library logs bypass Rust logging and clutter output
        // Set environment variables to reduce C library verbosity
        std::env::set_var("GGML_METAL_LOG_LEVEL", "1"); // 0=off, 1=error, 2=warn, 3=info
        std::env::set_var("WHISPER_LOG_LEVEL", "1");    // Reduce whisper.cpp verbosity

        let models_dir = if let Some(dir) = models_dir {
            // Use provided directory (for production with app_data_dir)
            dir
        } else {
            // Fallback: determine based on debug/release mode
            let current_dir = std::env::current_dir()
                .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;

            // Development: Use app/models
            // Production: Use system directories (should be overridden by caller)
            if cfg!(debug_assertions) {
                if current_dir.join("models").exists() {
                    current_dir.join("models")
                } else if current_dir.join("../models").exists() {
                    current_dir.join("../models")
                } else {
                    // Create models directory in current directory for development
                    current_dir.join("models")
                }
            } else {
                // Production mode fallback (shouldn't reach here, caller should provide path)
                log::warn!("WhisperEngine: No models directory provided, using fallback path");
                dirs::data_dir()
                    .or_else(|| dirs::home_dir())
                    .ok_or_else(|| anyhow!("Could not find system data directory"))?
                    .join("muesly")
                    .join("models")
            }
        };
        
        log::info!("WhisperEngine using models directory: {}", models_dir.display());
        log::info!("Debug mode: {}", cfg!(debug_assertions));

        // Log acceleration capabilities
        let gpu_support = Self::detect_gpu_acceleration();
        log::info!("Hardware acceleration support: {}", if gpu_support { "enabled" } else { "disabled" });

        #[cfg(feature = "metal")]
        log::info!("Apple Metal GPU support: enabled");

        #[cfg(feature = "openblas")]
        log::info!("OpenBLAS CPU optimization: enabled");

        #[cfg(feature = "coreml")]
        log::info!("Apple CoreML support: enabled");

        #[cfg(feature = "cuda")]
        log::info!("NVIDIA CUDA support: enabled");

        #[cfg(feature = "vulkan")]
        log::info!("Vulkan GPU support: enabled");

        #[cfg(feature = "openmp")]
        log::info!("OpenMP parallel processing: enabled");
        
        let engine = Self {
            models_dir,
            current_context: Arc::new(RwLock::new(None)),
            current_model: Arc::new(RwLock::new(None)),
            available_models: Arc::new(RwLock::new(HashMap::new())),
            // Initialize state tracking
            last_transcription_was_short: Arc::new(RwLock::new(false)),
            short_audio_warning_logged: Arc::new(RwLock::new(false)),
            // Performance optimization: reduce logging frequency
            transcription_count: Arc::new(RwLock::new(0)),
            // Initialize cancellation tracking
            cancel_download_flag: Arc::new(RwLock::new(None)),
            // Initialize active downloads tracking
            active_downloads: Arc::new(RwLock::new(HashSet::new())),
            last_used: Arc::new(RwLock::new(std::time::Instant::now())),
            last_segment_text: Arc::new(RwLock::new(String::new())),
        };
        
        Ok(engine)
    }
    
    pub async fn discover_models(&self) -> Result<Vec<WhisperModelInfo>> {
        let models_dir = &self.models_dir;
        let mut models = Vec::new();
        // Use centralized model catalog from config.rs
        let model_configs = WHISPER_MODEL_CATALOG;

        for &(name, filename, size_mb, accuracy, speed, description) in model_configs {
            let model_path = models_dir.join(filename);
            let status = if model_path.exists() {
                // Check if file size is reasonable (at least 1MB for a valid model)
                match std::fs::metadata(&model_path) {
                    Ok(metadata) => {
                        let file_size_bytes = metadata.len();
                        let file_size_mb = file_size_bytes / (1024 * 1024);
                        let expected_min_size_mb = (size_mb as f64 * 0.9) as u64; // Allow 90% of expected size as minimum for more accurate corruption detection

                        if file_size_mb >= expected_min_size_mb && file_size_mb > 1 {
                            // File size looks good, but let's also check if it's a valid GGML file
                            match self.validate_model_file(&model_path).await {
                                Ok(_) => ModelStatus::Available,
                                Err(_) => {
                                    log::warn!("Model file {} has correct size but appears corrupted (failed validation)",
                                             filename);
                                    ModelStatus::Corrupted {
                                        file_size: file_size_bytes,
                                        expected_min_size: (expected_min_size_mb * 1024 * 1024) as u64
                                    }
                                }
                            }
                        } else if file_size_mb > 0 {
                            // File exists but is smaller than expected
                            // Check if this model is currently being downloaded
                            let models_guard = self.available_models.read().await;
                            if let Some(existing_model) = models_guard.get(name) {
                                match &existing_model.status {
                                    ModelStatus::Downloading { progress } => {
                                        log::debug!("Model {} appears to be downloading ({} MB so far, {}% complete)",
                                                  filename, file_size_mb, progress);
                                        ModelStatus::Downloading { progress: *progress }
                                    }
                                    _ => {
                                        log::warn!("Model file {} exists but is corrupted ({} MB, expected ~{} MB)",
                                                 filename, file_size_mb, size_mb);
                                        ModelStatus::Corrupted {
                                            file_size: file_size_bytes,
                                            expected_min_size: (expected_min_size_mb * 1024 * 1024) as u64
                                        }
                                    }
                                }
                            } else {
                                log::warn!("Model file {} exists but is corrupted ({} MB, expected ~{} MB)",
                                         filename, file_size_mb, size_mb);
                                ModelStatus::Corrupted {
                                    file_size: file_size_bytes,
                                    expected_min_size: (expected_min_size_mb * 1024 * 1024) as u64
                                }
                            }
                        } else {
                            ModelStatus::Missing
                        }
                    }
                    Err(_) => ModelStatus::Missing
                }
            } else {
                ModelStatus::Missing
            };
            
            let model_info = WhisperModelInfo {
                name: name.to_string(),
                path: model_path,
                size_mb: size_mb as u32,
                accuracy: accuracy.to_string(),
                speed: speed.to_string(),
                status,
                description: description.to_string(),
            };
            
            models.push(model_info);
        }
        
        // Update internal cache
        let mut available_models = self.available_models.write().await;
        available_models.clear();
        for model in &models {
            available_models.insert(model.name.clone(), model.clone());
        }
        
        Ok(models)
    }
    
    pub async fn load_model(&self, model_name: &str) -> Result<()> {
        let models = self.available_models.read().await;
        let model_info = models.get(model_name)
            .ok_or_else(|| anyhow!("Model {} not found", model_name))?;

        match model_info.status {
            ModelStatus::Available => {
                // FIX 5: Check if this model is already loaded
                if let Some(current_model) = self.current_model.read().await.as_ref() {
                    if current_model == model_name {
                        log::info!("Model {} is already loaded, skipping reload", model_name);
                        return Ok(());
                    }

                    // FIX 5: Unload current model before loading new one
                    log::info!("Unloading current model '{}' before loading '{}'", current_model, model_name);
                    self.unload_model().await;
                }

                log::info!("Loading model: {}", model_name);

                // PERFORMANCE OPTIMIZATION: Use comprehensive hardware profile for optimal GPU configuration
                let hardware_profile = crate::audio::HardwareProfile::detect();
                let adaptive_config = hardware_profile.get_whisper_config();

                // Decide GPU/flash-attention purely from the compiled whisper backend,
                // not the runtime-detected GPU. whisper.cpp's Vulkan backend does not
                // support flash attention, so a Vulkan build must never enable it even
                // when the machine reports a CUDA/Metal-class GPU at runtime.
                let mut acceleration = whisper_context_acceleration_for(
                    WhisperCompiledBackend::current(),
                    hardware_profile.gpu_type,
                    hardware_profile.performance_tier,
                );
                if std::env::var("MUESLY_WHISPER_FORCE_CPU").as_deref() == Ok("1") {
                    log::warn!(
                        "MUESLY_WHISPER_FORCE_CPU=1: bypassing {} GPU context allocation",
                        acceleration.compiled_backend.as_str()
                    );
                    acceleration = acceleration.forced_cpu();
                }

                let context_param = WhisperContextParameters {
                    use_gpu: acceleration.use_gpu,
                    gpu_device: acceleration.gpu_device,
                    flash_attn: acceleration.flash_attn,
                    ..Default::default()
                };

                log::info!(
                    "Whisper acceleration decision: compiled_backend={} runtime_detected_gpu={:?} use_gpu={} flash_attn={} gpu_device={}",
                    acceleration.compiled_backend.as_str(),
                    acceleration.runtime_detected_gpu,
                    acceleration.use_gpu,
                    acceleration.flash_attn,
                    acceleration.gpu_device,
                );

                let model_path = model_info.path.to_string_lossy().to_string();

                // Load whisper context with hardware-optimized parameters. If GPU
                // loading fails (missing/broken driver, incompatible flash-attn), fall
                // back to CPU once instead of leaving the user with no usable model.
                let ctx = match WhisperContext::new_with_params(&model_path, context_param) {
                    Ok(ctx) => ctx,
                    Err(e) if acceleration.use_gpu => {
                        log::warn!(
                            "Failed to load model {} with GPU acceleration ({}); retrying on CPU",
                            model_name, e
                        );
                        let cpu_params = WhisperContextParameters {
                            use_gpu: false,
                            gpu_device: 0,
                            flash_attn: false,
                            ..Default::default()
                        };
                        WhisperContext::new_with_params(&model_path, cpu_params).map_err(|e| {
                            anyhow!("Failed to load model {} on CPU after GPU failure: {}", model_name, e)
                        })?
                    }
                    Err(e) => return Err(anyhow!("Failed to load model {}: {}", model_name, e)),
                };

                // Update current context and model
                *self.current_context.write().await = Some(Arc::new(ctx));
                *self.current_model.write().await = Some(model_name.to_string());

                // Enhanced acceleration status reporting
                let acceleration_status = acceleration.status_label();

                log::info!("Successfully loaded model: {} with {} (Performance Tier: {:?}, Beam Size: {}, Threads: {:?})",
                          model_name, acceleration_status, hardware_profile.performance_tier,
                          adaptive_config.beam_size, adaptive_config.max_threads);
                Ok(())
            },
            ModelStatus::Missing => {
                Err(anyhow!("Model {} is not downloaded", model_name))
            },
            ModelStatus::Downloading { .. } => {
                Err(anyhow!("Model {} is currently downloading", model_name))
            },
            ModelStatus::Error(ref err) => {
                Err(anyhow!("Model {} has error: {}", model_name, err))
            },
            ModelStatus::Corrupted { .. } => {
                Err(anyhow!("Model {} is corrupted and cannot be loaded", model_name))
            }
        }
    }

    pub async fn unload_model(&self) -> bool  {
        let mut ctx_guard = self.current_context.write().await;
        let unloaded = ctx_guard.take().is_some();
        if unloaded {
            log::info!("📉Whisper model unloaded");
        }

        let mut model_name_guard = self.current_model.write().await;
        model_name_guard.take();

        unloaded
    }

    pub async fn get_current_model(&self) -> Option<String> {
        self.current_model.read().await.clone()
    }
    
    pub async fn is_model_loaded(&self) -> bool {
        self.current_context.read().await.is_some()
    }

    /// How long since the last transcription started.
    pub async fn idle_for(&self) -> std::time::Duration {
        self.last_used.read().await.elapsed()
    }

    // Enhanced function to clean repetitive text patterns and meaningless outputs
    fn clean_repetitive_text(text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }

        // Check for obviously meaningless patterns first
        if Self::is_meaningless_output(text) {
            // Performance optimization: reduce meaningless output logging to debug level
            perf_debug!("Detected meaningless output, returning empty: '{}'", text);
            return String::new();
        }

        let words: Vec<&str> = text.split_whitespace().collect();
        if words.len() < 3 {
            return text.to_string();
        }

        // Enhanced repetition detection with sliding window
        let cleaned_words = Self::remove_word_repetitions(&words);

        // Remove phrase repetitions with more sophisticated detection
        let cleaned_words = Self::remove_phrase_repetitions(&cleaned_words);

        // Check for overall repetition ratio
        let final_text = cleaned_words.join(" ");
        if Self::calculate_repetition_ratio(&final_text) > 0.7 {
            // Performance optimization: reduce repetition ratio logging to debug level
            perf_debug!("High repetition ratio detected, filtering out: '{}'", final_text);
            return String::new();
        }

        final_text
    }

    // Check for obviously meaningless patterns
    fn is_meaningless_output(text: &str) -> bool {
        let text_lower = text.to_lowercase();

        // Check for common meaningless patterns
        let meaningless_patterns = [
            "thank you for watching",
            "thanks for watching",
            "like and subscribe",
            "music playing",
            "applause",
            "laughter",
            "um um um",
            "uh uh uh",
            "ah ah ah",
        ];

        for pattern in &meaningless_patterns {
            if text_lower.contains(pattern) {
                return true;
            }
        }

        // Check if text is mostly the same character or very short repetitive patterns
        let unique_chars: HashSet<char> = text.chars().collect();
        if unique_chars.len() <= 3 && text.len() > 10 {
            return true;
        }

        false
    }

    // Enhanced word repetition removal
    fn remove_word_repetitions<'a>(words: &'a [&'a str]) -> Vec<&'a str> {
        let mut cleaned_words = Vec::new();
        let mut i = 0;

        while i < words.len() {
            let current_word = words[i];
            let mut repeat_count = 1;

            // Count consecutive repetitions of the same word
            while i + repeat_count < words.len() && words[i + repeat_count] == current_word {
                repeat_count += 1;
            }

            // Be more aggressive: if word is repeated 2+ times, only keep one instance
            if repeat_count >= 2 {
                cleaned_words.push(current_word);
                i += repeat_count;
            } else {
                cleaned_words.push(current_word);
                i += 1;
            }
        }

        cleaned_words
    }

    // Enhanced phrase repetition removal with variable length detection
    fn remove_phrase_repetitions<'a>(words: &'a [&'a str]) -> Vec<&'a str> {
        if words.len() < 4 {
            return words.to_vec();
        }

        let mut final_words = Vec::new();
        let mut i = 0;

        while i < words.len() {
            let mut phrase_found = false;

            // Check for 2-word to 5-word phrase repetitions
            for phrase_len in 2..=std::cmp::min(5, (words.len() - i) / 2) {
                if i + phrase_len * 2 <= words.len() {
                    let phrase1 = &words[i..i + phrase_len];
                    let phrase2 = &words[i + phrase_len..i + phrase_len * 2];

                    if phrase1 == phrase2 {
                        // Add the phrase once and skip the repetition
                        final_words.extend_from_slice(phrase1);
                        i += phrase_len * 2;
                        phrase_found = true;
                        break;
                    }
                }
            }

            if !phrase_found {
                final_words.push(words[i]);
                i += 1;
            }
        }

        final_words
    }

    // Calculate repetition ratio in text
    fn calculate_repetition_ratio(text: &str) -> f32 {
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.len() < 4 {
            return 0.0;
        }

        let mut word_counts = HashMap::new();
        for word in &words {
            *word_counts.entry(word.to_lowercase()).or_insert(0) += 1;
        }

        let total_words = words.len() as f32;
        let repeated_words: usize = word_counts.values().map(|&count| if count > 1 { count - 1 } else { 0 }).sum();

        repeated_words as f32 / total_words
    }
    
    /// Apply the whisper decoding parameters common to every pass.
    ///
    /// Everything except language selection and translation is identical across
    /// passes, so it lives here. Language/`set_translate` are set by the caller
    /// before this is invoked, because `FullParams` borrows the language string
    /// and that borrow must outlive the `state.full(..)` call.
    fn apply_common_params(params: &mut FullParams, temperature: f32) {
        // Disable timestamp tokens to prevent whisper.cpp chunking heuristics that
        // incorrectly discard complete, valid transcriptions.
        params.set_no_timestamps(true);
        params.set_token_timestamps(true);

        // Disable all whisper.cpp internal printing to reduce C library log spam.
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_temperature(temperature);
        params.set_max_initial_ts(1.0);
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);
        // 0.55 balances hallucination prevention against preserving quiet speech.
        params.set_no_speech_thold(0.55);
        params.set_max_len(200);
        params.set_single_segment(false);
    }

    /// Collect and clean the transcript from a finished whisper state.
    ///
    /// Shared by both passes (the detect pass and the forced re-transcribe pass)
    /// so segment collection and genuine token-confidence aggregation are not
    /// duplicated. Returns the cleaned transcript and an average confidence.
    fn collect_segments(state: &WhisperState) -> Result<(String, f32)> {
        let num_segments = state.full_n_segments();

        let mut result = String::new();
        let mut total_confidence = 0.0f32;
        let mut segment_count = 0u32;

        for i in 0..num_segments {
            let Some(segment) = state.get_segment(i) else {
                continue;
            };
            let segment_text = match segment.to_str_lossy() {
                Ok(text) => text.into_owned(),
                Err(_) => continue,
            };

            let token_probabilities: Vec<f32> = (0..segment.n_tokens())
                .filter_map(|token_index| segment.get_token(token_index))
                .map(|token| token.token_probability())
                .collect();
            if let Some(confidence) = Self::token_confidence(
                &token_probabilities,
                segment.no_speech_probability(),
            ) {
                total_confidence += confidence;
                segment_count += 1;
            }

            let cleaned_text = segment_text.trim();
            if !cleaned_text.is_empty() {
                if !result.is_empty() {
                    result.push(' ');
                }
                result.push_str(cleaned_text);
            }
        }

        let final_result = result.trim().to_string();
        let cleaned_result = Self::clean_repetitive_text(&final_result);

        let avg_confidence = if segment_count > 0 {
            total_confidence / segment_count as f32
        } else {
            0.0
        };

        Ok((cleaned_result, avg_confidence))
    }

    /// Whisper's safe API exposes token probabilities and a per-segment
    /// no-speech probability. Combine those signals without inventing certainty
    /// from transcript length: short, correct utterances can now score just as
    /// highly as longer sentences.
    fn token_confidence(token_probabilities: &[f32], no_speech_probability: f32) -> Option<f32> {
        let probabilities: Vec<f32> = token_probabilities
            .iter()
            .copied()
            .filter(|probability| probability.is_finite())
            .map(|probability| probability.clamp(0.0, 1.0))
            .collect();
        if probabilities.is_empty() {
            return None;
        }
        let average = probabilities.iter().sum::<f32>() / probabilities.len() as f32;
        Some(average * (1.0 - no_speech_probability.clamp(0.0, 1.0)))
    }

    /// Synchronous whisper inference shared by both transcribe entry points.
    ///
    /// `state.full` blocks for seconds (CPU/GPU bound), so this MUST be run via
    /// `tokio::task::spawn_blocking`, never directly on an async worker. `FullParams`
    /// borrows the language string, so params are built here from owned data rather
    /// than passed in. Returns the cleaned transcript and an average confidence.
    ///
    /// Language modes:
    /// - explicit ISO code: a single pass forced to that code (unchanged).
    /// - `auto-translate`: a single pass with `set_language(None)` +
    ///   `set_translate(true)`. The output is always English regardless of the
    ///   spoken language, so there is nothing to keep stable: no `lang_lock`
    ///   involvement, no second pass.
    /// - `auto` (keep original language): an adaptive two-phase scheme. Pass 1
    ///   always auto-detects (`set_language(None)`, no translate). The detected
    ///   id is fed to `lang_lock::resolve_detection`, which returns either
    ///   `UseDetected` (emit pass 1) or `ForceStable(id)` (run a second pass
    ///   forced to the stable language). The second pass only runs on a genuine
    ///   disagreement, so steady single-language audio stays at one pass.
    fn run_full_blocking(
        ctx: &WhisperContext,
        audio_data: &[f32],
        language: Option<String>,
        beam_size: usize,
        temperature: f32,
        initial_prompt: Option<String>,
    ) -> Result<(String, f32)> {
        // Run one whisper pass with a given language selection / translate flag and
        // return the finished state. A fresh state per pass keeps the forced
        // re-transcribe independent of the detect pass. The state is returned (not
        // its transcript) so the detect pass can both read the detected language id
        // and collect segments from the SAME pass without re-running inference.
        let run_pass_state = |lang: Option<&str>, translate: bool| -> Result<WhisperState> {
            let mut params = FullParams::new(SamplingStrategy::BeamSearch {
                beam_size: beam_size as i32,
                patience: 1.0,
            });
            if let Some(prompt) = initial_prompt.as_deref() {
                params.set_initial_prompt(prompt);
            }
            params.set_language(lang);
            params.set_translate(translate);
            Self::apply_common_params(&mut params, temperature);

            let mut state = ctx.create_state()?;
            state.full(params, audio_data)?;
            Ok(state)
        };

        let is_auto = matches!(language.as_deref(), Some("auto") | Some("auto-translate") | None);
        let should_translate = matches!(language.as_deref(), Some("auto-translate"));

        // Explicit code path, byte-for-byte unchanged: set code, no translate.
        if !is_auto {
            return Self::collect_segments(&run_pass_state(language.as_deref(), false)?);
        }

        // auto-translate: detect + translate to English in one pass. The output is
        // English regardless of the spoken language, so the adaptive lang lock
        // (which exists to keep the ORIGINAL language stable) does not apply.
        if should_translate {
            return Self::collect_segments(&run_pass_state(None, true)?);
        }

        // auto (keep original language): pass 1 always auto-detects.
        let state = run_pass_state(None, false)?;

        // `full_lang_id_from_state` is only meaningful after a `full(..)` that ran
        // with `set_language(None)`. It returns -1 when there is no detection.
        let detected_id = state.full_lang_id_from_state();
        let prev_stable = super::lang_lock::current_stable();
        let decision = super::lang_lock::resolve_detection(detected_id, audio_data.len());

        match decision {
            super::lang_lock::LangDecision::UseDetected => {
                // Log once when the stable language first locks or actually switches
                // old -> new; per-segment churn stays on the perf_debug hot path.
                let new_stable = super::lang_lock::current_stable();
                if new_stable != prev_stable {
                    if let Some(id) = new_stable {
                        log::info!(
                            "Auto-detect stable language {} -> {} (id {})",
                            prev_stable
                                .and_then(whisper_rs::get_lang_str)
                                .unwrap_or("none"),
                            whisper_rs::get_lang_str(id).unwrap_or("unknown"),
                            id
                        );
                    }
                } else {
                    perf_debug!(
                        "Auto-detected language id {} ({} samples), used as-is",
                        detected_id,
                        audio_data.len()
                    );
                }
                Self::collect_segments(&state)
            }
            super::lang_lock::LangDecision::ForceStable(id) => {
                // A short/odd disagreement: re-transcribe forced to the stable
                // language rather than emit the flapped detection. Drop pass 1's
                // state before the second pass; a fresh pass runs pinned to `id`.
                drop(state);
                perf_debug!(
                    "Auto-detect forcing stable language id {} (segment detected {})",
                    id,
                    detected_id
                );
                Self::collect_segments(&run_pass_state(whisper_rs::get_lang_str(id), false)?)
            }
        }
    }

    /// Transcribe audio with streaming support for partial results and adaptive quality
    pub async fn transcribe_audio_with_confidence(&self, audio_data: Vec<f32>, language: Option<String>) -> Result<(String, f32, bool)> {
        let (text, confidence, is_partial, _) = self
            .transcribe_audio_with_learning_context(Arc::new(audio_data), language)
            .await?;
        Ok((text, confidence, is_partial))
    }

    /// The live decode plus the exact prior-segment prompt used for it. The
    /// latter lets background vocabulary learning remove only the candidate
    /// term while preserving every other piece of decode context.
    pub async fn transcribe_audio_with_learning_context(
        &self,
        audio_data: Arc<Vec<f32>>,
        language: Option<String>,
    ) -> Result<(String, f32, bool, VocabularyLearningPrompt)> {
        *self.last_used.write().await = std::time::Instant::now();
        // Clone the context handle and release the read lock before the blocking
        // inference, so load/unload aren't blocked for the whole transcription.
        let ctx = {
            let ctx_lock = self.current_context.read().await;
            ctx_lock
                .as_ref()
                .ok_or_else(|| anyhow!("No model loaded. Please load a model first."))?
                .clone()
        };

        // Get adaptive configuration based on hardware
        let hardware_profile = crate::audio::HardwareProfile::detect();
        let adaptive_config = hardware_profile.get_whisper_config();
        let beam_size = adaptive_config.beam_size;
        let temperature = adaptive_config.temperature;

        let duration_seconds = audio_data.len() as f64 / 16000.0;
        let is_partial = duration_seconds < 15.0; // Consider chunks under 15s as partial

        let vocab = crate::vocabulary::whisper_initial_prompt();
        let prior = {
            let prev = self.last_segment_text.read().await;
            super::decode_policy::prior_segment_prompt(&prev, 224)
        };
        let initial_prompt =
            super::decode_policy::merge_initial_prompt(vocab.as_deref(), prior.as_deref());
        let learning_prompt = VocabularyLearningPrompt {
            initial_prompt: initial_prompt.clone(),
            preferred_terms: crate::vocabulary::learnable_preferred_terms(),
        };

        // Same temperature ladder family as offline `transcribe_audio`.
        // Arc the buffer so ladder retries don't deep-copy the audio per pass.
        let mut temperature = temperature;
        let (cleaned_result, avg_confidence) = loop {
            let ctx_c = ctx.clone();
            let audio_c = std::sync::Arc::clone(&audio_data);
            let lang_c = language.clone();
            let prompt_c = initial_prompt.clone();
            let temp = temperature;
            let beam = beam_size;
            let (text, conf) = tokio::task::spawn_blocking(move || {
                Self::run_full_blocking(&ctx_c, &audio_c, lang_c, beam, temp, prompt_c)
            })
            .await
            .map_err(|e| anyhow!("Transcription task failed: {}", e))??;
            let cleaned = crate::vocabulary::apply_cached_corrections(&text);
            if !super::decode_policy::should_retry_decode(&cleaned, 1) {
                break (cleaned, conf);
            }
            match super::decode_policy::next_temperature(temperature) {
                Some(next) => {
                    log::debug!(
                        "Live Whisper empty decode at temp {}; retrying at {}",
                        temperature,
                        next
                    );
                    temperature = next;
                }
                None => break (cleaned, conf),
            }
        };
        if !cleaned_result.trim().is_empty() {
            *self.last_segment_text.write().await = cleaned_result.clone();
        }

        Ok((cleaned_result, avg_confidence, is_partial, learning_prompt))
    }

    pub async fn prepare_vocabulary_learning_decoder(
        &self,
    ) -> Result<VocabularyLearningDecoder> {
        let context = {
            let ctx_lock = self.current_context.read().await;
            ctx_lock
                .as_ref()
                .ok_or_else(|| anyhow!("No model loaded. Please load a model first."))?
                .clone()
        };
        let adaptive_config = crate::audio::HardwareProfile::detect().get_whisper_config();
        Ok(VocabularyLearningDecoder {
            context,
            beam_size: adaptive_config.beam_size,
            temperature: adaptive_config.temperature,
        })
    }

    pub async fn transcribe_audio(&self, audio_data: Vec<f32>, language: Option<String>) -> Result<String> {
        *self.last_used.write().await = std::time::Instant::now();
        // Clone the context handle and release the read lock before blocking inference.
        let ctx = {
            let ctx_lock = self.current_context.read().await;
            ctx_lock
                .as_ref()
                .ok_or_else(|| anyhow!("No model loaded. Please load a model first."))?
                .clone()
        };

        // Get adaptive configuration based on hardware
        let hardware_profile = crate::audio::HardwareProfile::detect();
        let adaptive_config = hardware_profile.get_whisper_config();
        let beam_size = adaptive_config.beam_size;
        // Preferred temperature; empty results climb the ladder (see decode_policy).
        let mut temperature = 0.0f32;

        let duration_seconds = audio_data.len() as f64 / 16000.0; // Assuming 16kHz
        let is_short_audio = duration_seconds < 1.0;

        // Smart logging based on audio duration and previous states
        let mut should_log_transcription = true;
        let mut should_log_short_warning = false;

        if is_short_audio {
            let last_was_short = *self.last_transcription_was_short.read().await;
            let warning_logged = *self.short_audio_warning_logged.read().await;

            if !warning_logged {
                should_log_short_warning = true;
                *self.short_audio_warning_logged.write().await = true;
            }

            // Only log transcription start if it's the first short audio or previous wasn't short
            should_log_transcription = !last_was_short;

            *self.last_transcription_was_short.write().await = true;
        } else {
            let last_was_short = *self.last_transcription_was_short.read().await;

            // Always log when transitioning from short to normal audio
            if last_was_short {
                log::info!("Audio duration normalized, resuming transcription");
                *self.short_audio_warning_logged.write().await = false;
            }

            *self.last_transcription_was_short.write().await = false;
        }

        if should_log_short_warning {
            log::warn!("Audio duration is short ({:.1}s < 1.0s). Consider padding the input audio with silence. Further short audio warnings will be suppressed.", duration_seconds);
        }

        // Performance optimization: reduce transcription start logging frequency
        let transcription_count = {
            let mut count = self.transcription_count.write().await;
            *count += 1;
            *count
        };

        // Only log every 10th transcription or significant audio (>10s) to reduce I/O overhead
        if should_log_transcription && (transcription_count % 10 == 0 || duration_seconds > 10.0) {
            log::info!("Starting transcription #{} of {} samples ({:.1}s duration)",
                      transcription_count, audio_data.len(), duration_seconds);
        }

        let vocab = crate::vocabulary::whisper_initial_prompt();
        let prior = {
            let prev = self.last_segment_text.read().await;
            super::decode_policy::prior_segment_prompt(&prev, 224)
        };
        let initial_prompt =
            super::decode_policy::merge_initial_prompt(vocab.as_deref(), prior.as_deref());

        // Temperature ladder: retry empty/near-empty decodes with warmer settings.
        // Arc the buffer so ladder retries don't deep-copy the audio per pass.
        let audio_data = std::sync::Arc::new(audio_data);
        let cleaned_result = loop {
            let ctx_c = ctx.clone();
            let audio_c = std::sync::Arc::clone(&audio_data);
            let lang_c = language.clone();
            let prompt_c = initial_prompt.clone();
            let temp = temperature;
            let (text, _conf) = tokio::task::spawn_blocking(move || {
                Self::run_full_blocking(&ctx_c, &audio_c, lang_c, beam_size, temp, prompt_c)
            })
            .await
            .map_err(|e| anyhow!("Transcription task failed: {}", e))??;
            let cleaned = crate::vocabulary::apply_cached_corrections(&text);
            if !super::decode_policy::should_retry_decode(&cleaned, 1) {
                break cleaned;
            }
            match super::decode_policy::next_temperature(temperature) {
                Some(next) => {
                    log::debug!(
                        "Whisper empty decode at temp {}; retrying at {}",
                        temperature,
                        next
                    );
                    temperature = next;
                }
                None => break cleaned,
            }
        };
        if !cleaned_result.trim().is_empty() {
            *self.last_segment_text.write().await = cleaned_result.clone();
        }

        // Performance optimization: smart logging for transcription results
        if cleaned_result.is_empty() {
            // Only log empty results occasionally to reduce spam
            if should_log_transcription && transcription_count % 20 == 0 {
                perf_debug!("Transcription #{} result is empty - no speech detected", transcription_count);
            }
        } else {
            // Reduce successful transcription logging frequency
            // Only log every 5th result or significant results (>50 chars) to reduce I/O overhead
            if transcription_count % 5 == 0 || cleaned_result.len() > 50 || duration_seconds > 10.0 {
                log::info!(
                    "Transcription #{} completed ({} characters)",
                    transcription_count,
                    cleaned_result.chars().count()
                );
            } else {
                perf_debug!(
                    "Transcription #{} completed ({} characters)",
                    transcription_count,
                    cleaned_result.chars().count()
                );
            }
        }

        Ok(cleaned_result)
    }
    
    pub async fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }

    /// Validate if a model file is a valid GGML file by checking its header
    async fn validate_model_file(&self, model_path: &PathBuf) -> Result<()> {
        use tokio::io::AsyncReadExt;

        let mut file = fs::File::open(model_path).await
            .map_err(|e| anyhow!("Failed to open model file: {}", e))?;

        // Read the first 8 bytes to check for GGML magic number
        let mut buffer = [0u8; 8];
        file.read_exact(&mut buffer).await
            .map_err(|e| anyhow!("Failed to read model file header: {}", e))?;

        // Check for GGML magic number (various versions and endianness)
        if buffer.starts_with(b"ggml") || buffer.starts_with(b"GGUF") || buffer.starts_with(b"ggmf") ||
           buffer.starts_with(b"lmgg") || buffer.starts_with(b"FUGU") || buffer.starts_with(b"fmgg") {
            Ok(())
        } else {
            Err(anyhow!("Invalid model file: missing GGML/GGUF magic number. Found: {:?}",
                       String::from_utf8_lossy(&buffer[..4])))
        }
    }

    pub async fn delete_model(&self, model_name: &str) -> Result<String> {
        log::info!("Attempting to delete model: {}", model_name);

        // Get model info to find the file path
        let model_info = {
            let models = self.available_models.read().await;
            models.get(model_name).cloned()
        };

        let model_info = model_info.ok_or_else(|| anyhow!("Model '{}' not found", model_name))?;

        // Check if model is corrupted before allowing deletion
        log::info!("Model '{}' has status: {:?}", model_name, model_info.status);
        match &model_info.status {
            ModelStatus::Corrupted { file_size, expected_min_size } => {
                log::info!("Deleting corrupted model '{}' (file size: {} bytes, expected min: {} bytes)",
                          model_name, file_size, expected_min_size);

                // Delete the file
                if model_info.path.exists() {
                    fs::remove_file(&model_info.path).await
                        .map_err(|e| anyhow!("Failed to delete file '{}': {}", model_info.path.display(), e))?;
                    log::info!("Successfully deleted corrupted file: {}", model_info.path.display());
                } else {
                    log::warn!("File '{}' does not exist, nothing to delete", model_info.path.display());
                }

                // Update model status to Missing
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model) = models.get_mut(model_name) {
                        model.status = ModelStatus::Missing;
                    }
                }

                Ok(format!("Successfully deleted corrupted model '{}'", model_name))
            }
            ModelStatus::Available => {
                // Allow deletion of available models for testing/cleanup
                log::info!("Deleting available model '{}' (for cleanup)", model_name);

                if model_info.path.exists() {
                    fs::remove_file(&model_info.path).await
                        .map_err(|e| anyhow!("Failed to delete file '{}': {}", model_info.path.display(), e))?;
                    log::info!("Successfully deleted available model file: {}", model_info.path.display());
                } else {
                    log::warn!("File '{}' does not exist, nothing to delete", model_info.path.display());
                }

                // Update model status to Missing
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model) = models.get_mut(model_name) {
                        model.status = ModelStatus::Missing;
                    }
                }

                Ok(format!("Successfully deleted model '{}'", model_name))
            }
            _ => {
                Err(anyhow!("Can only delete corrupted or available models. Model '{}' has status: {:?}", model_name, model_info.status))
            }
        }
    }
    
    pub async fn download_model(&self, model_name: &str, progress_callback: Option<Box<dyn Fn(u8) + Send>>) -> Result<()> {
        log::info!("Starting download for model: {}", model_name);

        // Check if download is already in progress for this model
        {
            let active = self.active_downloads.read().await;
            if active.contains(model_name) {
                log::warn!("Download already in progress for model: {}", model_name);
                return Err(anyhow!("Download already in progress for model: {}", model_name));
            }
        }

        // Add to active downloads
        {
            let mut active = self.active_downloads.write().await;
            active.insert(model_name.to_string());
        }

        // Clear any previous cancellation flag for this model
        {
            let mut cancel_flag = self.cancel_download_flag.write().await;
            *cancel_flag = None;
        }

        // Official ggerganov/whisper.cpp model URLs from Hugging Face
        let model_url = match model_name {
            // Standard f16 models
            "tiny" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
            "base" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
            "small" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
            "medium" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
            "large-v3-turbo" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
            "large-v3" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",

            // Q5_1 quantized models
            "tiny-q5_1" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin",
            "base-q5_1" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
            "small-q5_1" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",

            // Q5_0 quantized models
            "medium-q5_0" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
            "large-v3-turbo-q5_0" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
            "large-v3-q5_0" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",

            _ => return Err(anyhow!("Unsupported model: {}", model_name))
        };
        
        log::info!("Model URL for {}: {}", model_name, model_url);
        
        // Generate correct filename - all models follow ggml-{model_name}.bin pattern
        let filename = format!("ggml-{}.bin", model_name);
        let file_path = self.models_dir.join(&filename);
        // Download into a `.part` file and atomically rename on success. A crash or
        // cancellation then leaves a `.part` file that `discover_models` ignores
        // (it only matches `ggml-*.bin`), instead of a truncated file at the real
        // path that could pass the header check and fail at load time.
        let part_path = self.models_dir.join(format!("{}.part", filename));

        log::info!("Downloading to file path: {} (via {})", file_path.display(), part_path.display());
        
        // Create models directory if it doesn't exist
        if !self.models_dir.exists() {
            fs::create_dir_all(&self.models_dir).await
                .map_err(|e| anyhow!("Failed to create models directory: {}", e))?;
        }
        
        // Update model status to downloading
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 0 };
            }
        }
        
        log::info!("Creating HTTP client and starting request...");
        let client = crate::providers::common::http_client();

        // Check for an existing partial file so we can resume.
        let existing_size = match fs::metadata(&part_path).await {
            Ok(m) => m.len(),
            Err(_) => 0,
        };

        // Build the request with an optional Range header for resume.
        let mut request = client.get(model_url);
        if existing_size > 0 {
            request = request.header("Range", format!("bytes={}-", existing_size));
            log::info!("Resuming Whisper download for {} from {} bytes", model_name, existing_size);
        } else {
            log::info!("Sending GET request to: {}", model_url);
        }
        let mut response = request.send().await
            .map_err(|e| anyhow!("Failed to start download: {}", e))?;

        log::info!("Received response with status: {}", response.status());

        let (total_size, resuming) = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            // Server supports resume; remaining bytes come after what we already have.
            let remaining = response.content_length().unwrap_or(0);
            log::info!("Server supports resume, remaining: {} bytes", remaining);
            (existing_size + remaining, true)
        } else if response.status().is_success() {
            // Fresh download or server ignored the Range header.
            if existing_size > 0 {
                log::warn!("Server ignored Range for {}, restarting download", model_name);
            }
            (response.content_length().unwrap_or(0), false)
        } else if response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            // Stale or oversized partial: drop it and retry without Range.
            log::warn!("416 for {}; deleting partial and retrying fresh", model_name);
            let _ = fs::remove_file(&part_path).await;
            response = client.get(model_url).send().await
                .map_err(|e| anyhow!("Retry failed: {}", e))?;
            if !response.status().is_success() {
                let mut active = self.active_downloads.write().await;
                active.remove(model_name);
                return Err(anyhow!("Download failed with status: {}", response.status()));
            }
            (response.content_length().unwrap_or(0), false)
        } else {
            let mut active = self.active_downloads.write().await;
            active.remove(model_name);
            return Err(anyhow!("Download failed with status: {}", response.status()));
        };

        log::info!("Content length: {} bytes ({:.1} MB)", total_size, total_size as f64 / (1024.0 * 1024.0));

        if total_size == 0 {
            log::warn!("Content length is 0 or unknown - download may not show accurate progress");
        }

        // Disk-space preflight (best-effort: skip the check if free space is unknown).
        const DOWNLOAD_SPACE_MARGIN: u64 = 256 * 1024 * 1024; // 256 MB headroom
        if total_size > 0 {
            if let Some(available) = crate::disk::available_space_for(&self.models_dir) {
                if available < total_size + DOWNLOAD_SPACE_MARGIN {
                    let mut active = self.active_downloads.write().await;
                    active.remove(model_name);
                    return Err(anyhow!(
                        "Not enough disk space to download '{}': need ~{:.1} GB, {:.1} GB free",
                        model_name,
                        (total_size + DOWNLOAD_SPACE_MARGIN) as f64 / 1_073_741_824.0,
                        available as f64 / 1_073_741_824.0
                    ));
                }
            }
        }

        let mut file = if resuming {
            fs::OpenOptions::new().append(true).open(&part_path).await
                .map_err(|e| anyhow!("Failed to open partial file for resume: {}", e))?
        } else {
            fs::File::create(&part_path).await
                .map_err(|e| anyhow!("Failed to create file: {}", e))?
        };

        log::info!("File opened at: {} (resuming: {})", part_path.display(), resuming);

        // Stream download with real progress reporting
        log::info!("Starting streaming download...");
        log::info!("Expected size: {:.1} MB", total_size as f64 / (1024.0 * 1024.0));

        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();
        let mut downloaded = if resuming { existing_size } else { 0u64 };
        let mut last_progress_report = 0u8;
        let mut last_report_time = std::time::Instant::now();

        // Emit initial 0% progress immediately
        if let Some(ref callback) = progress_callback {
            callback(0);
        }

        while let Some(chunk_result) = stream.next().await {
            // Check for cancellation before processing chunk
            {
                let cancel_flag = self.cancel_download_flag.read().await;
                if cancel_flag.as_ref() == Some(&model_name.to_string()) {
                    log::info!("Download cancelled for {}", model_name);
                    // Remove from active downloads on cancellation
                    let mut active = self.active_downloads.write().await;
                    active.remove(model_name);
                    // Drop the open handle and delete the partial file.
                    drop(file);
                    let _ = fs::remove_file(&part_path).await;
                    return Err(anyhow!("Download cancelled by user"));
                }
            }

            let chunk = chunk_result
                .map_err(|e| anyhow!("Failed to read chunk: {}", e))?;

            file.write_all(&chunk).await
                .map_err(|e| anyhow!("Failed to write chunk to file: {}", e))?;

            downloaded += chunk.len() as u64;

            // Calculate progress
            let progress = if total_size > 0 {
                ((downloaded as f64 / total_size as f64) * 100.0) as u8
            } else {
                0
            };

            // Report progress every 1% or every 2 seconds for better UI responsiveness
            let time_since_last_report = last_report_time.elapsed().as_secs();
            if progress >= last_progress_report + 1 || progress == 100 || time_since_last_report >= 2 {
                log::info!("Download progress: {}% ({:.1} MB / {:.1} MB)",
                         progress,
                         downloaded as f64 / (1024.0 * 1024.0),
                         total_size as f64 / (1024.0 * 1024.0));

                // Update progress in model info
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model_info) = models.get_mut(model_name) {
                        model_info.status = ModelStatus::Downloading { progress };
                    }
                }

                // Call progress callback
                if let Some(ref callback) = progress_callback {
                    callback(progress);
                }

                last_progress_report = progress;
                last_report_time = std::time::Instant::now();
            }
        }

        log::info!("Streaming download completed: {} bytes", downloaded);
        
        // Ensure 100% progress is always reported
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 100 };
            }
        }
        
        if let Some(ref callback) = progress_callback {
            callback(100);
        }
        
        file.flush().await
            .map_err(|e| anyhow!("Failed to flush file: {}", e))?;
        // Close the handle before renaming so all data is on disk.
        drop(file);

        // Atomically move the completed download into place.
        fs::rename(&part_path, &file_path).await
            .map_err(|e| anyhow!("Failed to finalize downloaded model: {}", e))?;

        // Fail closed: refuse models without a pinned SHA-256, delete on mismatch.
        if let Err(e) = crate::model_integrity::require_and_verify(
            &file_path,
            crate::model_integrity::whisper_model_sha256(model_name),
            &format!("whisper model '{model_name}'"),
        ) {
            let mut active = self.active_downloads.write().await;
            active.remove(model_name);
            return Err(e);
        }

        log::info!("Download completed for model: {}", model_name);

        // Update model status to available
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Available;
                model_info.path = file_path.clone();
            }
        }

        // Remove from active downloads on completion
        {
            let mut active = self.active_downloads.write().await;
            active.remove(model_name);
        }

        Ok(())
    }
    
    pub async fn cancel_download(&self, model_name: &str) -> Result<()> {
        log::info!("Cancelling download for model: {}", model_name);

        // Set cancellation flag to interrupt the download loop
        {
            let mut cancel_flag = self.cancel_download_flag.write().await;
            *cancel_flag = Some(model_name.to_string());
        }

        // Remove from active downloads
        {
            let mut active = self.active_downloads.write().await;
            active.remove(model_name);
        }

        // Update model status to Missing (so it can be retried)
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Missing;
            }
        }

        // Clean up partially downloaded files
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await; // Brief delay to let download loop detect cancellation

        // The in-progress download lives at `{filename}.part`; the download loop
        // also removes it on cancellation, but clean up here as a backstop. Remove
        // any stray final file too.
        let filename = format!("ggml-{}.bin", model_name);
        for candidate in [
            self.models_dir.join(format!("{}.part", filename)),
            self.models_dir.join(&filename),
        ] {
            if candidate.exists() {
                if let Err(e) = fs::remove_file(&candidate).await {
                    log::warn!("Failed to clean up cancelled download file {}: {}", candidate.display(), e);
                } else {
                    log::info!("Cleaned up cancelled download file: {}", candidate.display());
                }
            }
        }

        Ok(())
    }
}
