//! Headless transcription of an audio file with the real Whisper engine.
//!
//! Dev-only entry point for the eval harness (`pnpm eval:real`): no Tauri
//! runtime, no app state. Downloads the model on first use, then decodes the
//! given audio file and prints the transcript — transcript text is the ONLY
//! stdout output (logs go to stderr) so a caller can capture it directly.
//!
//! Usage: cargo run -p muesly --example transcribe-fixture -- <audio> [model] [models_dir]

use std::io::Write as _;
use std::path::PathBuf;

use app_lib::audio::decoder::decode_audio_file;
use app_lib::whisper_engine::engine::WhisperEngine;

fn fail(msg: String) -> ! {
    eprintln!("transcribe-fixture: {msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let Some(audio_path) = args.next().map(PathBuf::from) else {
        fail("usage: transcribe-fixture <audio> [model] [models_dir]".to_string());
    };
    let model_name = args.next().unwrap_or_else(|| "tiny".to_string());
    let models_dir = args.next().map(PathBuf::from);

    if !audio_path.exists() {
        fail(format!("audio file not found: {}", audio_path.display()));
    }

    let engine = match WhisperEngine::new_with_models_dir(models_dir) {
        Ok(e) => e,
        Err(e) => fail(format!("engine init failed: {e}")),
    };
    let models = match engine.discover_models().await {
        Ok(m) => m,
        Err(e) => fail(format!("model discovery failed: {e}")),
    };

    // Fetch the model on first run (atomic .part rename; reused afterwards).
    let needs_download = match models.iter().find(|m| m.name == model_name) {
        Some(info) => !matches!(
            info.status,
            app_lib::whisper_engine::engine::ModelStatus::Available
        ),
        None => fail(format!("unknown model: {model_name}")),
    };
    if needs_download {
        eprintln!("downloading model '{model_name}' (first run)...");
        let progress: Box<dyn Fn(u8) + Send> = Box::new(|pct| {
            eprint!("\rdownload: {pct}%");
            let _ = std::io::stderr().flush();
        });
        if let Err(e) = engine.download_model(&model_name, Some(progress)).await {
            fail(format!("model download failed: {e}"));
        }
        eprintln!();
        if let Err(e) = engine.discover_models().await {
            fail(format!("model rediscovery failed: {e}"));
        }
    }

    if let Err(e) = engine.load_model(&model_name).await {
        fail(format!("model load failed: {e}"));
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
    match engine.transcribe_audio(samples, None).await {
        Ok(text) => println!("{}", text.trim()),
        Err(e) => fail(format!("transcription failed: {e}")),
    }
}
