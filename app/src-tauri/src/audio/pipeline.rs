use super::batch_processor::AudioMetricsBatcher;
use crate::batch_audio_metric;
use anyhow::Result;
use log::{debug, error, info, warn};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::audio_processing::{
    audio_to_mono, HighPassFilter, LoudnessNormalizer, NoiseSuppressionProcessor,
};
use super::devices::AudioDevice;
use super::recording_state::{AudioChunk, AudioError, DeviceType, RecordingState};
use super::vad::{ContinuousVadProcessor, SpeechSegment};

const fn vad_redemption_time_ms(is_macos: bool) -> u32 {
    if is_macos { 900 } else { 400 }
}

fn live_vad_redemption_time_ms() -> u32 {
    vad_redemption_time_ms(cfg!(target_os = "macos"))
}

/// Ring buffer for synchronized audio mixing
/// Accumulates samples from mic and system streams until we have aligned windows
struct AudioMixerRingBuffer {
    mic_buffer: VecDeque<f32>,
    system_buffer: VecDeque<f32>,
    window_size_samples: usize, // Fixed mixing window (600ms, see `new`)
    max_buffer_size: usize,     // Safety cap before dropping oldest samples
    add_count: u64,             // Counts add_samples calls for periodic diagnostics
}

impl AudioMixerRingBuffer {
    fn new(sample_rate: u32) -> Self {
        // 600ms mixing window. This is deliberately large: system audio (notably
        // Core Audio on macOS) arrives with significant jitter from
        // sample-by-sample streaming → batching → channel transmission, and a
        // smaller window led to system-buffer overflow and audible distortion.
        let window_ms = 600.0;
        let window_size_samples = (sample_rate as f32 * window_ms / 1000.0) as usize;

        // Safety cap at 8 windows (~4.8s). Beyond this we drop the oldest samples
        // to bound memory if a stream stalls.
        let max_buffer_size = window_size_samples * 8;

        info!(
            "Ring buffer initialized: window={}ms ({} samples), max={}ms ({} samples)",
            window_ms,
            window_size_samples,
            window_ms * 8.0,
            max_buffer_size
        );

        Self {
            mic_buffer: VecDeque::with_capacity(max_buffer_size),
            system_buffer: VecDeque::with_capacity(max_buffer_size),
            window_size_samples,
            max_buffer_size,
            add_count: 0,
        }
    }

    fn add_samples(&mut self, device_type: DeviceType, samples: Vec<f32>) {
        // Log buffer health periodically for diagnostics
        self.add_count = self.add_count.wrapping_add(1);
        if self.add_count % 200 == 0 {
            debug!(
                "Ring buffer status: mic={} samples, sys={} samples (max={})",
                self.mic_buffer.len(),
                self.system_buffer.len(),
                self.max_buffer_size
            );
        }

        match device_type {
            DeviceType::Microphone => self.mic_buffer.extend(samples),
            DeviceType::System => self.system_buffer.extend(samples),
        }

        // CRITICAL FIX: Add warnings before dropping samples
        // This helps diagnose timing issues in production
        if self.mic_buffer.len() > self.max_buffer_size {
            warn!(
                "⚠️ Microphone buffer overflow: {} > {} samples, dropping oldest {} samples",
                self.mic_buffer.len(),
                self.max_buffer_size,
                self.mic_buffer.len() - self.max_buffer_size
            );
        }
        if self.system_buffer.len() > self.max_buffer_size {
            error!("🔴 SYSTEM AUDIO BUFFER OVERFLOW: {} > {} samples, dropping {} samples - THIS CAUSES DISTORTION!",
                  self.system_buffer.len(), self.max_buffer_size,
                  self.system_buffer.len() - self.max_buffer_size);
        }

        // Safety: prevent buffer overflow (keep only last 200ms)
        while self.mic_buffer.len() > self.max_buffer_size {
            self.mic_buffer.pop_front();
        }
        while self.system_buffer.len() > self.max_buffer_size {
            self.system_buffer.pop_front();
        }
    }

    fn can_mix(&self) -> bool {
        self.mic_buffer.len() >= self.window_size_samples
            || self.system_buffer.len() >= self.window_size_samples
    }

    fn extract_window(&mut self) -> Option<(Vec<f32>, Vec<f32>)> {
        if !self.can_mix() {
            return None;
        }

        // Extract mic window with zero-padding for incomplete buffers
        // Zero-padding (silence) is preferred over last-sample-hold to prevent artifacts

        // Extract mic window (or pad with zeros if insufficient data)
        let mic_window = if self.mic_buffer.len() >= self.window_size_samples {
            // Enough mic data - drain window
            self.mic_buffer.drain(0..self.window_size_samples).collect()
        } else if !self.mic_buffer.is_empty() {
            // Some mic data but not enough - consume all + pad with zeros
            let available: Vec<f32> = self.mic_buffer.drain(..).collect();
            let mut padded = Vec::with_capacity(self.window_size_samples);
            padded.extend_from_slice(&available);

            // Use zero-padding (silence) to prevent repetition artifacts
            // Zero-padding is inaudible at 48kHz sample rate
            padded.resize(self.window_size_samples, 0.0);

            padded
        } else {
            // No mic data - return silence
            vec![0.0; self.window_size_samples]
        };

        // Extract system window (or pad with zeros if insufficient data)
        let sys_window = if self.system_buffer.len() >= self.window_size_samples {
            // Enough system data - drain window
            self.system_buffer
                .drain(0..self.window_size_samples)
                .collect()
        } else if !self.system_buffer.is_empty() {
            // Some system data but not enough - consume all + pad with zeros
            let available: Vec<f32> = self.system_buffer.drain(..).collect();
            let mut padded = Vec::with_capacity(self.window_size_samples);
            padded.extend_from_slice(&available);

            // Use zero-padding (silence) to prevent repetition artifacts
            // Zero-padding is inaudible at 48kHz sample rate
            padded.resize(self.window_size_samples, 0.0);

            padded
        } else {
            // No system data - return silence
            vec![0.0; self.window_size_samples]
        };

        Some((mic_window, sys_window))
    }
}

/// Mix mic + system windows by summing, with proportional limiting so the sum
/// never exceeds ±1.0 (avoids hard-clip "radio break" distortion). No ducking is
/// applied — both sources are summed at full level; the limiter only engages on
/// peaks. Windows are expected to be equal length (zero-padded by the ring
/// buffer); the `.get()` guards are defensive against a length mismatch.
fn mix_windows(mic_window: &[f32], sys_window: &[f32]) -> Vec<f32> {
    let max_len = mic_window.len().max(sys_window.len());
    let mut mixed = Vec::with_capacity(max_len);

    for i in 0..max_len {
        let mic = mic_window.get(i).copied().unwrap_or(0.0);
        let sys = sys_window.get(i).copied().unwrap_or(0.0);
        let sum = mic + sys;

        let sum_abs = sum.abs();
        mixed.push(if sum_abs > 1.0 { sum / sum_abs } else { sum });
    }

    mixed
}

/// Simplified audio capture without broadcast channels
#[derive(Clone)]
pub struct AudioCapture {
    device: Arc<AudioDevice>,
    state: Arc<RecordingState>,
    sample_rate: u32, // Original device sample rate
    channels: u16,
    chunk_counter: Arc<std::sync::atomic::AtomicU64>,
    device_type: DeviceType,
    recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    needs_resampling: bool, // Flag if resampling is required
    // CRITICAL FIX: Persistent resampler to preserve energy across chunks
    resampler: Arc<std::sync::Mutex<Option<SincFixedIn<f32>>>>,
    // Buffering for variable-size chunks → fixed-size resampler input
    resampler_input_buffer: Arc<std::sync::Mutex<Vec<f32>>>,
    resampler_chunk_size: usize, // Fixed chunk size for resampler (512 samples)
    // Audio enhancement processors (microphone only)
    noise_suppressor: Arc<std::sync::Mutex<Option<NoiseSuppressionProcessor>>>,
    high_pass_filter: Arc<std::sync::Mutex<Option<HighPassFilter>>>,
    // EBU R128 normalizer for microphone audio (per-device, stateful)
    normalizer: Arc<std::sync::Mutex<Option<LoudnessNormalizer>>>,
    // Note: Using global recording timestamp for synchronization
}

impl AudioCapture {
    pub fn new(
        device: Arc<AudioDevice>,
        state: Arc<RecordingState>,
        sample_rate: u32,
        channels: u16,
        device_type: DeviceType,
        recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    ) -> Self {
        // CRITICAL FIX: Detect if resampling is needed
        // Pipeline expects 48kHz, but Bluetooth devices often report 8kHz, 16kHz, or 44.1kHz
        const TARGET_SAMPLE_RATE: u32 = 48000;
        let needs_resampling = sample_rate != TARGET_SAMPLE_RATE;

        // Detect device kind (Bluetooth vs Wired) for adaptive processing
        // Use reasonable defaults for buffer size (512 samples is typical)
        let device_kind =
            super::device_detection::InputDeviceKind::detect(&device.name, 512, sample_rate);

        if needs_resampling {
            warn!("⚠️ SAMPLE RATE MISMATCH DETECTED ⚠️");
            warn!(
                "🔄 [{:?}] Audio device '{}' ({:?}) reports {} Hz (pipeline expects {} Hz)",
                device_type, device.name, device_kind, sample_rate, TARGET_SAMPLE_RATE
            );
            warn!(
                "🔄 Automatic resampling will be applied: {} Hz → {} Hz",
                sample_rate, TARGET_SAMPLE_RATE
            );

            // Log which resampling strategy will be used
            let ratio = TARGET_SAMPLE_RATE as f64 / sample_rate as f64;
            let strategy = if ratio >= 2.0 {
                "High-quality upsampling (sinc_len=512, Cubic interpolation)"
            } else if ratio >= 1.5 {
                "Moderate upsampling (sinc_len=384, Cubic)"
            } else if ratio > 1.0 {
                "Small upsampling (sinc_len=256, Linear)"
            } else if ratio <= 0.5 {
                "Anti-aliased downsampling (sinc_len=512, Cubic)"
            } else {
                "Moderate downsampling (sinc_len=384, Linear)"
            };
            info!("   Resampling strategy: {}", strategy);
        } else {
            info!(
                "✅ [{:?}] Audio device '{}' ({:?}) uses {} Hz (matches pipeline)",
                device_type, device.name, device_kind, sample_rate
            );
        }

        // Initialize audio enhancement processors for MICROPHONE ONLY
        // System audio doesn't need enhancement (already clean)
        let (noise_suppressor, high_pass_filter, normalizer) = if matches!(
            device_type,
            DeviceType::Microphone
        ) {
            // Initialize noise suppression (RNNoise) at 48kHz - CONDITIONAL based on flag
            let ns = if super::ffmpeg_mixer::RNNOISE_APPLY_ENABLED {
                match NoiseSuppressionProcessor::new(TARGET_SAMPLE_RATE) {
                    Ok(processor) => {
                        info!("✅ RNNoise noise suppression ENABLED for microphone '{}' (10-15 dB reduction)", device.name);
                        Some(processor)
                    }
                    Err(e) => {
                        warn!("⚠️ Failed to create noise suppressor: {}, continuing without noise suppression", e);
                        None
                    }
                }
            } else {
                info!("ℹ️ RNNoise noise suppression DISABLED for microphone '{}' (flag: RNNOISE_APPLY_ENABLED=false)", device.name);
                info!("   Whisper handles noise well internally - RNNoise is optional");
                None
            };

            // Initialize high-pass filter (removes rumble below 80 Hz)
            let hpf = {
                let filter = HighPassFilter::new(TARGET_SAMPLE_RATE, 80.0);
                info!(
                    "✅ High-pass filter initialized for microphone '{}' (cutoff: 80 Hz)",
                    device.name
                );
                Some(filter)
            };

            // Initialize EBU R128 normalizer (professional loudness standard)
            let norm = match LoudnessNormalizer::new(1, TARGET_SAMPLE_RATE) {
                Ok(normalizer) => {
                    info!(
                        "✅ EBU R128 normalizer initialized for microphone '{}' (target: -23 LUFS)",
                        device.name
                    );
                    Some(normalizer)
                }
                Err(e) => {
                    warn!(
                        "⚠️ Failed to create normalizer for microphone: {}, normalization disabled",
                        e
                    );
                    None
                }
            };

            (ns, hpf, norm)
        } else {
            // System audio: no enhancement needed
            info!(
                "ℹ️ System audio '{}' captured raw (no enhancement)",
                device.name
            );
            (None, None, None)
        };

        // CRITICAL FIX: Initialize persistent resampler to preserve energy across chunks
        // Creating a new resampler per chunk causes energy amplification and incorrect output sizes
        // Use fixed chunk size of 512 samples with buffering for variable-size input
        const RESAMPLER_CHUNK_SIZE: usize = 512;

        let resampler = if needs_resampling {
            let ratio = TARGET_SAMPLE_RATE as f64 / sample_rate as f64;

            // Adaptive parameters based on sample rate ratio (same logic as resample_audio)
            let (sinc_len, interpolation_type, oversampling) = if ratio >= 2.0 {
                (512, SincInterpolationType::Cubic, 512)
            } else if ratio >= 1.5 {
                (384, SincInterpolationType::Cubic, 384)
            } else if ratio > 1.0 {
                (256, SincInterpolationType::Linear, 256)
            } else if ratio <= 0.5 {
                (512, SincInterpolationType::Cubic, 512)
            } else {
                (384, SincInterpolationType::Linear, 384)
            };

            let params = SincInterpolationParameters {
                sinc_len,
                f_cutoff: 0.95,
                interpolation: interpolation_type,
                oversampling_factor: oversampling,
                window: WindowFunction::BlackmanHarris2,
            };

            match SincFixedIn::<f32>::new(
                ratio,
                2.0, // Maximum relative deviation
                params,
                RESAMPLER_CHUNK_SIZE,
                1, // Mono
            ) {
                Ok(resampler) => {
                    info!(
                        "✅ Persistent resampler initialized for '{}' ({}Hz → {}Hz, chunk_size={})",
                        device.name, sample_rate, TARGET_SAMPLE_RATE, RESAMPLER_CHUNK_SIZE
                    );
                    info!("   Buffering enabled for variable-size chunks (e.g., 320, 512, 1024, etc.)");
                    Some(resampler)
                }
                Err(e) => {
                    warn!(
                        "⚠️ Failed to create persistent resampler: {}, will use fallback",
                        e
                    );
                    None
                }
            }
        } else {
            None
        };

        Self {
            device,
            state,
            sample_rate,
            channels,
            chunk_counter: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            device_type,
            recording_sender,
            needs_resampling,
            resampler: Arc::new(std::sync::Mutex::new(resampler)),
            resampler_input_buffer: Arc::new(std::sync::Mutex::new(Vec::with_capacity(
                RESAMPLER_CHUNK_SIZE * 2,
            ))),
            resampler_chunk_size: RESAMPLER_CHUNK_SIZE,
            noise_suppressor: Arc::new(std::sync::Mutex::new(noise_suppressor)),
            high_pass_filter: Arc::new(std::sync::Mutex::new(high_pass_filter)),
            normalizer: Arc::new(std::sync::Mutex::new(normalizer)),
            // Using global recording time for sync
        }
    }

    /// Process audio data directly from callback
    pub fn process_audio_data(&self, data: &[f32]) {
        // Check if still recording
        if !self.state.is_recording() {
            return;
        }

        // Convert to mono if needed
        let mut mono_data = if self.channels > 1 {
            audio_to_mono(data, self.channels)
        } else {
            data.to_vec()
        };

        // System path only: CoreAudio process taps often see post-volume output,
        // so quiet speaker levels starve VAD/transcription. Boost toward a usable
        // peak without inventing signal from silence (see compensate_system_audio_level).
        if matches!(self.device_type, DeviceType::System) {
            mono_data = super::audio_processing::compensate_system_audio_level(
                &mono_data,
                super::audio_processing::SYSTEM_AUDIO_TARGET_PEAK,
                super::audio_processing::SYSTEM_AUDIO_MAX_GAIN,
                super::audio_processing::SYSTEM_AUDIO_SILENCE_FLOOR,
            );
        }

        // CRITICAL FIX: Resample to 48kHz if device uses different sample rate
        // This fixes Bluetooth devices (like Sony WH-1000XM4) that report 16kHz or 44.1kHz
        // Without this, audio is sped up 3x and VAD fails
        //
        // IMPORTANT: Uses PERSISTENT resampler with BUFFERING to preserve energy across chunks
        // Creating a new resampler per chunk causes energy amplification (173.5% RMS)
        // Buffering handles variable chunk sizes (320, 512, 1024, etc.) by accumulating to fixed 512-sample chunks
        const TARGET_SAMPLE_RATE: u32 = 48000;
        if self.needs_resampling {
            let before_len = mono_data.len();
            let before_rms = if !mono_data.is_empty() {
                (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt()
            } else {
                0.0
            };

            // Use persistent resampler with buffering to handle variable chunk sizes
            let mut resampled_output = Vec::new();
            let mut used_persistent_resampler = false;

            if let Ok(mut buffer_lock) = self.resampler_input_buffer.lock() {
                // Add new samples to buffer
                buffer_lock.extend_from_slice(&mono_data);

                // Process complete chunks through the resampler
                if let Ok(mut resampler_lock) = self.resampler.lock() {
                    if let Some(ref mut resampler) = *resampler_lock {
                        used_persistent_resampler = true;

                        // Process as many complete chunks as we have
                        while buffer_lock.len() >= self.resampler_chunk_size {
                            // Extract exactly chunk_size samples
                            let chunk: Vec<f32> =
                                buffer_lock.drain(0..self.resampler_chunk_size).collect();

                            // Rubato expects input as Vec<Vec<f32>> (one Vec per channel)
                            let waves_in = vec![chunk];

                            match resampler.process(&waves_in, None) {
                                Ok(mut waves_out) => {
                                    if let Some(output) = waves_out.pop() {
                                        resampled_output.extend_from_slice(&output);
                                    }
                                }
                                Err(e) => {
                                    warn!("⚠️ Persistent resampler processing failed: {}", e);
                                    used_persistent_resampler = false;
                                    break;
                                }
                            }
                        }
                        // Remaining samples in buffer will be processed in next iteration
                    }
                }
            }

            // CRITICAL: Only update mono_data if we got output from persistent resampler
            // If buffer is accumulating (< 512 samples), skip this chunk - data is safely buffered
            // and will be processed in next iteration with proper resampling
            let has_resampled_output = !resampled_output.is_empty();

            if has_resampled_output {
                mono_data = resampled_output;
            } else if !used_persistent_resampler {
                // Only fallback if persistent resampler is not available at all.
                // On failure, drop the chunk rather than forwarding wrong-rate audio,
                // which would be transcribed at the wrong speed (garbled output).
                match super::audio_processing::resample(
                    &mono_data,
                    self.sample_rate,
                    TARGET_SAMPLE_RATE,
                ) {
                    Ok(resampled) => mono_data = resampled,
                    Err(e) => {
                        error!(
                            "Fallback resampling {}Hz -> {}Hz failed: {}; dropping chunk to avoid garbled transcription",
                            self.sample_rate, TARGET_SAMPLE_RATE, e
                        );
                        return;
                    }
                }
            } else {
                // Buffering: samples are accumulating in buffer, waiting for 512-sample chunk
                // Don't send partial/unprocessed data - return early
                // Audio is NOT lost - it's in the buffer and will be processed next iteration
                return;
            }

            // Log resampling only occasionally to avoid spam
            let chunk_id = self.chunk_counter.load(std::sync::atomic::Ordering::SeqCst);
            if chunk_id % 100 == 0 && has_resampled_output {
                let after_len = mono_data.len();
                let after_rms = if !mono_data.is_empty() {
                    (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt()
                } else {
                    0.0
                };
                let ratio = TARGET_SAMPLE_RATE as f64 / self.sample_rate as f64;
                let rms_preservation = if before_rms > 0.0 {
                    (after_rms / before_rms) * 100.0
                } else {
                    100.0
                };

                let buffer_size = if let Ok(buf) = self.resampler_input_buffer.lock() {
                    buf.len()
                } else {
                    0
                };

                info!(
                    "🔄 [{:?}] Persistent buffered resampler: {}Hz → {}Hz (ratio: {:.2}x)",
                    self.device_type, self.sample_rate, TARGET_SAMPLE_RATE, ratio
                );
                info!(
                    "   Chunk {}: {} → {} samples, RMS preservation: {:.1}%, buffer: {}",
                    chunk_id, before_len, after_len, rms_preservation, buffer_size
                );
            }
        }

        // AUDIO ENHANCEMENT PIPELINE (Microphone Only)
        // Processing order is critical: high-pass → noise suppression → normalization
        // This ensures noise is removed before being amplified by the normalizer
        if matches!(self.device_type, DeviceType::Microphone) {
            // STEP 1: Apply high-pass filter to remove low-frequency rumble (< 80 Hz)
            if let Ok(mut hpf_lock) = self.high_pass_filter.lock() {
                if let Some(ref mut filter) = *hpf_lock {
                    mono_data = filter.process(&mono_data);
                }
            }

            // STEP 2: Apply RNNoise noise suppression (10-15 dB reduction) - CONDITIONAL
            if super::ffmpeg_mixer::RNNOISE_APPLY_ENABLED {
                if let Ok(mut ns_lock) = self.noise_suppressor.lock() {
                    if let Some(ref mut suppressor) = *ns_lock {
                        let before_len = mono_data.len();
                        mono_data = suppressor.process(&mono_data);
                        let after_len = mono_data.len();

                        // CRITICAL MONITORING: Track buffer health
                        let chunk_id = self.chunk_counter.load(std::sync::atomic::Ordering::SeqCst);
                        if chunk_id % 100 == 0 {
                            let buffered = suppressor.buffered_samples();
                            let length_delta = (before_len as i32 - after_len as i32).abs();

                            debug!("🔇 Noise suppression health: in={}, out={}, delta={}, buffered={}, RMS={:.4}",
                                   before_len, after_len, length_delta, buffered,
                                   if !mono_data.is_empty() {
                                       (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt()
                                   } else { 0.0 });

                            // WARN if accumulating samples (potential latency buildup)
                            if buffered > 1000 {
                                warn!("⚠️ RNNoise accumulating samples: {} buffered (potential latency issue!)",
                                      buffered);
                            }

                            // WARN if significant length mismatch
                            if length_delta > 50 {
                                warn!(
                                    "⚠️ RNNoise length mismatch: input={} output={} (delta={})",
                                    before_len, after_len, length_delta
                                );
                            }
                        }
                    }
                }
            }

            // STEP 3: Apply EBU R128 normalization (professional loudness standard)
            if let Ok(mut normalizer_lock) = self.normalizer.lock() {
                if let Some(ref mut normalizer) = *normalizer_lock {
                    mono_data = normalizer.normalize_loudness(&mono_data);

                    // Log normalization occasionally for debugging
                    let chunk_id = self.chunk_counter.load(std::sync::atomic::Ordering::SeqCst);
                    if chunk_id % 200 == 0 && !mono_data.is_empty() {
                        let rms = (mono_data.iter().map(|&x| x * x).sum::<f32>()
                            / mono_data.len() as f32)
                            .sqrt();
                        let peak = mono_data.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);
                        debug!(
                            "🎤 After normalization chunk {}: RMS={:.4}, Peak={:.4}",
                            chunk_id, rms, peak
                        );
                    }
                }
            }
        }

        // Create audio chunk with stream-specific timestamp (get ID first for logging)
        let chunk_id = self
            .chunk_counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        // Mic remains raw here (gain after mix). System already received
        // peak compensation above when DeviceType::System.

        // DIAGNOSTIC: Log audio levels for debugging (especially mic issues)
        // if chunk_id % 100 == 0 && !mono_data.is_empty() {
        //     let raw_rms = (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt();
        //     let raw_peak = mono_data.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);

        //         info!("🎙️ [{:?}] Chunk {} - Raw: RMS={:.6}, Peak={:.6}",
        //               self.device_type, chunk_id, raw_rms, raw_peak);

        //     // Warn if microphone is completely silent
        //     if matches!(self.device_type, DeviceType::Microphone) && raw_rms == 0.0 && raw_peak == 0.0 {
        //         warn!("⚠️ Microphone producing ZERO audio - check permissions or hardware!");
        //     }
        // }
        // else if chunk_id % 100 == 0 && matches!(self.device_type, DeviceType::System) {
        //     let raw_rms = (mono_data.iter().map(|&x| x * x).sum::<f32>() / mono_data.len() as f32).sqrt();
        //     let raw_peak = mono_data.iter().map(|&x| x.abs()).fold(0.0f32, f32::max);
        //     info!("🔊 [{:?}] Chunk {} - Raw: RMS={:.6}, Peak={:.6}",
        //       self.device_type, chunk_id, raw_rms, raw_peak);

        //     // Warn if system audio is completely silent
        //     if raw_rms == 0.0 && raw_peak == 0.0 {
        //         warn!("⚠️ System audio producing ZERO audio - check permissions or hardware!");
        //     }
        // }

        // Use global recording timestamp for proper synchronization
        let timestamp = self.state.get_recording_duration().unwrap_or(0.0);

        // RAW AUDIO CHUNK: No gain applied - will be mixed and gained downstream
        // Use 48kHz if we resampled, otherwise use original rate
        let audio_chunk = AudioChunk {
            data: mono_data, // Raw audio (resampled if needed), no gain yet
            sample_rate: if self.needs_resampling {
                48000
            } else {
                self.sample_rate
            },
            timestamp,
            chunk_id,
            device_type: self.device_type.clone(),
        };

        // NOTE: Raw audio is NOT sent to recording saver to prevent echo
        // Only the mixed audio (from AudioPipeline) is saved to file (see pipeline.rs:726-736)
        // This ensures we only record once: mic + system properly mixed
        // Individual raw streams go only to the transcription pipeline below

        // Send to processing pipeline for transcription
        if let Err(e) = self.state.send_audio_chunk(audio_chunk) {
            // Check if this is the "pipeline not ready" error
            if e.to_string().contains("Audio pipeline not ready") {
                // This is expected during initialization, just log it as debug
                debug!("Audio pipeline not ready yet, skipping chunk {}", chunk_id);
                return;
            }

            warn!("Failed to send audio chunk: {}", e);
            // More specific error handling based on failure reason
            let error = if e.to_string().contains("channel closed") {
                AudioError::ChannelClosed
            } else if e.to_string().contains("full") {
                AudioError::BufferOverflow
            } else {
                AudioError::ProcessingFailed
            };
            self.state.report_error(error);
        } else {
            debug!("Sent audio chunk {} ({} samples)", chunk_id, data.len());
        }
    }

    /// Handle stream errors with enhanced disconnect detection
    pub fn handle_stream_error(&self, error: cpal::StreamError) {
        error!("Audio stream error for {}: {}", self.device.name, error);

        let error_str = error.to_string().to_lowercase();

        // Enhanced error detection for device disconnection
        let audio_error = if error_str.contains("device is no longer available")
            || error_str.contains("device not found")
            || error_str.contains("device disconnected")
            || error_str.contains("no such device")
            || error_str.contains("device unavailable")
            || error_str.contains("device removed")
        {
            warn!("🔌 Device disconnect detected for: {}", self.device.name);
            AudioError::DeviceDisconnected
        } else if error_str.contains("permission") || error_str.contains("access denied") {
            AudioError::PermissionDenied
        } else if error_str.contains("channel closed") {
            AudioError::ChannelClosed
        } else if error_str.contains("stream") && error_str.contains("failed") {
            AudioError::StreamFailed
        } else {
            warn!("Unknown audio error: {}", error);
            AudioError::StreamFailed
        };

        self.state.report_error(audio_error);
    }
}

/// VAD-driven audio processing pipeline
/// Uses Voice Activity Detection to segment speech in real-time and send only speech to Whisper
pub struct AudioPipeline {
    receiver: mpsc::UnboundedReceiver<AudioChunk>,
    transcription_sender: mpsc::UnboundedSender<AudioChunk>,
    state: Arc<RecordingState>,
    // Per-source VAD lanes: transcription runs on each stream separately so
    // segments carry speaker attribution (mic = the user, system = others).
    vad_mic: ContinuousVadProcessor,
    vad_system: ContinuousVadProcessor,
    sample_rate: u32,
    chunk_id_counter: u64,
    // Performance optimization: reduce logging frequency
    last_summary_time: std::time::Instant,
    processed_chunks: u64,
    // Smart batching for audio metrics
    metrics_batcher: Option<AudioMetricsBatcher>,
    // Ring buffer that aligns mic + system windows for mixing
    ring_buffer: AudioMixerRingBuffer,
    // Recording sender for pre-mixed audio
    recording_sender_for_mixed: Option<mpsc::UnboundedSender<AudioChunk>>,
    // Receives explicit flush requests (each carries a oneshot ack).
    flush_rx: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
}

impl AudioPipeline {
    pub fn new(
        receiver: mpsc::UnboundedReceiver<AudioChunk>,
        transcription_sender: mpsc::UnboundedSender<AudioChunk>,
        state: Arc<RecordingState>,
        target_chunk_duration_ms: u32,
        sample_rate: u32,
        mic_device_name: String,
        mic_device_kind: super::device_detection::InputDeviceKind,
        system_device_name: String,
        system_device_kind: super::device_detection::InputDeviceKind,
        flush_rx: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
    ) -> anyhow::Result<Self> {
        // Log device characteristics for adaptive buffering
        info!("🎛️ AudioPipeline initializing with device characteristics:");
        info!(
            "   Mic: '{}' ({:?}) - Buffer: {:?}",
            mic_device_name,
            mic_device_kind,
            mic_device_kind.buffer_timeout()
        );
        info!(
            "   System: '{}' ({:?}) - Buffer: {:?}",
            system_device_name,
            system_device_kind,
            system_device_kind.buffer_timeout()
        );

        // Device kind information can be used for adaptive buffering in the future
        // For now, we log it for monitoring and potential optimization
        let _ = (
            mic_device_name,
            mic_device_kind,
            system_device_name,
            system_device_kind,
        );

        // Bridge natural pauses without adding excessive live-caption latency.
        // CoreAudio commonly exposes shorter discontinuities than the other
        // capture paths, so macOS needs a longer window to avoid fragmenting
        // sentences into context-poor ASR requests.
        let redemption_time = live_vad_redemption_time_ms();

        let make_vad = |lane: &str| -> anyhow::Result<ContinuousVadProcessor> {
            match ContinuousVadProcessor::new(sample_rate, redemption_time) {
                Ok(processor) => {
                    info!("VAD-driven pipeline ({} lane): segments sent directly to transcription", lane);
                    Ok(processor)
                }
                Err(e) => {
                    error!("Failed to create VAD processor ({} lane): {}", lane, e);
                    Err(anyhow::anyhow!("VAD processor creation failed ({} lane): {}", lane, e))
                }
            }
        };
        let vad_mic = make_vad("mic")?;
        let vad_system = make_vad("system")?;

        // Initialize the mic/system alignment ring buffer
        let ring_buffer = AudioMixerRingBuffer::new(sample_rate);

        // Note: target_chunk_duration_ms is ignored - VAD controls segmentation now
        let _ = target_chunk_duration_ms;

        Ok(Self {
            receiver,
            transcription_sender,
            state,
            vad_mic,
            vad_system,
            sample_rate,
            chunk_id_counter: 0,
            // Performance optimization: reduce logging frequency
            last_summary_time: std::time::Instant::now(),
            processed_chunks: 0,
            // Initialize metrics batcher for smart batching
            metrics_batcher: Some(AudioMetricsBatcher::new()),
            ring_buffer,
            recording_sender_for_mixed: None, // Will be set by manager
            flush_rx,
        })
    }

    /// Run the VAD-driven audio processing pipeline
    pub async fn run(mut self) -> Result<()> {
        info!("VAD-driven audio pipeline started - segments sent in real-time based on speech detection");

        // Acoustic echo cancellation for the transcription path only.
        // Built once per recording so it adapts over time. If it fails to build,
        // AEC is skipped (None) and transcription falls back to the raw mic window.
        let echo_handle = match crate::audio::echo_cancel::EchoCancellerHandle::spawn(48_000) {
            Ok(handle) => Some(handle),
            Err(e) => {
                warn!("Echo cancellation unavailable; transcription will use raw mic audio: {}", e);
                None
            }
        };

        // CRITICAL FIX: Continue processing until channel is closed, not based on recording state
        // This ensures ALL chunks are processed during shutdown, fixing premature meeting completion
        // Previous bug: Loop checked `while self.state.is_recording()` which caused early exit when
        // stop_recording() was called, losing flush signals and remaining chunks in the pipeline
        loop {
            tokio::select! {
                // Explicit flush requests take priority. The caller sends a oneshot
                // sender and awaits its receiver, so shutdown is deterministic rather
                // than relying on magic chunk IDs + fixed sleeps.
                Some(ack) = self.flush_rx.recv() => {
                    info!("Received flush request - flushing VAD processor");
                    self.flush_remaining_audio()?;
                    let _ = ack.send(());
                }
                // Drain audio chunks. A short timeout keeps the loop responsive even
                // when no audio is currently arriving.
                result = tokio::time::timeout(
                    std::time::Duration::from_millis(50),
                    self.receiver.recv(),
                ) => {
                    match result {
                Ok(Some(chunk)) => {

                    // PERFORMANCE OPTIMIZATION: Eliminate per-chunk logging overhead
                    // Logging in hot paths causes severe performance degradation
                    self.processed_chunks += 1;

                    // One pass over the chunk yields the peak sample, feeding both the
                    // live level meter (mic + system, so the meter reacts to anyone
                    // speaking) and the mic-only silent-input detector (read by the
                    // recording orchestration ~10s after start). Cheap, lock-free.
                    if !chunk.data.is_empty() {
                        let peak = chunk.data.iter().map(|&x| x.abs()).fold(0.0_f32, f32::max);
                        self.state.note_live_peak(peak);
                        if chunk.device_type == DeviceType::Microphone {
                            self.state.note_mic_amplitude(peak);
                        }
                    }

                    // Smart batching: collect metrics instead of logging every chunk
                    if let Some(ref batcher) = self.metrics_batcher {
                        let avg_level = chunk.data.iter().map(|&x| x.abs()).sum::<f32>() / chunk.data.len() as f32;
                        let duration_ms = chunk.data.len() as f64 / chunk.sample_rate as f64 * 1000.0;

                        batch_audio_metric!(
                            Some(batcher),
                            chunk.chunk_id,
                            chunk.data.len(),
                            duration_ms,
                            avg_level
                        );
                    }

                    // CRITICAL: Log summary only every 200 chunks OR every 60 seconds (99.5% reduction)
                    // This eliminates I/O overhead in the audio processing hot path
                    // Use performance-optimized debug macro that compiles to nothing in release builds
                    if self.processed_chunks % 200 == 0 || self.last_summary_time.elapsed().as_secs() >= 60 {
                        perf_debug!("Pipeline processed {} chunks, current chunk: {} ({} samples)",
                                   self.processed_chunks, chunk.chunk_id, chunk.data.len());
                        self.last_summary_time = std::time::Instant::now();
                    }

                    // STEP 1: Add raw audio to ring buffer for mixing
                    // Microphone audio is already normalized at capture level (AudioCapture)
                    // System audio remains raw
                    self.ring_buffer.add_samples(chunk.device_type.clone(), chunk.data);

                    // STEP 2: Mix audio in fixed windows when both streams have sufficient data
                    while self.ring_buffer.can_mix() {
                        if let Some((mic_window, sys_window)) = self.ring_buffer.extract_window() {
                            // Simple mixing without aggressive ducking
                            let mixed_clean = mix_windows(&mic_window, &sys_window);

                            // NO POST-GAIN NEEDED: Microphone already normalized by EBU R128 to -23 LUFS
                            // This is broadcast-standard loudness (Netflix/YouTube/Spotify level)
                            // System audio at natural levels
                            // Previous 2x gain was causing excessive limiting/distortion
                            let mixed_with_gain = mixed_clean;

                            // STEP 3: Per-source VAD + transcription. The mixed stream is
                            // only for the recording file; transcription runs on each source
                            // separately so segments carry speaker attribution
                            // (mic = the user, system = other participants).
                            // Echo-cancel the mic window for the transcription path
                            // only; the recording mix above keeps the raw mic audio.
                            // No-op when the system reference is silent (headphones).
                            let mic_for_vad = match echo_handle.as_ref() {
                                Some(handle) => handle.process(mic_window.clone(), sys_window.clone()).await,
                                None => mic_window.clone(),
                            };
                            match self.vad_mic.process_audio(&mic_for_vad) {
                                Ok(segments) => Self::forward_vad_segments(
                                    segments,
                                    DeviceType::Microphone,
                                    &self.transcription_sender,
                                    &mut self.chunk_id_counter,
                                ),
                                Err(e) => warn!("⚠️ VAD error (mic lane): {}", e),
                            }
                            match self.vad_system.process_audio(&sys_window) {
                                Ok(segments) => Self::forward_vad_segments(
                                    segments,
                                    DeviceType::System,
                                    &self.transcription_sender,
                                    &mut self.chunk_id_counter,
                                ),
                                Err(e) => warn!("⚠️ VAD error (system lane): {}", e),
                            }

                            // STEP 4: Send mixed audio for recording (WAV file)
                            if let Some(ref sender) = self.recording_sender_for_mixed {
                                let recording_chunk = AudioChunk {
                                    data: mixed_with_gain.clone(),
                                    sample_rate: self.sample_rate,
                                    timestamp: chunk.timestamp,
                                    chunk_id: self.chunk_id_counter,
                                    device_type: DeviceType::Microphone,  // Mixed audio
                                };
                                let _ = sender.send(recording_chunk);
                            }
                        }
                    }
                }
                Ok(None) => {
                    info!("Audio pipeline: sender closed after processing {} chunks", self.processed_chunks);
                    break;
                }
                Err(_) => {
                    // Timeout - just continue, VAD handles all segmentation
                }
                    }
                }
            }
        }

        // Flush any remaining VAD segments
        self.flush_remaining_audio()?;

        info!("VAD-driven audio pipeline ended");
        Ok(())
    }

    fn flush_remaining_audio(&mut self) -> Result<()> {
        info!(
            "Flushing remaining audio from pipeline (processed {} chunks)",
            self.processed_chunks
        );

        // Flush both VAD lanes and send remaining segments to transcription.
        match self.vad_mic.flush() {
            Ok(segments) => Self::forward_vad_segments(
                segments,
                DeviceType::Microphone,
                &self.transcription_sender,
                &mut self.chunk_id_counter,
            ),
            Err(e) => warn!("Failed to flush VAD processor (mic lane): {}", e),
        }
        match self.vad_system.flush() {
            Ok(segments) => Self::forward_vad_segments(
                segments,
                DeviceType::System,
                &self.transcription_sender,
                &mut self.chunk_id_counter,
            ),
            Err(e) => warn!("Failed to flush VAD processor (system lane): {}", e),
        }

        Ok(())
    }

    /// Forward completed VAD segments to the transcription queue, tagged with
    /// the source device type ("mic" lane vs "system" lane) so downstream
    /// transcripts carry speaker attribution.
    fn forward_vad_segments(
        segments: Vec<SpeechSegment>,
        device_type: DeviceType,
        transcription_sender: &mpsc::UnboundedSender<AudioChunk>,
        chunk_id_counter: &mut u64,
    ) {
        for segment in segments {
            let duration_ms = segment.end_timestamp_ms - segment.start_timestamp_ms;

            // Minimum 50ms at 16kHz - matches Parakeet capability
            if segment.samples.len() >= 800 {
                info!(
                    "📤 Sending VAD segment ({:?}): {:.1}ms, {} samples",
                    device_type,
                    duration_ms,
                    segment.samples.len()
                );

                let transcription_chunk = AudioChunk {
                    data: segment.samples,
                    sample_rate: 16000,
                    timestamp: segment.start_timestamp_ms / 1000.0,
                    chunk_id: *chunk_id_counter,
                    device_type: device_type.clone(),
                };

                if let Err(e) = transcription_sender.send(transcription_chunk) {
                    warn!("Failed to send VAD segment ({:?}): {}", device_type, e);
                } else {
                    *chunk_id_counter += 1;
                }
            } else {
                debug!(
                    "⏭️ Dropping short VAD segment ({:?}): {:.1}ms ({} samples < 800)",
                    device_type,
                    duration_ms,
                    segment.samples.len()
                );
            }
        }
    }
}

/// Simple audio pipeline manager
pub struct AudioPipelineManager {
    pipeline_handle: Option<JoinHandle<Result<()>>>,
    audio_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
    // Sends flush requests (each with a oneshot ack) to the running pipeline.
    flush_sender: Option<mpsc::UnboundedSender<oneshot::Sender<()>>>,
}

impl AudioPipelineManager {
    pub fn new() -> Self {
        Self {
            pipeline_handle: None,
            audio_sender: None,
            flush_sender: None,
        }
    }

    /// Start the audio pipeline with device information for adaptive buffering
    pub fn start(
        &mut self,
        state: Arc<RecordingState>,
        transcription_sender: mpsc::UnboundedSender<AudioChunk>,
        target_chunk_duration_ms: u32,
        sample_rate: u32,
        recording_sender: Option<mpsc::UnboundedSender<AudioChunk>>,
        mic_device_name: String,
        mic_device_kind: super::device_detection::InputDeviceKind,
        system_device_name: String,
        system_device_kind: super::device_detection::InputDeviceKind,
    ) -> Result<()> {
        // Log device information for adaptive buffering
        info!("🎙️ Starting pipeline with device info:");
        info!(
            "   Microphone: '{}' ({:?})",
            mic_device_name, mic_device_kind
        );
        info!(
            "   System Audio: '{}' ({:?})",
            system_device_name, system_device_kind
        );

        // Create audio processing channel
        let (audio_sender, audio_receiver) = mpsc::unbounded_channel::<AudioChunk>();

        // Dedicated flush-signaling channel (carries a oneshot ack per request).
        let (flush_sender, flush_receiver) = mpsc::unbounded_channel::<oneshot::Sender<()>>();

        // Set sender in state for audio captures to use
        state.set_audio_sender(audio_sender.clone());

        // Create and start pipeline with device information for adaptive mixing
        let mut pipeline = AudioPipeline::new(
            audio_receiver,
            transcription_sender,
            state.clone(),
            target_chunk_duration_ms,
            sample_rate,
            mic_device_name,
            mic_device_kind,
            system_device_name,
            system_device_kind,
            flush_receiver,
        )?;

        // CRITICAL FIX: Connect recording sender to receive pre-mixed audio
        // This ensures both mic AND system audio are captured in recordings
        pipeline.recording_sender_for_mixed = recording_sender;

        let handle = tokio::spawn(async move { pipeline.run().await });

        self.pipeline_handle = Some(handle);
        self.audio_sender = Some(audio_sender);
        self.flush_sender = Some(flush_sender);

        info!("Audio pipeline manager started with mixed audio recording");
        Ok(())
    }

    /// Stop the audio pipeline
    pub async fn stop(&mut self) -> Result<()> {
        // Drop the senders to close the pipeline
        self.flush_sender = None;
        self.audio_sender = None;

        // Wait for pipeline to finish
        if let Some(handle) = self.pipeline_handle.take() {
            match handle.await {
                Ok(result) => result,
                Err(e) => {
                    error!("Pipeline task failed: {}", e);
                    Ok(())
                }
            }
        } else {
            Ok(())
        }
    }

    /// Force immediate flush of accumulated audio and stop pipeline
    /// PERFORMANCE CRITICAL: Eliminates 30+ second shutdown delays
    pub async fn force_flush_and_stop(&mut self) -> Result<()> {
        info!("Force flushing pipeline - processing accumulated audio before stop");

        // Ask the pipeline to flush and wait for it to acknowledge. This replaces
        // the old magic-chunk-ID + fixed-sleep handshake with a deterministic ack;
        // a timeout guards against a stalled pipeline.
        if let Some(sender) = &self.flush_sender {
            let (ack_tx, ack_rx) = oneshot::channel();
            if sender.send(ack_tx).is_err() {
                warn!("Pipeline already stopped; skipping flush");
            } else {
                match tokio::time::timeout(std::time::Duration::from_secs(2), ack_rx).await {
                    Ok(Ok(())) => info!("Pipeline flush acknowledged"),
                    Ok(Err(_)) => warn!("Pipeline dropped flush ack before responding"),
                    Err(_) => warn!("Timed out waiting for pipeline flush ack"),
                }
            }
        }

        // Now stop normally
        self.stop().await
    }
}

impl Default for AudioPipelineManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: u32 = 48_000;

    // 600ms window at 48kHz = 28 800 samples
    fn expected_window_size() -> usize {
        (SAMPLE_RATE as f32 * 600.0 / 1000.0) as usize
    }

    #[test]
    fn new_at_48khz_produces_correct_window_size() {
        let buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        assert_eq!(buf.window_size_samples, expected_window_size());
    }

    #[test]
    fn macos_vad_bridges_longer_coreaudio_pauses() {
        assert_eq!(vad_redemption_time_ms(true), 900);
        assert_eq!(vad_redemption_time_ms(false), 400);
    }

    #[test]
    fn new_max_buffer_size_is_eight_windows() {
        let buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        assert_eq!(buf.max_buffer_size, buf.window_size_samples * 8);
    }

    #[test]
    fn cannot_mix_when_empty() {
        let buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        assert!(!buf.can_mix());
    }

    #[test]
    fn can_mix_after_mic_has_one_window_of_samples() {
        let mut buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        let samples = vec![0.5_f32; expected_window_size()];
        buf.add_samples(DeviceType::Microphone, samples);
        assert!(buf.can_mix());
    }

    #[test]
    fn can_mix_after_system_has_one_window_of_samples() {
        let mut buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        let samples = vec![0.25_f32; expected_window_size()];
        buf.add_samples(DeviceType::System, samples);
        assert!(buf.can_mix());
    }

    #[test]
    fn extract_window_returns_correct_length() {
        let window_size = expected_window_size();
        let mut buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        buf.add_samples(DeviceType::Microphone, vec![1.0_f32; window_size]);

        let (mic_win, sys_win) = buf.extract_window().expect("window available");
        assert_eq!(mic_win.len(), window_size);
        assert_eq!(sys_win.len(), window_size);
    }

    #[test]
    fn extract_window_drains_mic_buffer() {
        let window_size = expected_window_size();
        let mut buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        buf.add_samples(DeviceType::Microphone, vec![1.0_f32; window_size]);

        buf.extract_window().expect("first extraction");
        // After draining one window the buffer is empty; can_mix should be false.
        assert!(!buf.can_mix());
    }

    #[test]
    fn extract_window_returns_silence_for_missing_system_channel() {
        let window_size = expected_window_size();
        let mut buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        // Only mic data — no system audio.
        buf.add_samples(DeviceType::Microphone, vec![0.8_f32; window_size]);

        let (_, sys_win) = buf.extract_window().expect("window");
        // Silence is represented as 0.0.
        assert!(sys_win.iter().all(|&s| s == 0.0), "no system data → all silence");
    }

    #[test]
    fn overflow_is_capped_at_max_buffer_size() {
        let window_size = expected_window_size();
        let mut buf = AudioMixerRingBuffer::new(SAMPLE_RATE);
        let max = buf.max_buffer_size;

        // Push 10 windows of mic data (well over the 8-window cap).
        buf.add_samples(DeviceType::Microphone, vec![0.5_f32; window_size * 10]);

        assert!(
            buf.mic_buffer.len() <= max,
            "overflow must be capped: {} > {}",
            buf.mic_buffer.len(),
            max
        );
    }
}
