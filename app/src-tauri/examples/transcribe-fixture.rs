//! Headless transcription of an audio file with a real local ASR engine.
//!
//! Dev-only entry point for the eval harness (`pnpm eval:real`): no Tauri
//! runtime, no app state. Downloads the model on first use, then decodes the
//! given audio file and prints the transcript — transcript text is the ONLY
//! stdout output (logs go to stderr) so a caller can capture it directly.
//!
//! Usage: cargo run -p muesly --example transcribe-fixture --
//!        [--provider whisper|parakeet] <audio> [model] [models_dir]

use std::io::Write as _;
use std::path::PathBuf;

use app_lib::audio::decoder::decode_audio_file;
use app_lib::parakeet_engine::engine::ParakeetEngine;
use app_lib::transcription_models::ModelStatus;
use app_lib::whisper_engine::engine::WhisperEngine;

fn fail(msg: String) -> ! {
    eprintln!("transcribe-fixture: {msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next();
    let (provider, audio_arg) = if first.as_deref() == Some("--provider") {
        let provider = args
            .next()
            .unwrap_or_else(|| fail("--provider requires whisper or parakeet".to_string()));
        (provider, args.next())
    } else {
        ("whisper".to_string(), first)
    };
    if provider != "whisper" && provider != "parakeet" {
        fail(format!(
            "unknown provider '{provider}'; expected whisper or parakeet"
        ));
    }
    let Some(audio_path) = audio_arg.map(PathBuf::from) else {
        fail(
            "usage: transcribe-fixture [--provider whisper|parakeet] <audio> [model] [models_dir]"
                .to_string(),
        );
    };
    let model_name = args.next().unwrap_or_else(|| {
        if provider == "parakeet" {
            "parakeet-tdt-0.6b-v3-int8".to_string()
        } else {
            "tiny".to_string()
        }
    });
    let models_dir = args.next().map(PathBuf::from);

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
        engine
            .transcribe_audio(samples)
            .await
            .unwrap_or_else(|e| fail(format!("transcription failed: {e}")))
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
        engine
            .transcribe_audio(samples, None)
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
