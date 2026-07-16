//! Headless transcription of an audio file with a real local ASR engine.
//!
//! Dev-only entry point for the eval harness (`nub run eval:real`): no Tauri
//! runtime, no app state. Downloads the model on first use, then decodes the
//! given audio file and prints the transcript — transcript text is the ONLY
//! stdout output (logs go to stderr) so a caller can capture it directly.
//!
//! Usage: cargo run -p muesly --example transcribe-fixture --
//!        [--provider whisper|parakeet] [--language en] [--vad]
//!        [--segments] [--dump-segments <dir>]
//!        [--metrics-json <path>]
//!        [--prompt "term one, term two"] <audio> [model] [models_dir]
//!
//! `--segments` (implies `--vad`) prints one line per VAD segment instead of a
//! single joined transcript:
//! `<index>\t<start-seconds>\t<confidence>\t<kept|DROPPED(reason)>\t<text>`.
//!
//! `--dump-segments <dir>` (implies `--vad`) skips transcription and instead
//! writes each VAD segment as 16 kHz mono `seg-NNN.wav` into `dir`, so an
//! external engine can be evaluated on the exact same segmentation. Prints one
//! manifest line per segment: `<index>\t<start-seconds>\t<file>`.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use app_lib::audio::decoder::decode_audio_file;
use app_lib::audio::vad::get_speech_chunks;
use app_lib::parakeet_engine::engine::ParakeetEngine;
use app_lib::transcription_models::ModelStatus;
use app_lib::vocabulary::set_meeting_prompt_terms;
use app_lib::whisper_engine::engine::WhisperEngine;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Serialize)]
struct EvalMetrics {
    schema_version: u8,
    provider: String,
    model: String,
    backend: String,
    operating_system: &'static str,
    architecture: &'static str,
    audio_duration_seconds: f64,
    decode_seconds: f64,
    vad_seconds: f64,
    model_download_seconds: f64,
    model_load_seconds: f64,
    inference_seconds: f64,
    inference_rtf: f64,
    measured_total_seconds: f64,
    baseline_rss_mb: f64,
    peak_rss_mb: f64,
    peak_rss_delta_mb: f64,
}

struct MemoryObservation {
    baseline_bytes: u64,
    peak_bytes: u64,
}

struct PeakMemorySampler {
    baseline_bytes: u64,
    peak_bytes: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl PeakMemorySampler {
    fn start() -> Self {
        let pid = sysinfo::get_current_pid().expect("current process id");
        let baseline_bytes = current_process_memory(pid);
        let peak_bytes = Arc::new(AtomicU64::new(baseline_bytes));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_peak = Arc::clone(&peak_bytes);
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let pids = [pid];
            let mut system = System::new();
            while !thread_stop.load(Ordering::Relaxed) {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&pids),
                    false,
                    ProcessRefreshKind::nothing().with_memory(),
                );
                if let Some(process) = system.process(pid) {
                    thread_peak.fetch_max(process.memory(), Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        Self {
            baseline_bytes,
            peak_bytes,
            stop,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> MemoryObservation {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        MemoryObservation {
            baseline_bytes: self.baseline_bytes,
            peak_bytes: self.peak_bytes.load(Ordering::Relaxed),
        }
    }
}

fn current_process_memory(pid: sysinfo::Pid) -> u64 {
    let pids = [pid];
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing().with_memory(),
    );
    system.process(pid).map_or(0, sysinfo::Process::memory)
}

fn compiled_backend(provider: &str) -> String {
    if provider == "parakeet" {
        return "onnx-cpu".to_string();
    }
    if cfg!(feature = "coreml") {
        "coreml-metal"
    } else if cfg!(feature = "metal") {
        "metal"
    } else if cfg!(feature = "cuda") {
        "cuda"
    } else if cfg!(feature = "vulkan") {
        "vulkan"
    } else if cfg!(feature = "hipblas") {
        "hipblas"
    } else if cfg!(feature = "openblas") {
        "openblas-cpu"
    } else {
        "cpu"
    }
    .to_string()
}

fn megabytes(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn fail(msg: String) -> ! {
    eprintln!("transcribe-fixture: {msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    // Surface engine logs (e.g. lang-lock decisions) on stderr under RUST_LOG.
    let _ = env_logger::try_init();
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let mut provider = "whisper".to_string();
    let mut language = None;
    let mut use_vad = false;
    let mut per_segment = false;
    let mut dump_dir: Option<PathBuf> = None;
    let mut metrics_path: Option<PathBuf> = None;
    let mut prompt = None;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < raw_args.len() {
        match raw_args[index].as_str() {
            "--provider" => {
                index += 1;
                provider = raw_args
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| fail("--provider requires whisper or parakeet".to_string()));
            }
            "--language" => {
                index += 1;
                language =
                    Some(raw_args.get(index).cloned().unwrap_or_else(|| {
                        fail("--language requires a language code".to_string())
                    }));
            }
            "--vad" => use_vad = true,
            "--segments" => {
                use_vad = true;
                per_segment = true;
            }
            "--dump-segments" => {
                use_vad = true;
                index += 1;
                dump_dir = Some(PathBuf::from(raw_args.get(index).cloned().unwrap_or_else(
                    || fail("--dump-segments requires a directory".to_string()),
                )));
            }
            "--metrics-json" => {
                index += 1;
                metrics_path =
                    Some(PathBuf::from(raw_args.get(index).cloned().unwrap_or_else(
                        || fail("--metrics-json requires a file path".to_string()),
                    )));
            }
            "--prompt" => {
                index += 1;
                prompt = Some(raw_args.get(index).cloned().unwrap_or_else(|| {
                    fail("--prompt requires comma-separated terms".to_string())
                }));
            }
            argument if argument.starts_with("--") => fail(format!("unknown option: {argument}")),
            argument => positional.push(argument.to_string()),
        }
        index += 1;
    }
    if provider != "whisper" && provider != "parakeet" {
        fail(format!(
            "unknown provider '{provider}'; expected whisper or parakeet"
        ));
    }
    let Some(audio_path) = positional.first().map(PathBuf::from) else {
        fail(
            "usage: transcribe-fixture [--provider whisper|parakeet] [--language en] [--vad] [--prompt terms] <audio> [model] [models_dir]"
                .to_string(),
        );
    };
    let model_name = positional.get(1).cloned().unwrap_or_else(|| {
        if provider == "parakeet" {
            "parakeet-tdt-0.6b-v3-int8".to_string()
        } else {
            "tiny".to_string()
        }
    });
    let models_dir = positional.get(2).map(PathBuf::from);

    if !audio_path.exists() {
        fail(format!("audio file not found: {}", audio_path.display()));
    }
    if metrics_path.is_some() && (per_segment || dump_dir.is_some()) {
        fail("--metrics-json cannot be combined with --segments or --dump-segments".to_string());
    }
    if provider == "whisper"
        && let Some(language) = language.as_deref()
        && language != "auto"
        && language != "auto-translate"
        && whisper_rs::get_lang_id(language).is_none()
    {
        fail(format!(
            "unsupported Whisper language '{language}'; use a supported Whisper code"
        ));
    }

    let measured_start = Instant::now();
    let decode_start = Instant::now();
    let decoded = match decode_audio_file(&audio_path) {
        Ok(d) => d,
        Err(e) => fail(format!("audio decode failed: {e}")),
    };
    let decode_seconds = decode_start.elapsed().as_secs_f64();
    eprintln!(
        "decoded {:.1}s of audio ({} Hz, {} ch)",
        decoded.duration_seconds, decoded.sample_rate, decoded.channels
    );

    let samples = decoded.to_whisper_format();
    let mut vad_seconds = 0.0;
    let mut vad_segments = if use_vad {
        let vad_start = Instant::now();
        let segments =
            get_speech_chunks(&samples, 2000).unwrap_or_else(|e| fail(format!("VAD failed: {e}")));
        vad_seconds = vad_start.elapsed().as_secs_f64();
        eprintln!("VAD detected {} speech segments", segments.len());
        Some(segments)
    } else {
        None
    };
    // Dump-only mode: write the VAD segmentation and exit without touching any
    // ASR engine, so external engines can be evaluated on identical segments.
    if let Some(dir) = dump_dir {
        let segments = vad_segments.take().expect("dump mode enables VAD");
        std::fs::create_dir_all(&dir).unwrap_or_else(|e| fail(format!("create dump dir: {e}")));
        for (index, segment) in segments.into_iter().enumerate() {
            if segment.samples.len() < 1600 {
                continue;
            }
            let path = dir.join(format!("seg-{:03}.wav", index + 1));
            write_wav_16k_mono(&path, &segment.samples)
                .unwrap_or_else(|e| fail(format!("write {}: {e}", path.display())));
            println!(
                "{}\t{:.1}\t{}",
                index + 1,
                segment.start_timestamp_ms / 1000.0,
                path.display()
            );
        }
        return;
    }

    let mut model_download_seconds = 0.0;
    let mut inference_seconds = 0.0;
    let (text, model_load_seconds, memory_observation) = if provider == "parakeet" {
        let engine = ParakeetEngine::new_with_models_dir(models_dir)
            .unwrap_or_else(|e| fail(format!("engine init failed: {e}")));
        let models = engine
            .discover_models()
            .await
            .unwrap_or_else(|e| fail(format!("model discovery failed: {e}")));
        let needs_download = models
            .iter()
            .find(|model| model.name == model_name)
            .map(|model| !matches!(model.status, ModelStatus::Available))
            .unwrap_or_else(|| fail(format!("unknown model: {model_name}")));
        if needs_download {
            let download_start = Instant::now();
            download_parakeet_model(&engine, &model_name).await;
            model_download_seconds = download_start.elapsed().as_secs_f64();
        }
        let memory_sampler = metrics_path.as_ref().map(|_| PeakMemorySampler::start());
        let model_load_start = Instant::now();
        engine
            .load_model(&model_name)
            .await
            .unwrap_or_else(|e| fail(format!("model load failed: {e}")));
        let model_load_seconds = model_load_start.elapsed().as_secs_f64();
        let result = if use_vad {
            let segments = vad_segments.take().expect("VAD segments were prepared");
            let mut transcripts = Vec::with_capacity(segments.len());
            for (index, segment) in segments.into_iter().enumerate() {
                if segment.samples.len() < 1600 {
                    continue;
                }
                eprintln!("transcribing VAD segment {}", index + 1);
                let start = segment.start_timestamp_ms / 1000.0;
                let inference_start = Instant::now();
                let text = engine
                    .transcribe_audio(segment.samples)
                    .await
                    .unwrap_or_else(|e| {
                        fail(format!(
                            "transcription failed on segment {}: {e}",
                            index + 1
                        ))
                    });
                inference_seconds += inference_start.elapsed().as_secs_f64();
                // Parakeet exposes no confidence; mirror the app's live gates,
                // which pass its results through the filter unconfidenced.
                let drop_reason =
                    app_lib::audio::transcription::segment_filter::should_drop_segment(&text, None);
                if per_segment {
                    let status = match &drop_reason {
                        Some(reason) => format!("DROPPED({reason:?})"),
                        None => "kept".to_string(),
                    };
                    println!(
                        "{}\t{:.1}s\t-\t{}\t{}",
                        index + 1,
                        start,
                        status,
                        text.trim()
                    );
                }
                if let Some(reason) = drop_reason {
                    eprintln!("dropped VAD segment {} ({reason:?})", index + 1);
                } else if !text.trim().is_empty() {
                    transcripts.push(text.trim().to_string());
                }
            }
            if per_segment {
                return;
            }
            transcripts.join(" ")
        } else {
            let inference_start = Instant::now();
            let transcript = engine
                .transcribe_audio(samples)
                .await
                .unwrap_or_else(|e| fail(format!("transcription failed: {e}")));
            inference_seconds = inference_start.elapsed().as_secs_f64();
            transcript
        };
        let memory_observation = memory_sampler.map(PeakMemorySampler::finish);
        (result, model_load_seconds, memory_observation)
    } else {
        let engine = WhisperEngine::new_with_models_dir(models_dir)
            .unwrap_or_else(|e| fail(format!("engine init failed: {e}")));
        let models = engine
            .discover_models()
            .await
            .unwrap_or_else(|e| fail(format!("model discovery failed: {e}")));
        let needs_download = models
            .iter()
            .find(|model| model.name == model_name)
            .map(|model| !matches!(model.status, ModelStatus::Available))
            .unwrap_or_else(|| fail(format!("unknown model: {model_name}")));
        if needs_download {
            let download_start = Instant::now();
            download_whisper_model(&engine, &model_name).await;
            model_download_seconds = download_start.elapsed().as_secs_f64();
        }
        let memory_sampler = metrics_path.as_ref().map(|_| PeakMemorySampler::start());
        let model_load_start = Instant::now();
        engine
            .load_model(&model_name)
            .await
            .unwrap_or_else(|e| fail(format!("model load failed: {e}")));
        let model_load_seconds = model_load_start.elapsed().as_secs_f64();
        if let Some(prompt) = prompt {
            set_meeting_prompt_terms(
                prompt
                    .split(',')
                    .map(str::trim)
                    .filter(|term| !term.is_empty())
                    .map(str::to_string)
                    .collect(),
            );
        }
        // A stale lock from a previous run can never exist in a fresh process,
        // but mirror the app's session boundaries anyway.
        app_lib::whisper_engine::reset_session_detected_language();
        let result = if use_vad {
            let segments = vad_segments.take().expect("VAD segments were prepared");
            let mut transcripts = Vec::with_capacity(segments.len());
            for (index, segment) in segments.into_iter().enumerate() {
                if segment.samples.len() < 1600 {
                    continue;
                }
                eprintln!("transcribing VAD segment {}", index + 1);
                let start = segment.start_timestamp_ms / 1000.0;
                let inference_start = Instant::now();
                let (text, confidence, _) = engine
                    .transcribe_audio_with_confidence(segment.samples, language.clone())
                    .await
                    .unwrap_or_else(|e| {
                        fail(format!(
                            "transcription failed on segment {}: {e}",
                            index + 1
                        ))
                    });
                inference_seconds += inference_start.elapsed().as_secs_f64();
                let drop_reason =
                    app_lib::audio::transcription::segment_filter::should_drop_segment(
                        &text,
                        Some(confidence),
                    );
                if per_segment {
                    let status = match &drop_reason {
                        Some(reason) => format!("DROPPED({reason:?})"),
                        None => "kept".to_string(),
                    };
                    println!(
                        "{}\t{:.1}s\t{:.2}\t{}\t{}",
                        index + 1,
                        start,
                        confidence,
                        status,
                        text.trim()
                    );
                }
                if let Some(reason) = drop_reason {
                    eprintln!("dropped VAD segment {} ({reason:?})", index + 1);
                } else if !text.trim().is_empty() {
                    transcripts.push(text.trim().to_string());
                }
            }
            if per_segment {
                return;
            }
            transcripts.join(" ")
        } else {
            let inference_start = Instant::now();
            let transcript = engine
                .transcribe_audio(samples, language)
                .await
                .unwrap_or_else(|e| fail(format!("transcription failed: {e}")));
            inference_seconds = inference_start.elapsed().as_secs_f64();
            transcript
        };
        let memory_observation = memory_sampler.map(PeakMemorySampler::finish);
        (result, model_load_seconds, memory_observation)
    };
    println!("{}", text.trim());

    if let Some(metrics_path) = metrics_path {
        let memory = memory_observation.expect("metrics run starts a memory sampler");
        let metrics = EvalMetrics {
            schema_version: 1,
            provider: provider.clone(),
            model: model_name.clone(),
            backend: compiled_backend(&provider),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            audio_duration_seconds: decoded.duration_seconds,
            decode_seconds,
            vad_seconds,
            model_download_seconds,
            model_load_seconds,
            inference_seconds,
            inference_rtf: inference_seconds / decoded.duration_seconds.max(f64::EPSILON),
            measured_total_seconds: measured_start.elapsed().as_secs_f64(),
            baseline_rss_mb: megabytes(memory.baseline_bytes),
            peak_rss_mb: megabytes(memory.peak_bytes),
            peak_rss_delta_mb: megabytes(memory.peak_bytes.saturating_sub(memory.baseline_bytes)),
        };
        if let Some(parent) = metrics_path.parent() {
            std::fs::create_dir_all(parent)
                .unwrap_or_else(|e| fail(format!("create metrics directory failed: {e}")));
        }
        let json = serde_json::to_vec_pretty(&metrics)
            .unwrap_or_else(|e| fail(format!("serialize metrics failed: {e}")));
        std::fs::write(&metrics_path, json)
            .unwrap_or_else(|e| fail(format!("write metrics failed: {e}")));
    }
}

/// Minimal 16-bit PCM mono 16 kHz WAV writer (44-byte RIFF header), so the
/// example carries no audio-encoding dependency.
fn write_wav_16k_mono(path: &std::path::Path, samples: &[f32]) -> std::io::Result<()> {
    const SAMPLE_RATE: u32 = 16_000;
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    bytes.extend_from_slice(&2u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let clamped = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&clamped.to_le_bytes());
    }
    std::fs::write(path, bytes)
}

fn progress_callback() -> Box<dyn Fn(u8) + Send> {
    Box::new(|percent| {
        eprint!("\rdownload: {percent}%");
        let _ = std::io::stderr().flush();
    })
}

async fn download_whisper_model(engine: &WhisperEngine, model_name: &str) {
    eprintln!("downloading model '{model_name}' (first run)...");
    if let Err(error) = engine
        .download_model(model_name, Some(progress_callback()))
        .await
    {
        fail(format!("model download failed: {error}"));
    }
    eprintln!();
    if let Err(error) = engine.discover_models().await {
        fail(format!("model rediscovery failed: {error}"));
    }
}

async fn download_parakeet_model(engine: &ParakeetEngine, model_name: &str) {
    eprintln!("downloading model '{model_name}' (first run)...");
    if let Err(error) = engine
        .download_model(model_name, Some(progress_callback()))
        .await
    {
        fail(format!("model download failed: {error}"));
    }
    eprintln!();
    if let Err(error) = engine.discover_models().await {
        fail(format!("model rediscovery failed: {error}"));
    }
}
