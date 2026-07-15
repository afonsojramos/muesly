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

use app_lib::audio::decoder::decode_audio_file;
use app_lib::audio::vad::get_speech_chunks;
use app_lib::parakeet_engine::engine::ParakeetEngine;
use app_lib::transcription_models::ModelStatus;
use app_lib::vocabulary::set_meeting_prompt_terms;
use app_lib::whisper_engine::engine::WhisperEngine;

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

    let decoded = match decode_audio_file(&audio_path) {
        Ok(d) => d,
        Err(e) => fail(format!("audio decode failed: {e}")),
    };
    eprintln!(
        "decoded {:.1}s of audio ({} Hz, {} ch)",
        decoded.duration_seconds, decoded.sample_rate, decoded.channels
    );

    let samples = decoded.to_whisper_format();
    // Dump-only mode: write the VAD segmentation and exit without touching any
    // ASR engine, so external engines can be evaluated on identical segments.
    if let Some(dir) = dump_dir {
        let segments =
            get_speech_chunks(&samples, 2000).unwrap_or_else(|e| fail(format!("VAD failed: {e}")));
        eprintln!("VAD detected {} speech segments", segments.len());
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

    let text = if provider == "parakeet" {
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
            download_parakeet_model(&engine, &model_name).await;
        }
        engine
            .load_model(&model_name)
            .await
            .unwrap_or_else(|e| fail(format!("model load failed: {e}")));
        if use_vad {
            let segments = get_speech_chunks(&samples, 2000)
                .unwrap_or_else(|e| fail(format!("VAD failed: {e}")));
            eprintln!("VAD detected {} speech segments", segments.len());
            let mut transcripts = Vec::with_capacity(segments.len());
            for (index, segment) in segments.into_iter().enumerate() {
                if segment.samples.len() < 1600 {
                    continue;
                }
                eprintln!("transcribing VAD segment {}", index + 1);
                let start = segment.start_timestamp_ms / 1000.0;
                let text = engine
                    .transcribe_audio(segment.samples)
                    .await
                    .unwrap_or_else(|e| {
                        fail(format!(
                            "transcription failed on segment {}: {e}",
                            index + 1
                        ))
                    });
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
            engine
                .transcribe_audio(samples)
                .await
                .unwrap_or_else(|e| fail(format!("transcription failed: {e}")))
        }
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
            download_whisper_model(&engine, &model_name).await;
        }
        engine
            .load_model(&model_name)
            .await
            .unwrap_or_else(|e| fail(format!("model load failed: {e}")));
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
        if use_vad {
            let segments = get_speech_chunks(&samples, 2000)
                .unwrap_or_else(|e| fail(format!("VAD failed: {e}")));
            eprintln!("VAD detected {} speech segments", segments.len());
            let mut transcripts = Vec::with_capacity(segments.len());
            for (index, segment) in segments.into_iter().enumerate() {
                if segment.samples.len() < 1600 {
                    continue;
                }
                eprintln!("transcribing VAD segment {}", index + 1);
                let start = segment.start_timestamp_ms / 1000.0;
                let (text, confidence, _) = engine
                    .transcribe_audio_with_confidence(segment.samples, language.clone())
                    .await
                    .unwrap_or_else(|e| {
                        fail(format!(
                            "transcription failed on segment {}: {e}",
                            index + 1
                        ))
                    });
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
            engine
                .transcribe_audio(samples, language)
                .await
                .unwrap_or_else(|e| fail(format!("transcription failed: {e}")))
        }
    };
    println!("{}", text.trim());
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
