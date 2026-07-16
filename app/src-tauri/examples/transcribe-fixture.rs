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
//!        [--metrics-json <path> --expected-audio-sha256 <lowercase-sha256>]
//!        [--hardware-json]
//!        [--prepare-model-json --model <name> [--models-dir <path>]]
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

use std::ffi::CStr;
use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::os::raw::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use app_lib::audio::decoder::{decode_audio_file, decode_audio_file_handle};
use app_lib::audio::vad::get_speech_chunks;
use app_lib::parakeet_engine::engine::ParakeetEngine;
use app_lib::transcription_models::ModelStatus;
use app_lib::vocabulary::set_meeting_prompt_terms;
use app_lib::whisper_engine::engine::WhisperEngine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use whisper_rs::whisper_rs_sys::ggml_log_level;

const GPU_BACKEND_USE_PREFIX: &[u8] = b"whisper_backend_init_gpu: using ";
const GPU_BACKEND_USE_SUFFIX: &[u8] = b" backend";
const GPU_BACKEND_FAILURE_PREFIX: &[u8] = b"whisper_backend_init_gpu: failed to initialize ";
const GPU_BACKEND_NO_DEVICE: &[u8] = b"whisper_backend_init_gpu: no GPU found";
const COREML_ATTEMPT_PREFIX: &[u8] = b"whisper_init_state: loading Core ML model from '";
const COREML_FAILURE_PREFIX: &[u8] = b"whisper_init_state: failed to load Core ML model from '";
const COREML_SUCCESS: &[u8] = b"whisper_init_state: Core ML model loaded";
const AUDIO_ATTESTATION_BUFFER_BYTES: usize = 64 * 1024;

static EVALUATOR_WHISPER_RUNTIME_ATTESTATION: OnceLock<
    Mutex<Option<EvaluatorWhisperRuntimeAttestation>>,
> = OnceLock::new();

#[derive(Serialize)]
struct EvalMetrics {
    schema_version: u8,
    provider: String,
    model: String,
    backend: String,
    operating_system: &'static str,
    architecture: &'static str,
    hardware_profile: String,
    accelerator: String,
    benchmark_executable_sha256: String,
    audio_sha256: String,
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

#[derive(Serialize)]
struct HardwareProbe {
    schema_version: u8,
    backend: String,
    operating_system: &'static str,
    architecture: &'static str,
    hardware_profile: String,
    accelerator: String,
    benchmark_executable_sha256: String,
}

#[derive(Serialize)]
struct PreparedModel {
    schema_version: u8,
    provider: String,
    model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchmarkBackend {
    Cpu,
    OpenBlasCpu,
    Metal,
    CoreMlMetal,
    Cuda,
    Vulkan,
    HipBlas,
    OnnxCpu,
}

impl BenchmarkBackend {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::OpenBlasCpu => "openblas-cpu",
            Self::Metal => "metal",
            Self::CoreMlMetal => "coreml-metal",
            Self::Cuda => "cuda",
            Self::Vulkan => "vulkan",
            Self::HipBlas => "hipblas",
            Self::OnnxCpu => "onnx-cpu",
        }
    }

    fn is_gpu(self) -> bool {
        matches!(
            self,
            Self::Metal | Self::CoreMlMetal | Self::Cuda | Self::Vulkan | Self::HipBlas
        )
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct WhisperBackendFeatures {
    coreml: bool,
    metal: bool,
    cuda: bool,
    vulkan: bool,
    hipblas: bool,
    openblas: bool,
}

struct BenchmarkHardware {
    backend: BenchmarkBackend,
    hardware_profile: String,
    accelerator: String,
    whisper_gpu_device_name: Option<String>,
}

#[derive(Debug)]
struct EvaluatorWhisperRuntimeAttestation {
    expected_gpu_use_line: Vec<u8>,
    expected_gpu_failure_line: Vec<u8>,
    gpu_backend_uses: u64,
    gpu_initialization_failures: u64,
    missing_gpu_states: u64,
    unexpected_gpu_events: u64,
    coreml_attempts: u64,
    coreml_successes: u64,
    coreml_failures: u64,
}

impl EvaluatorWhisperRuntimeAttestation {
    fn new(expected_gpu_device_name: &str) -> Self {
        let mut expected_gpu_use_line = GPU_BACKEND_USE_PREFIX.to_vec();
        expected_gpu_use_line.extend_from_slice(expected_gpu_device_name.as_bytes());
        expected_gpu_use_line.extend_from_slice(GPU_BACKEND_USE_SUFFIX);

        let mut expected_gpu_failure_line = GPU_BACKEND_FAILURE_PREFIX.to_vec();
        expected_gpu_failure_line.extend_from_slice(expected_gpu_device_name.as_bytes());
        expected_gpu_failure_line.extend_from_slice(GPU_BACKEND_USE_SUFFIX);

        Self {
            expected_gpu_use_line,
            expected_gpu_failure_line,
            gpu_backend_uses: 0,
            gpu_initialization_failures: 0,
            missing_gpu_states: 0,
            unexpected_gpu_events: 0,
            coreml_attempts: 0,
            coreml_successes: 0,
            coreml_failures: 0,
        }
    }

    fn observe(&mut self, message: &[u8]) {
        let line = strip_single_log_line_ending(message);

        if line == self.expected_gpu_use_line {
            self.gpu_backend_uses = self.gpu_backend_uses.saturating_add(1);
        } else if line.starts_with(GPU_BACKEND_USE_PREFIX) && line.ends_with(GPU_BACKEND_USE_SUFFIX)
        {
            self.unexpected_gpu_events = self.unexpected_gpu_events.saturating_add(1);
        }

        if line == self.expected_gpu_failure_line {
            self.gpu_initialization_failures = self.gpu_initialization_failures.saturating_add(1);
        } else if line.starts_with(GPU_BACKEND_FAILURE_PREFIX)
            && line.ends_with(GPU_BACKEND_USE_SUFFIX)
        {
            self.unexpected_gpu_events = self.unexpected_gpu_events.saturating_add(1);
        }

        if line == GPU_BACKEND_NO_DEVICE {
            self.missing_gpu_states = self.missing_gpu_states.saturating_add(1);
        }

        if line.starts_with(COREML_ATTEMPT_PREFIX) && line.ends_with(b"'") {
            self.coreml_attempts = self.coreml_attempts.saturating_add(1);
        } else if line.starts_with(COREML_FAILURE_PREFIX) && line.ends_with(b"'") {
            self.coreml_failures = self.coreml_failures.saturating_add(1);
        } else if line == COREML_SUCCESS {
            self.coreml_successes = self.coreml_successes.saturating_add(1);
        }
    }

    fn verify(&self, backend: BenchmarkBackend) -> Result<(), String> {
        if self.gpu_backend_uses == 0 {
            return Err(format!(
                "{} runtime proof observed no model context or decoder state using the requested GPU backend",
                backend.as_str()
            ));
        }
        if self.unexpected_gpu_events > 0 {
            return Err(format!(
                "{} runtime proof observed an unexpected GPU backend or device",
                backend.as_str()
            ));
        }
        if self.missing_gpu_states > 0 {
            return Err(format!(
                "{} runtime proof observed a decoder state falling back after no GPU was found",
                backend.as_str()
            ));
        }
        if self.gpu_initialization_failures > 0 {
            return Err(format!(
                "{} runtime proof observed a GPU backend initialization failure",
                backend.as_str()
            ));
        }

        if backend == BenchmarkBackend::CoreMlMetal {
            if self.coreml_attempts == 0 {
                return Err(
                    "Core ML runtime proof observed no encoder initialization attempt".to_string(),
                );
            }
            if self.coreml_failures > 0 {
                return Err(
                    "Core ML runtime proof observed an encoder initialization failure".to_string(),
                );
            }
            // whisper-rs loads the model through whisper.cpp's no-state context
            // initializer, so model loading does not select a runtime backend.
            // Every subsequently created decoder state selects one ggml GPU
            // backend and makes one Core ML encoder load attempt.
            if self.gpu_backend_uses != self.coreml_attempts {
                return Err(format!(
                    "Core ML runtime proof observed {} GPU backend selections for {} Core ML state initialization attempts",
                    self.gpu_backend_uses, self.coreml_attempts
                ));
            }
            if self.coreml_successes != self.coreml_attempts {
                return Err(format!(
                    "Core ML runtime proof observed {} successful encoder loads for {} decoder states",
                    self.coreml_successes, self.coreml_attempts
                ));
            }
        } else if self.coreml_attempts > 0 || self.coreml_successes > 0 || self.coreml_failures > 0
        {
            return Err(format!(
                "{} runtime proof unexpectedly observed Core ML encoder activity",
                backend.as_str()
            ));
        }

        Ok(())
    }
}

struct MemoryObservation {
    baseline_bytes: u64,
    peak_bytes: u64,
}

struct PeakMemorySampler {
    pid: sysinfo::Pid,
    baseline_bytes: u64,
    peak_bytes: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl PeakMemorySampler {
    fn start() -> Result<Self, String> {
        let pid = sysinfo::get_current_pid()
            .map_err(|error| format!("could not determine current process id: {error}"))?;
        let baseline_bytes = current_process_memory(pid)?;
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
        Ok(Self {
            pid,
            baseline_bytes,
            peak_bytes,
            stop,
            handle: Some(handle),
        })
    }

    fn finish(mut self) -> Result<MemoryObservation, String> {
        let final_memory = current_process_memory(self.pid);
        if let Ok(final_bytes) = &final_memory {
            self.peak_bytes.fetch_max(*final_bytes, Ordering::Relaxed);
        }
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .map_err(|_| "peak-memory sampler thread panicked".to_string())?;
        }
        final_memory?;
        Ok(MemoryObservation {
            baseline_bytes: self.baseline_bytes,
            peak_bytes: self.peak_bytes.load(Ordering::Relaxed),
        })
    }
}

fn current_process_memory(pid: sysinfo::Pid) -> Result<u64, String> {
    let pids = [pid];
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing().with_memory(),
    );
    let memory = system
        .process(pid)
        .map(sysinfo::Process::memory)
        .ok_or_else(|| "current process RSS is unavailable".to_string())?;
    if memory == 0 {
        return Err("current process RSS is zero".to_string());
    }
    Ok(memory)
}

fn configured_whisper_features() -> WhisperBackendFeatures {
    WhisperBackendFeatures {
        coreml: cfg!(feature = "coreml"),
        metal: cfg!(feature = "metal"),
        cuda: cfg!(feature = "cuda"),
        vulkan: cfg!(feature = "vulkan"),
        hipblas: cfg!(feature = "hipblas"),
        openblas: cfg!(feature = "openblas"),
    }
}

fn environment_flag(name: &str) -> Result<bool, String> {
    match std::env::var(name) {
        Ok(value) => match value.trim() {
            "" | "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(format!("{name} must be 0 or 1")),
        },
        Err(std::env::VarError::NotPresent) => Ok(false),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must contain valid UTF-8")),
    }
}

fn resolve_whisper_backend(
    target_os: &str,
    features: WhisperBackendFeatures,
    force_cpu: bool,
    require_acceleration: bool,
) -> Result<BenchmarkBackend, String> {
    let enabled_features = [
        (features.coreml, "coreml"),
        (features.metal, "metal"),
        (features.cuda, "cuda"),
        (features.vulkan, "vulkan"),
        (features.hipblas, "hipblas"),
        (features.openblas, "openblas"),
    ]
    .into_iter()
    .filter_map(|(enabled, name)| enabled.then_some(name))
    .collect::<Vec<_>>();
    if enabled_features.len() > 1 {
        return Err(format!(
            "ambiguous Whisper benchmark build: multiple backend features are enabled ({})",
            enabled_features.join(", ")
        ));
    }
    if features.coreml && target_os != "macos" {
        return Err("the coreml benchmark backend is supported only on macOS".to_string());
    }
    if features.metal && target_os != "macos" {
        return Err("the metal benchmark backend is supported only on macOS".to_string());
    }
    if features.hipblas && target_os != "linux" {
        return Err("the hipblas benchmark backend is supported only on Linux".to_string());
    }
    if force_cpu && require_acceleration {
        return Err(
            "MUESLY_WHISPER_FORCE_CPU=1 conflicts with MUESLY_WHISPER_REQUIRE_ACCELERATION=1"
                .to_string(),
        );
    }

    let backend = if force_cpu {
        if features.openblas {
            BenchmarkBackend::OpenBlasCpu
        } else {
            BenchmarkBackend::Cpu
        }
    } else if features.coreml {
        BenchmarkBackend::CoreMlMetal
    } else if features.metal {
        BenchmarkBackend::Metal
    } else if features.cuda {
        BenchmarkBackend::Cuda
    } else if features.vulkan {
        BenchmarkBackend::Vulkan
    } else if features.hipblas {
        BenchmarkBackend::HipBlas
    } else if target_os == "macos" {
        // WhisperCompiledBackend::current() uses Metal on macOS even when no
        // explicit crate feature is selected. The eval harness sets
        // MUESLY_WHISPER_FORCE_CPU=1 for an intentional CPU measurement.
        BenchmarkBackend::Metal
    } else if features.openblas {
        BenchmarkBackend::OpenBlasCpu
    } else {
        BenchmarkBackend::Cpu
    };

    if require_acceleration && !backend.is_gpu() {
        return Err(format!(
            "MUESLY_WHISPER_REQUIRE_ACCELERATION=1 cannot be satisfied by the {} backend",
            backend.as_str()
        ));
    }
    Ok(backend)
}

fn resolved_benchmark_backend(provider: &str) -> Result<BenchmarkBackend, String> {
    match provider {
        "parakeet" => Ok(BenchmarkBackend::OnnxCpu),
        "whisper" => resolve_whisper_backend(
            std::env::consts::OS,
            configured_whisper_features(),
            environment_flag("MUESLY_WHISPER_FORCE_CPU")?,
            environment_flag("MUESLY_WHISPER_REQUIRE_ACCELERATION")?,
        ),
        _ => Err(format!(
            "unknown provider '{provider}'; expected whisper or parakeet"
        )),
    }
}

fn megabytes(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn validate_hardware_label(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.contains(';') || value.chars().any(char::is_control) {
        return Err(format!(
            "{label} cannot contain semicolons or control characters"
        ));
    }
    Ok(())
}

fn validate_accelerator_label(backend: BenchmarkBackend, accelerator: &str) -> Result<(), String> {
    validate_hardware_label(accelerator, "MUESLY_EVAL_ACCELERATOR_ID")?;
    if backend.is_gpu() && accelerator.eq_ignore_ascii_case("none") {
        return Err(format!(
            "{} metrics require a real accelerator identity, not 'none'",
            backend.as_str()
        ));
    }
    Ok(())
}

fn validate_runtime_env_sha256(value: String) -> Result<String, String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(
            "MUESLY_EVAL_RUNTIME_ENV_SHA256 must be a lowercase SHA-256 digest".to_string(),
        );
    }
    Ok(value)
}

fn required_runtime_env_sha256() -> Result<String, String> {
    let value = std::env::var("MUESLY_EVAL_RUNTIME_ENV_SHA256").map_err(|error| match error {
        std::env::VarError::NotPresent => {
            "MUESLY_EVAL_RUNTIME_ENV_SHA256 is required for benchmark provenance".to_string()
        }
        std::env::VarError::NotUnicode(_) => {
            "MUESLY_EVAL_RUNTIME_ENV_SHA256 must contain valid UTF-8".to_string()
        }
    })?;
    validate_runtime_env_sha256(value)
}

fn gpu_accelerator_identity(
    backend: BenchmarkBackend,
    configured: &str,
    detected: &str,
) -> Result<String, String> {
    validate_accelerator_label(backend, configured)?;
    validate_hardware_label(detected, "detected GPU device name")?;
    Ok(format!("{configured} [ggml={detected}]"))
}

fn benchmark_hardware(provider: &str, verify_gpu: bool) -> Result<BenchmarkHardware, String> {
    let backend = resolved_benchmark_backend(provider)?;
    let runtime_env_sha256 = required_runtime_env_sha256()?;
    let detected_gpu_name = if verify_gpu && backend.is_gpu() {
        Some(
            app_lib::whisper_engine::verify_gpu_backend_available(0).map_err(|error| {
                format!(
                    "{} benchmark backend is unavailable: {error}",
                    backend.as_str()
                )
            })?,
        )
    } else {
        None
    };
    if backend.is_gpu() && detected_gpu_name.is_none() {
        return Err(format!(
            "{} benchmark identity requires a verified GPU device",
            backend.as_str()
        ));
    }

    let system = System::new_all();
    let cpu_model = system
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim())
        .filter(|brand| !brand.is_empty())
        .ok_or_else(|| "could not determine a stable CPU model".to_string())?;
    validate_hardware_label(cpu_model, "CPU model")?;
    if system.cpus().is_empty() {
        return Err("could not determine the logical CPU count".to_string());
    }
    if system.total_memory() == 0 {
        return Err("could not determine total system memory".to_string());
    }

    let configured_accelerator = match std::env::var("MUESLY_EVAL_ACCELERATOR_ID") {
        Ok(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        }
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("MUESLY_EVAL_ACCELERATOR_ID must contain valid UTF-8".to_string());
        }
    };
    let accelerator = if backend.is_gpu() {
        let configured = match backend {
            BenchmarkBackend::Metal | BenchmarkBackend::CoreMlMetal
                if cfg!(all(target_os = "macos", target_arch = "aarch64")) =>
            {
                configured_accelerator.unwrap_or_else(|| format!("{cpu_model} integrated GPU"))
            }
            _ => configured_accelerator.unwrap_or_default(),
        };
        if configured.is_empty() {
            return Err(format!(
                "{} metrics require MUESLY_EVAL_ACCELERATOR_ID with a stable accelerator model or device identifier",
                backend.as_str()
            ));
        }
        gpu_accelerator_identity(
            backend,
            &configured,
            detected_gpu_name
                .as_deref()
                .expect("GPU backends require a verified device name"),
        )?
    } else {
        "none".to_string()
    };

    Ok(BenchmarkHardware {
        backend,
        hardware_profile: format!(
            "cpu={cpu_model};logical_cpus={};memory_bytes={};runtime_env_sha256={runtime_env_sha256}",
            system.cpus().len(),
            system.total_memory()
        ),
        accelerator,
        whisper_gpu_device_name: detected_gpu_name,
    })
}

fn benchmark_executable_sha256() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "could not locate the current benchmark executable".to_string())?;
    app_lib::model_integrity::sha256_file(&executable)
        .map_err(|_| "could not hash the current benchmark executable".to_string())
}

fn validate_audio_sha256(value: String) -> Result<String, String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("--expected-audio-sha256 must be a lowercase SHA-256 digest".to_string());
    }
    Ok(value)
}

fn sha256_file_handle(file: &mut File) -> Result<String, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek staged audio for hashing failed: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; AUDIO_ATTESTATION_BUFFER_BYTES];
    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("read staged audio for hashing failed: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind staged audio after hashing failed: {error}"))?;
    Ok(hex::encode(hasher.finalize()))
}

fn stage_attested_wav(audio_path: &Path, expected_sha256: &str) -> Result<(File, String), String> {
    let mut source = File::open(audio_path)
        .map_err(|error| format!("open audio file '{}' failed: {error}", audio_path.display()))?;
    let metadata = source.metadata().map_err(|error| {
        format!(
            "inspect audio file '{}' failed: {error}",
            audio_path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "audio source must be a regular file: {}",
            audio_path.display()
        ));
    }

    let mut staged = tempfile::tempfile()
        .map_err(|error| format!("create private audio staging file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; AUDIO_ATTESTATION_BUFFER_BYTES];
    loop {
        let bytes_read = source
            .read(&mut buffer)
            .map_err(|error| format!("read audio source failed: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
        staged
            .write_all(&buffer[..bytes_read])
            .map_err(|error| format!("stage private audio failed: {error}"))?;
    }
    staged
        .flush()
        .map_err(|error| format!("flush private audio staging file failed: {error}"))?;
    let actual_sha256 = hex::encode(hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err("audio SHA-256 does not match --expected-audio-sha256".to_string());
    }

    staged
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind private audio staging file failed: {error}"))?;
    let mut header = [0u8; 12];
    staged
        .read_exact(&mut header)
        .map_err(|_| "attested audio must be a RIFF/WAVE file".to_string())?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err("attested audio must be a RIFF/WAVE file".to_string());
    }
    staged
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("rewind attested WAV failed: {error}"))?;

    Ok((staged, actual_sha256))
}

fn fail(msg: String) -> ! {
    eprintln!("transcribe-fixture: {msg}");
    std::process::exit(1);
}

fn required_option_value(raw_args: &[String], index: usize, option: &str) -> String {
    let value = raw_args
        .get(index)
        .filter(|value| !value.trim().is_empty() && !value.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| fail(format!("{option} requires a value")));
    if value != value.trim() || value.chars().any(char::is_control) {
        fail(format!(
            "{option} requires a trimmed value without control characters"
        ));
    }
    value
}

fn require_explicit_control_provider(
    provider_was_explicit: bool,
    control_mode: &str,
) -> Result<(), String> {
    if provider_was_explicit {
        Ok(())
    } else {
        Err(format!(
            "{control_mode} requires exactly one explicit --provider"
        ))
    }
}

fn coreml_encoder_bundle_path(model_path: &Path) -> PathBuf {
    // Mirror whisper.cpp's whisper_get_coreml_path_encoder byte-for-byte:
    // remove the final extension, then a trailing five-character `-qX_Y`
    // quantization suffix, then append `-encoder.mlmodelc`.
    let mut base = model_path.to_string_lossy().into_owned();
    if let Some(extension) = base.rfind('.') {
        base.truncate(extension);
    }
    if let Some(suffix_start) = base.rfind('-') {
        let suffix = &base.as_bytes()[suffix_start..];
        if suffix.len() == 5 && suffix[1] == b'q' && suffix[3] == b'_' {
            base.truncate(suffix_start);
        }
    }
    PathBuf::from(format!("{base}-encoder.mlmodelc"))
}

fn require_coreml_encoder_bundle(model_path: &Path) -> Result<(), String> {
    let bundle_path = coreml_encoder_bundle_path(model_path);
    let metadata = std::fs::symlink_metadata(&bundle_path)
        .map_err(|_| "required Core ML encoder bundle is missing".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("required Core ML encoder bundle must be a real directory".to_string());
    }
    let mut entries = std::fs::read_dir(&bundle_path)
        .map_err(|_| "required Core ML encoder bundle cannot be read".to_string())?;
    if entries.next().is_none() {
        return Err("required Core ML encoder bundle is empty".to_string());
    }
    Ok(())
}

fn strip_single_log_line_ending(message: &[u8]) -> &[u8] {
    let message = message.strip_suffix(b"\n").unwrap_or(message);
    message.strip_suffix(b"\r").unwrap_or(message)
}

fn evaluator_whisper_runtime_attestation()
-> &'static Mutex<Option<EvaluatorWhisperRuntimeAttestation>> {
    EVALUATOR_WHISPER_RUNTIME_ATTESTATION.get_or_init(|| Mutex::new(None))
}

// SAFETY: whisper.cpp owns `text` for the duration of this callback. The
// callback never unwinds, never retains the pointer, and deliberately emits no
// raw whisper.cpp text so model paths and transcript-adjacent content cannot
// enter evaluator logs.
unsafe extern "C" fn evaluator_whisper_log_callback(
    _level: ggml_log_level,
    text: *const c_char,
    _user_data: *mut c_void,
) {
    if text.is_null() {
        return;
    }
    let message = unsafe { CStr::from_ptr(text) }.to_bytes();
    let mut attestation = evaluator_whisper_runtime_attestation()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(attestation) = attestation.as_mut() {
        attestation.observe(message);
    }
}

fn install_evaluator_whisper_log_callback(expected_gpu_device_name: &str) {
    {
        let mut attestation = evaluator_whisper_runtime_attestation()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *attestation = Some(EvaluatorWhisperRuntimeAttestation::new(
            expected_gpu_device_name,
        ));
    }
    // SAFETY: evaluator_whisper_log_callback follows whisper-rs's callback
    // contract and uses no user-data pointer.
    unsafe {
        whisper_rs::set_log_callback(Some(evaluator_whisper_log_callback), std::ptr::null_mut());
    }
}

fn verify_evaluator_whisper_runtime_attestation(backend: BenchmarkBackend) -> Result<(), String> {
    let attestation = evaluator_whisper_runtime_attestation()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attestation
        .as_ref()
        .ok_or_else(|| "Whisper runtime attestation was not installed".to_string())?
        .verify(backend)
}

#[tokio::main]
async fn main() {
    // Surface engine logs (e.g. lang-lock decisions) on stderr under RUST_LOG.
    let _ = env_logger::try_init();
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let mut provider = "whisper".to_string();
    let mut provider_was_explicit = false;
    let mut language = None;
    let mut use_vad = false;
    let mut per_segment = false;
    let mut dump_dir: Option<PathBuf> = None;
    let mut metrics_path: Option<PathBuf> = None;
    let mut expected_audio_sha256 = None;
    let mut hardware_json = false;
    let mut prepare_model_json = false;
    let mut prepared_model_name = None;
    let mut prepared_models_dir: Option<PathBuf> = None;
    let mut prompt = None;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < raw_args.len() {
        match raw_args[index].as_str() {
            "--provider" => {
                if provider_was_explicit {
                    fail("--provider may only be provided once".to_string());
                }
                provider_was_explicit = true;
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
            "--expected-audio-sha256" => {
                if expected_audio_sha256.is_some() {
                    fail("--expected-audio-sha256 may only be provided once".to_string());
                }
                index += 1;
                expected_audio_sha256 = Some(
                    validate_audio_sha256(required_option_value(
                        &raw_args,
                        index,
                        "--expected-audio-sha256",
                    ))
                    .unwrap_or_else(|error| fail(error)),
                );
            }
            "--hardware-json" => {
                if hardware_json {
                    fail("--hardware-json may only be provided once".to_string());
                }
                hardware_json = true;
            }
            "--prepare-model-json" => {
                if prepare_model_json {
                    fail("--prepare-model-json may only be provided once".to_string());
                }
                prepare_model_json = true;
            }
            "--model" => {
                if prepared_model_name.is_some() {
                    fail("--model may only be provided once".to_string());
                }
                index += 1;
                prepared_model_name = Some(required_option_value(&raw_args, index, "--model"));
            }
            "--models-dir" => {
                if prepared_models_dir.is_some() {
                    fail("--models-dir may only be provided once".to_string());
                }
                index += 1;
                prepared_models_dir = Some(PathBuf::from(required_option_value(
                    &raw_args,
                    index,
                    "--models-dir",
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
    if hardware_json {
        require_explicit_control_provider(provider_was_explicit, "--hardware-json")
            .unwrap_or_else(|error| fail(error));
        if language.is_some()
            || use_vad
            || per_segment
            || dump_dir.is_some()
            || metrics_path.is_some()
            || expected_audio_sha256.is_some()
            || prepare_model_json
            || prepared_model_name.is_some()
            || prepared_models_dir.is_some()
            || prompt.is_some()
            || !positional.is_empty()
        {
            fail("--hardware-json can only be combined with --provider".to_string());
        }
        let hardware =
            benchmark_hardware(&provider, true).unwrap_or_else(|error| fail(error.to_string()));
        let probe = HardwareProbe {
            schema_version: 1,
            backend: hardware.backend.as_str().to_string(),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            hardware_profile: hardware.hardware_profile,
            accelerator: hardware.accelerator,
            benchmark_executable_sha256: benchmark_executable_sha256()
                .unwrap_or_else(|error| fail(error.to_string())),
        };
        let json = serde_json::to_string(&probe)
            .unwrap_or_else(|error| fail(format!("serialize hardware probe failed: {error}")));
        println!("{json}");
        return;
    }
    if prepare_model_json {
        require_explicit_control_provider(provider_was_explicit, "--prepare-model-json")
            .unwrap_or_else(|error| fail(error));
        if language.is_some()
            || use_vad
            || per_segment
            || dump_dir.is_some()
            || metrics_path.is_some()
            || expected_audio_sha256.is_some()
            || hardware_json
            || prompt.is_some()
            || !positional.is_empty()
        {
            fail(
                "--prepare-model-json can only be combined with --provider, --model, and --models-dir"
                    .to_string(),
            );
        }
        let model_name = prepared_model_name
            .take()
            .unwrap_or_else(|| fail("--prepare-model-json requires --model".to_string()));
        prepare_model(&provider, &model_name, prepared_models_dir).await;
        let prepared = PreparedModel {
            schema_version: 1,
            provider,
            model: model_name,
        };
        let json = serde_json::to_string(&prepared)
            .unwrap_or_else(|error| fail(format!("serialize prepared model failed: {error}")));
        println!("{json}");
        return;
    }
    if prepared_model_name.is_some() || prepared_models_dir.is_some() {
        fail("--model and --models-dir require --prepare-model-json".to_string());
    }
    let Some(audio_path) = positional.first().map(PathBuf::from) else {
        fail(
            "usage: transcribe-fixture [--provider whisper|parakeet] [--language en] [--vad] [--metrics-json path --expected-audio-sha256 digest] [--hardware-json] [--prepare-model-json --model name [--models-dir path]] [--prompt terms] <audio> [model] [models_dir]"
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

    if metrics_path.is_some() && (per_segment || dump_dir.is_some()) {
        fail("--metrics-json cannot be combined with --segments or --dump-segments".to_string());
    }
    if metrics_path.is_some() && expected_audio_sha256.is_none() {
        fail("--metrics-json requires --expected-audio-sha256".to_string());
    }
    if metrics_path.is_none() && expected_audio_sha256.is_some() {
        fail("--expected-audio-sha256 requires --metrics-json".to_string());
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

    let benchmark_provenance = metrics_path.as_ref().map(|_| {
        let hardware =
            benchmark_hardware(&provider, true).unwrap_or_else(|error| fail(error.to_string()));
        let executable_sha256 =
            benchmark_executable_sha256().unwrap_or_else(|error| fail(error.to_string()));
        (hardware, executable_sha256)
    });
    let whisper_runtime_proof_backend = benchmark_provenance.as_ref().and_then(|(hardware, _)| {
        hardware
            .whisper_gpu_device_name
            .as_deref()
            .map(|device_name| {
                install_evaluator_whisper_log_callback(device_name);
                hardware.backend
            })
    });
    let coreml_runtime_proof_required =
        whisper_runtime_proof_backend == Some(BenchmarkBackend::CoreMlMetal);
    let (mut staged_audio, audio_sha256) = match expected_audio_sha256.as_deref() {
        Some(expected_sha256) => {
            let (staged, actual_sha256) = stage_attested_wav(&audio_path, expected_sha256)
                .unwrap_or_else(|error| fail(error));
            (Some(staged), Some(actual_sha256))
        }
        None => (None, None),
    };
    let measured_start = Instant::now();
    let decode_start = Instant::now();
    let decoded = match staged_audio.as_ref() {
        Some(staged) => {
            let decode_handle = staged
                .try_clone()
                .unwrap_or_else(|error| fail(format!("clone attested WAV handle failed: {error}")));
            decode_audio_file_handle(decode_handle, "wav")
        }
        None => decode_audio_file(&audio_path),
    };
    let decoded = match decoded {
        Ok(d) => d,
        Err(e) => fail(format!("audio decode failed: {e}")),
    };
    let decode_seconds = decode_start.elapsed().as_secs_f64();
    let audio_reattest_duration = if let (Some(staged), Some(expected_sha256)) =
        (staged_audio.as_mut(), audio_sha256.as_ref())
    {
        let reattest_start = Instant::now();
        let audio_sha256_after = sha256_file_handle(staged).unwrap_or_else(|error| fail(error));
        let duration = reattest_start.elapsed();
        if audio_sha256_after != *expected_sha256 {
            fail("attested audio changed while it was being decoded".to_string());
        }
        duration
    } else {
        Duration::ZERO
    };
    drop(staged_audio);
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
        let memory_sampler = metrics_path.as_ref().map(|_| {
            PeakMemorySampler::start()
                .unwrap_or_else(|error| fail(format!("peak-memory sampler failed: {error}")))
        });
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
        let memory_observation = memory_sampler.map(|sampler| {
            sampler
                .finish()
                .unwrap_or_else(|error| fail(format!("peak-memory sampler failed: {error}")))
        });
        (result, model_load_seconds, memory_observation)
    } else {
        let engine = WhisperEngine::new_with_models_dir(models_dir)
            .unwrap_or_else(|e| fail(format!("engine init failed: {e}")));
        let models = engine
            .discover_models()
            .await
            .unwrap_or_else(|e| fail(format!("model discovery failed: {e}")));
        let model_info = models
            .iter()
            .find(|model| model.name == model_name)
            .unwrap_or_else(|| fail(format!("unknown model: {model_name}")));
        let needs_download = !matches!(model_info.status, ModelStatus::Available);
        let model_path = model_info.path.clone();
        if needs_download {
            let download_start = Instant::now();
            download_whisper_model(&engine, &model_name).await;
            model_download_seconds = download_start.elapsed().as_secs_f64();
        }
        if coreml_runtime_proof_required {
            require_coreml_encoder_bundle(&model_path).unwrap_or_else(|error| fail(error));
        }
        let memory_sampler = metrics_path.as_ref().map(|_| {
            PeakMemorySampler::start()
                .unwrap_or_else(|error| fail(format!("peak-memory sampler failed: {error}")))
        });
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
        let memory_observation = memory_sampler.map(|sampler| {
            sampler
                .finish()
                .unwrap_or_else(|error| fail(format!("peak-memory sampler failed: {error}")))
        });
        (result, model_load_seconds, memory_observation)
    };
    if let Some(backend) = whisper_runtime_proof_backend {
        verify_evaluator_whisper_runtime_attestation(backend).unwrap_or_else(|error| fail(error));
    }
    println!("{}", text.trim());

    if let Some(metrics_path) = metrics_path {
        let memory = memory_observation.expect("metrics run starts a memory sampler");
        let (hardware, benchmark_executable_sha256) =
            benchmark_provenance.expect("metrics run captures benchmark provenance");
        let metrics = EvalMetrics {
            schema_version: 6,
            provider: provider.clone(),
            model: model_name.clone(),
            backend: hardware.backend.as_str().to_string(),
            operating_system: std::env::consts::OS,
            architecture: std::env::consts::ARCH,
            hardware_profile: hardware.hardware_profile,
            accelerator: hardware.accelerator,
            benchmark_executable_sha256,
            audio_sha256: audio_sha256.expect("metrics run stages attested audio"),
            audio_duration_seconds: decoded.duration_seconds,
            decode_seconds,
            vad_seconds,
            model_download_seconds,
            model_load_seconds,
            inference_seconds,
            inference_rtf: inference_seconds / decoded.duration_seconds.max(f64::EPSILON),
            measured_total_seconds: measured_start
                .elapsed()
                .saturating_sub(audio_reattest_duration)
                .as_secs_f64(),
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

async fn prepare_model(provider: &str, model_name: &str, models_dir: Option<PathBuf>) {
    if provider == "parakeet" {
        let engine = ParakeetEngine::new_with_models_dir(models_dir)
            .unwrap_or_else(|error| fail(format!("engine init failed: {error}")));
        let models = engine
            .discover_models()
            .await
            .unwrap_or_else(|error| fail(format!("model discovery failed: {error}")));
        let status = models
            .iter()
            .find(|model| model.name == model_name)
            .map(|model| &model.status)
            .unwrap_or_else(|| fail(format!("unknown model: {model_name}")));
        if !matches!(status, ModelStatus::Available) {
            download_parakeet_model(&engine, model_name).await;
        }
        let available = engine
            .discover_models()
            .await
            .unwrap_or_else(|error| fail(format!("model verification failed: {error}")))
            .into_iter()
            .any(|model| {
                model.name == model_name && matches!(model.status, ModelStatus::Available)
            });
        if !available {
            fail(format!(
                "model preparation did not produce an available model: {model_name}"
            ));
        }
        return;
    }

    let engine = WhisperEngine::new_with_models_dir(models_dir)
        .unwrap_or_else(|error| fail(format!("engine init failed: {error}")));
    let models = engine
        .discover_models()
        .await
        .unwrap_or_else(|error| fail(format!("model discovery failed: {error}")));
    let status = models
        .iter()
        .find(|model| model.name == model_name)
        .map(|model| &model.status)
        .unwrap_or_else(|| fail(format!("unknown model: {model_name}")));
    if !matches!(status, ModelStatus::Available) {
        download_whisper_model(&engine, model_name).await;
    }
    let available_model = engine
        .discover_models()
        .await
        .unwrap_or_else(|error| fail(format!("model verification failed: {error}")))
        .into_iter()
        .find(|model| model.name == model_name && matches!(model.status, ModelStatus::Available));
    let Some(available_model) = available_model else {
        fail(format!(
            "model preparation did not produce an available model: {model_name}"
        ));
    };
    let backend = resolved_benchmark_backend("whisper").unwrap_or_else(|error| fail(error));
    if backend == BenchmarkBackend::CoreMlMetal {
        require_coreml_encoder_bundle(&available_model.path).unwrap_or_else(|error| fail(error));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cpu_and_platform_metal_without_ambiguous_precedence() {
        let features = WhisperBackendFeatures::default();
        assert_eq!(
            resolve_whisper_backend("linux", features, false, false).unwrap(),
            BenchmarkBackend::Cpu
        );
        assert_eq!(
            resolve_whisper_backend("macos", features, false, false).unwrap(),
            BenchmarkBackend::Metal
        );
        assert_eq!(
            resolve_whisper_backend("macos", features, true, false).unwrap(),
            BenchmarkBackend::Cpu
        );
    }

    #[test]
    fn resolves_explicit_benchmark_backends() {
        let cases = [
            (
                "macos",
                WhisperBackendFeatures {
                    coreml: true,
                    ..Default::default()
                },
                BenchmarkBackend::CoreMlMetal,
            ),
            (
                "macos",
                WhisperBackendFeatures {
                    metal: true,
                    ..Default::default()
                },
                BenchmarkBackend::Metal,
            ),
            (
                "linux",
                WhisperBackendFeatures {
                    cuda: true,
                    ..Default::default()
                },
                BenchmarkBackend::Cuda,
            ),
            (
                "linux",
                WhisperBackendFeatures {
                    vulkan: true,
                    ..Default::default()
                },
                BenchmarkBackend::Vulkan,
            ),
            (
                "linux",
                WhisperBackendFeatures {
                    hipblas: true,
                    ..Default::default()
                },
                BenchmarkBackend::HipBlas,
            ),
            (
                "linux",
                WhisperBackendFeatures {
                    openblas: true,
                    ..Default::default()
                },
                BenchmarkBackend::OpenBlasCpu,
            ),
        ];

        for (target_os, features, expected) in cases {
            assert_eq!(
                resolve_whisper_backend(target_os, features, false, expected.is_gpu()).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn preserves_openblas_identity_when_cpu_is_forced() {
        let features = WhisperBackendFeatures {
            openblas: true,
            ..Default::default()
        };
        assert_eq!(
            resolve_whisper_backend("macos", features, true, false).unwrap(),
            BenchmarkBackend::OpenBlasCpu
        );
    }

    #[test]
    fn rejects_ambiguous_or_unsupported_backend_builds() {
        let ambiguous = WhisperBackendFeatures {
            cuda: true,
            vulkan: true,
            ..Default::default()
        };
        assert!(
            resolve_whisper_backend("linux", ambiguous, false, true)
                .unwrap_err()
                .contains("multiple backend features")
        );

        let coreml = WhisperBackendFeatures {
            coreml: true,
            ..Default::default()
        };
        assert!(
            resolve_whisper_backend("linux", coreml, false, true)
                .unwrap_err()
                .contains("only on macOS")
        );

        let hipblas = WhisperBackendFeatures {
            hipblas: true,
            ..Default::default()
        };
        assert!(
            resolve_whisper_backend("windows", hipblas, false, true)
                .unwrap_err()
                .contains("only on Linux")
        );
    }

    #[test]
    fn rejects_conflicting_or_impossible_acceleration_requirements() {
        let features = WhisperBackendFeatures::default();
        assert!(
            resolve_whisper_backend("linux", features, true, true)
                .unwrap_err()
                .contains("conflicts")
        );
        assert!(
            resolve_whisper_backend("linux", features, false, true)
                .unwrap_err()
                .contains("cannot be satisfied")
        );
    }

    #[test]
    fn rejects_the_cpu_accelerator_sentinel_for_gpu_measurements() {
        assert!(
            validate_accelerator_label(BenchmarkBackend::Cuda, "none")
                .unwrap_err()
                .contains("real accelerator identity")
        );
        assert!(
            validate_accelerator_label(BenchmarkBackend::Metal, "NoNe")
                .unwrap_err()
                .contains("real accelerator identity")
        );
        assert!(validate_accelerator_label(BenchmarkBackend::Cpu, "none").is_ok());
        assert!(validate_accelerator_label(BenchmarkBackend::OpenBlasCpu, "none").is_ok());
    }

    #[test]
    fn validates_runtime_environment_provenance_digest() {
        assert_eq!(
            validate_runtime_env_sha256("a".repeat(64)).unwrap(),
            "a".repeat(64)
        );
        for invalid in [
            "a".repeat(63),
            "A".repeat(64),
            "g".repeat(64),
            format!("{} ", "a".repeat(64)),
        ] {
            assert!(
                validate_runtime_env_sha256(invalid)
                    .unwrap_err()
                    .contains("lowercase SHA-256")
            );
        }
    }

    #[test]
    fn validates_the_expected_audio_digest() {
        assert_eq!(
            validate_audio_sha256("a".repeat(64)).unwrap(),
            "a".repeat(64)
        );
        for invalid in [
            "a".repeat(63),
            "A".repeat(64),
            "g".repeat(64),
            format!("{} ", "a".repeat(64)),
        ] {
            assert!(
                validate_audio_sha256(invalid)
                    .unwrap_err()
                    .contains("lowercase SHA-256")
            );
        }
    }

    #[test]
    fn stages_hashes_and_decodes_the_exact_private_wav_handle() {
        let directory = tempfile::tempdir().unwrap();
        let audio_path = directory.path().join("fixture.wav");
        write_wav_16k_mono(&audio_path, &[0.0; 1600]).unwrap();
        let expected_sha256 = app_lib::model_integrity::sha256_file(&audio_path).unwrap();

        let (mut staged, actual_sha256) =
            stage_attested_wav(&audio_path, &expected_sha256).unwrap();
        assert_eq!(actual_sha256, expected_sha256);
        std::fs::write(&audio_path, b"replacement after staging").unwrap();

        let decoded = decode_audio_file_handle(staged.try_clone().unwrap(), "wav").unwrap();
        assert_eq!(decoded.sample_rate, 16_000);
        assert_eq!(decoded.channels, 1);
        assert_eq!(sha256_file_handle(&mut staged).unwrap(), expected_sha256);
    }

    #[test]
    fn rejects_mismatched_or_non_wav_attested_audio() {
        let directory = tempfile::tempdir().unwrap();
        let audio_path = directory.path().join("fixture.wav");
        write_wav_16k_mono(&audio_path, &[0.0; 16]).unwrap();
        assert!(
            stage_attested_wav(&audio_path, &"0".repeat(64))
                .unwrap_err()
                .contains("does not match")
        );

        std::fs::write(&audio_path, b"not a wav").unwrap();
        let digest = app_lib::model_integrity::sha256_file(&audio_path).unwrap();
        assert!(
            stage_attested_wav(&audio_path, &digest)
                .unwrap_err()
                .contains("RIFF/WAVE")
        );
    }

    #[test]
    fn control_modes_require_one_explicit_provider() {
        assert!(require_explicit_control_provider(true, "--hardware-json").is_ok());
        assert!(
            require_explicit_control_provider(false, "--hardware-json")
                .unwrap_err()
                .contains("exactly one explicit --provider")
        );
        assert!(
            require_explicit_control_provider(false, "--prepare-model-json")
                .unwrap_err()
                .contains("exactly one explicit --provider")
        );
    }

    #[test]
    fn derives_the_coreml_encoder_bundle_like_whisper_cpp() {
        assert_eq!(
            coreml_encoder_bundle_path(Path::new("/models/ggml-large-v3-turbo-q5_0.bin")),
            PathBuf::from("/models/ggml-large-v3-turbo-encoder.mlmodelc")
        );
        assert_eq!(
            coreml_encoder_bundle_path(Path::new("/models/ggml-large-v3-turbo.bin")),
            PathBuf::from("/models/ggml-large-v3-turbo-encoder.mlmodelc")
        );
        assert_eq!(
            coreml_encoder_bundle_path(Path::new("/models/ggml-test-q12_0.bin")),
            PathBuf::from("/models/ggml-test-q12_0-encoder.mlmodelc")
        );
    }

    #[test]
    fn coreml_bundle_requirement_fails_closed() {
        let directory = tempfile::tempdir().unwrap();
        let model_path = directory.path().join("ggml-test-q5_0.bin");
        std::fs::write(&model_path, b"model").unwrap();
        assert!(
            require_coreml_encoder_bundle(&model_path)
                .unwrap_err()
                .contains("missing")
        );

        let bundle_path = directory.path().join("ggml-test-encoder.mlmodelc");
        std::fs::create_dir(&bundle_path).unwrap();
        assert!(
            require_coreml_encoder_bundle(&model_path)
                .unwrap_err()
                .contains("empty")
        );
        std::fs::write(bundle_path.join("model.mil"), b"compiled model").unwrap();
        assert!(require_coreml_encoder_bundle(&model_path).is_ok());
    }

    #[test]
    fn gpu_runtime_proof_requires_every_state_to_select_the_expected_device() {
        let mut proof = EvaluatorWhisperRuntimeAttestation::new("CUDA0");
        proof.observe(b"whisper_backend_init_gpu: using CUDA0 backend\n");
        proof.observe(b"whisper_backend_init_gpu: using CUDA0 backend\n");
        assert!(proof.verify(BenchmarkBackend::Cuda).is_ok());

        proof.observe(b"whisper_backend_init_gpu: using CUDA1 backend\n");
        assert!(
            proof
                .verify(BenchmarkBackend::Cuda)
                .unwrap_err()
                .contains("unexpected GPU backend or device")
        );
    }

    #[test]
    fn gpu_runtime_proof_rejects_mixed_cpu_fallback_and_initialization_failure() {
        let mut missing = EvaluatorWhisperRuntimeAttestation::new("Vulkan0");
        missing.observe(b"whisper_backend_init_gpu: using Vulkan0 backend\n");
        missing.observe(b"whisper_backend_init_gpu: no GPU found\n");
        assert!(
            missing
                .verify(BenchmarkBackend::Vulkan)
                .unwrap_err()
                .contains("falling back")
        );

        let mut failed = EvaluatorWhisperRuntimeAttestation::new("ROCm0");
        failed.observe(b"whisper_backend_init_gpu: using ROCm0 backend\n");
        failed.observe(b"whisper_backend_init_gpu: failed to initialize ROCm0 backend\n");
        assert!(
            failed
                .verify(BenchmarkBackend::HipBlas)
                .unwrap_err()
                .contains("initialization failure")
        );
    }

    #[test]
    fn coreml_runtime_proof_rejects_success_marker_injected_through_the_model_path() {
        let mut proof = EvaluatorWhisperRuntimeAttestation::new("Metal");
        proof.observe(b"whisper_backend_init_gpu: using Metal backend\n");
        proof.observe(
            b"whisper_init_state: loading Core ML model from '/models/Core ML model loaded'\n",
        );

        assert_eq!(proof.coreml_attempts, 1);
        assert_eq!(proof.coreml_successes, 0);
        assert!(
            proof
                .verify(BenchmarkBackend::CoreMlMetal)
                .unwrap_err()
                .contains("0 successful encoder loads for 1 decoder states")
        );
    }

    #[test]
    fn coreml_runtime_proof_matches_the_pinned_no_state_context_call_graph() {
        let mut one_state = EvaluatorWhisperRuntimeAttestation::new("Metal");
        one_state.observe(b"whisper_backend_init_gpu: using Metal backend\n");
        one_state.observe(
            b"whisper_init_state: loading Core ML model from '/models/encoder.mlmodelc'\n",
        );
        one_state.observe(b"whisper_init_state: Core ML model loaded\n");
        assert!(one_state.verify(BenchmarkBackend::CoreMlMetal).is_ok());

        let mut phantom_context_backend = EvaluatorWhisperRuntimeAttestation::new("Metal");
        phantom_context_backend.observe(b"whisper_backend_init_gpu: using Metal backend\n");
        phantom_context_backend.observe(b"whisper_backend_init_gpu: using Metal backend\n");
        phantom_context_backend.observe(
            b"whisper_init_state: loading Core ML model from '/models/encoder.mlmodelc'\n",
        );
        phantom_context_backend.observe(b"whisper_init_state: Core ML model loaded\n");
        assert!(
            phantom_context_backend
                .verify(BenchmarkBackend::CoreMlMetal)
                .unwrap_err()
                .contains("2 GPU backend selections for 1 Core ML state initialization attempts")
        );
    }

    #[test]
    fn coreml_runtime_proof_is_per_attempt_and_failure_is_sticky() {
        let mut proof = EvaluatorWhisperRuntimeAttestation::new("Metal");
        for _ in 0..2 {
            proof.observe(b"whisper_backend_init_gpu: using Metal backend\n");
            proof.observe(
                b"whisper_init_state: loading Core ML model from '/models/encoder.mlmodelc'\n",
            );
        }
        proof.observe(b"whisper_init_state: Core ML model loaded\n");
        assert!(
            proof
                .verify(BenchmarkBackend::CoreMlMetal)
                .unwrap_err()
                .contains("1 successful encoder loads for 2 decoder states")
        );

        proof.observe(b"whisper_init_state: Core ML model loaded\n");
        assert!(proof.verify(BenchmarkBackend::CoreMlMetal).is_ok());

        proof.observe(
            b"whisper_init_state: failed to load Core ML model from '/models/encoder.mlmodelc'\n",
        );
        assert!(
            proof
                .verify(BenchmarkBackend::CoreMlMetal)
                .unwrap_err()
                .contains("encoder initialization failure")
        );
    }

    #[test]
    fn binds_configured_and_detected_gpu_identity() {
        assert_eq!(
            gpu_accelerator_identity(BenchmarkBackend::Cuda, "NVIDIA RTX 5090", "CUDA0").unwrap(),
            "NVIDIA RTX 5090 [ggml=CUDA0]"
        );
        assert!(gpu_accelerator_identity(BenchmarkBackend::Cuda, "none", "CUDA0").is_err());
        assert!(
            gpu_accelerator_identity(BenchmarkBackend::Cuda, "NVIDIA RTX 5090", "bad;device")
                .is_err()
        );
    }

    #[test]
    fn peak_memory_sampler_records_positive_current_process_rss() {
        let sampler = PeakMemorySampler::start().unwrap();
        let observation = sampler.finish().unwrap();
        assert!(observation.baseline_bytes > 0);
        assert!(observation.peak_bytes >= observation.baseline_bytes);
    }

    #[test]
    fn hardware_probe_serializes_only_the_strict_public_fields() {
        let probe = HardwareProbe {
            schema_version: 1,
            backend: "cpu".to_string(),
            operating_system: "linux",
            architecture: "x86_64",
            hardware_profile: format!(
                "cpu=Test CPU;logical_cpus=8;memory_bytes=1024;runtime_env_sha256={}",
                "a".repeat(64)
            ),
            accelerator: "none".to_string(),
            benchmark_executable_sha256: "a".repeat(64),
        };
        let value = serde_json::to_value(probe).unwrap();
        let object = value.as_object().unwrap();
        let mut fields = object.keys().map(String::as_str).collect::<Vec<_>>();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "accelerator",
                "architecture",
                "backend",
                "benchmark_executable_sha256",
                "hardware_profile",
                "operating_system",
                "schema_version",
            ]
        );
    }

    #[test]
    fn prepared_model_serializes_only_the_strict_public_fields() {
        let prepared = PreparedModel {
            schema_version: 1,
            provider: "whisper".to_string(),
            model: "tiny".to_string(),
        };
        let value = serde_json::to_value(prepared).unwrap();
        let object = value.as_object().unwrap();
        let mut fields = object.keys().map(String::as_str).collect::<Vec<_>>();
        fields.sort_unstable();
        assert_eq!(fields, ["model", "provider", "schema_version"]);
    }

    #[test]
    fn hashes_the_exact_running_test_executable() {
        let digest = benchmark_executable_sha256().unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(digest, digest.to_ascii_lowercase());
    }
}
