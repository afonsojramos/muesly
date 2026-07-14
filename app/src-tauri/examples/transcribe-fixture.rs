//! Headless transcription of an audio file with a real local ASR engine.
//!
//! Dev-only entry point for the eval harness (`nub run eval:real`): no Tauri
//! runtime, no app state. Downloads the model on first use, then decodes the
//! given audio file and prints the transcript — transcript text is the ONLY
//! stdout output (logs go to stderr) so a caller can capture it directly.
//!
//! Usage: cargo run -p muesly --example transcribe-fixture --
//!        [--language en] [--vad] [--segments]
//!        [--prompt "term one, term two"] <audio> [model] [models_dir]
//!
//! `--segments` (implies `--vad`) prints one line per VAD segment instead of a
//! single joined transcript:
//! `<index>\t<start-seconds>\t<confidence>\t<kept|DROPPED(reason)>\t<text>`.

use std::io::Write as _;
use std::path::PathBuf;

use app_lib::audio::decoder::decode_audio_file;
use app_lib::audio::vad::get_speech_chunks;
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
    let mut language = None;
    let mut use_vad = false;
    let mut per_segment = false;
    let mut prompt = None;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < raw_args.len() {
        match raw_args[index].as_str() {
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
    let Some(audio_path) = positional.first().map(PathBuf::from) else {
        fail(
            "usage: transcribe-fixture [--language en] [--vad] [--prompt terms] <audio> [model] [models_dir]"
                .to_string(),
        );
    };
    let model_name = positional
        .get(1)
        .cloned()
        .unwrap_or_else(|| "tiny".to_string());
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
    // A stale lock from a previous run can never exist in a fresh process, but
    // mirror the app's session boundaries anyway (recording start does this).
    app_lib::whisper_engine::reset_session_detected_language();
    let text = if use_vad {
        let segments =
            get_speech_chunks(&samples, 2000).unwrap_or_else(|e| fail(format!("VAD failed: {e}")));
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
            let drop_reason = app_lib::audio::transcription::segment_filter::should_drop_segment(
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
    };
    println!("{}", text.trim());
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
