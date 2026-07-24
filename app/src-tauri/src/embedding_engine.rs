//! On-device text embeddings for semantic meeting search.
//!
//! Runs `multilingual-e5-small` (int8 ONNX, 384 dims) through the same
//! in-process ONNX Runtime that Parakeet uses. Texts are tokenized with the
//! model's own `tokenizer.json`, mean-pooled over the attention mask, and
//! L2-normalized, so cosine similarity reduces to a dot product downstream.
//!
//! Every public entry point degrades to `None` when the model artifacts are
//! not on disk (not yet downloaded, download failed, dims mismatch): semantic
//! search is an enhancement, and its absence must reproduce keyword-only
//! behavior exactly, never an error. Artifacts download once from a pinned
//! Hugging Face revision and are SHA-256-verified against
//! `model_integrity::embedding_file_sha256` before use — the Parakeet pattern.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use ndarray::Array2;
use ort::execution_providers::CPUExecutionProvider;
use ort::inputs;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;
use tauri::{AppHandle, Manager, Runtime};
use tokenizers::Tokenizer;

/// Stored with every vector; a model change invalidates old rows by mismatch.
pub const EMBEDDING_MODEL_ID: &str = "multilingual-e5-small-int8";
pub const EMBEDDING_DIMS: usize = 384;
/// e5 was trained with these prefixes; they measurably matter.
const QUERY_PREFIX: &str = "query: ";
const PASSAGE_PREFIX: &str = "passage: ";
const MAX_TOKENS: usize = 512;

/// Pinned revision of the community ONNX export. The revision hash and the
/// per-file pins in `model_integrity` were captured together.
const REPO_URL: &str = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78";
/// (remote path under the pinned revision, local filename)
const ARTIFACTS: &[(&str, &str)] = &[
    ("onnx/model_quantized.onnx", "model_quantized.onnx"),
    ("tokenizer.json", "tokenizer.json"),
];

/// Models root (`<app_data>/models`), set once at startup like the other
/// engines. Embedding artifacts live under `<root>/embeddings/`.
static MODELS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static EMBEDDER: Mutex<Option<Embedder>> = Mutex::new(None);
static LAST_USED: Mutex<Option<Instant>> = Mutex::new(None);
static DOWNLOAD_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct Embedder {
    tokenizer: Tokenizer,
    session: Session,
    /// Whether the exported graph asks for `token_type_ids` (XLM-R exports
    /// usually don't, but probing beats assuming).
    wants_token_type_ids: bool,
}

/// Record the models root during app setup (same timing as Whisper/Parakeet).
pub fn set_models_directory<R: Runtime>(app: &AppHandle<R>) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        log::error!("embedding engine: app data dir unavailable");
        return;
    };
    set_models_root(app_data_dir.join("models"));
}

/// Direct models-root override (tests and headless tooling).
pub fn set_models_root(root: PathBuf) {
    *MODELS_DIR.lock().unwrap() = Some(root);
}

fn embeddings_dir() -> Option<PathBuf> {
    MODELS_DIR
        .lock()
        .unwrap()
        .as_ref()
        .map(|root| root.join("embeddings"))
}

/// Whether all pinned artifacts exist locally (cheap stat; content was
/// verified at download time and re-verified at load).
pub fn is_model_available() -> bool {
    let Some(dir) = embeddings_dir() else {
        return false;
    };
    ARTIFACTS
        .iter()
        .all(|(_, local)| dir.join(local).is_file())
}

/// Download any missing artifacts (idempotent; one download at a time).
/// Verification failures delete the file so a later attempt can retry.
pub async fn ensure_model_available() -> Result<()> {
    let dir = embeddings_dir().ok_or_else(|| anyhow!("models directory not initialized"))?;
    if is_model_available() {
        return Ok(());
    }
    if DOWNLOAD_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Err(anyhow!("embedding model download already in progress"));
    }
    let result = download_missing(&dir).await;
    DOWNLOAD_IN_FLIGHT.store(false, Ordering::SeqCst);
    result
}

async fn download_missing(dir: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dir).context("create embeddings model directory")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1800))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .context("build embedding download client")?;
    for (remote, local) in ARTIFACTS {
        let target = dir.join(local);
        if target.is_file() {
            continue;
        }
        let pin = crate::model_integrity::embedding_file_sha256(local)
            .ok_or_else(|| anyhow!("no integrity pin for embedding file '{local}'"))?;
        let url = format!("{REPO_URL}/{remote}");
        log::info!("Downloading embedding model file '{local}'…");
        let response = client
            .get(&url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .with_context(|| format!("download embedding file '{local}'"))?;

        // Stream to a partial file, hashing as we go; publish only on match.
        let partial = dir.join(format!("{local}.partial"));
        let mut file = std::fs::File::create(&partial)
            .with_context(|| format!("create partial file for '{local}'"))?;
        let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
        let mut stream = response;
        while let Some(chunk) = stream
            .chunk()
            .await
            .with_context(|| format!("stream embedding file '{local}'"))?
        {
            sha2::Digest::update(&mut hasher, &chunk);
            file.write_all(&chunk)
                .with_context(|| format!("write embedding file '{local}'"))?;
        }
        file.flush().ok();
        drop(file);
        let digest = hex::encode(sha2::Digest::finalize(hasher));
        if digest != pin {
            let _ = std::fs::remove_file(&partial);
            return Err(anyhow!(
                "embedding file '{local}' failed integrity verification (got {digest})"
            ));
        }
        std::fs::rename(&partial, &target)
            .with_context(|| format!("publish embedding file '{local}'"))?;
        log::info!("Embedding model file '{local}' downloaded and verified");
    }
    Ok(())
}

/// Embed passages for indexing. `None` = model unavailable (caller skips
/// indexing; nothing is wrong).
pub async fn embed_passages(texts: Vec<String>) -> Option<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Some(Vec::new());
    }
    embed(texts, PASSAGE_PREFIX).await
}

/// Embed one search query. `None` = model unavailable (caller degrades to
/// keyword-only search).
pub async fn embed_query(text: &str) -> Option<Vec<f32>> {
    let mut vectors = embed(vec![text.to_string()], QUERY_PREFIX).await?;
    vectors.pop()
}

async fn embed(texts: Vec<String>, prefix: &'static str) -> Option<Vec<Vec<f32>>> {
    if !is_model_available() {
        return None;
    }
    let result = tokio::task::spawn_blocking(move || embed_blocking(&texts, prefix))
        .await
        .ok()?;
    match result {
        Ok(vectors) => {
            *LAST_USED.lock().unwrap() = Some(Instant::now());
            Some(vectors)
        }
        Err(e) => {
            log::warn!("embedding inference failed (degrading to keyword search): {e}");
            None
        }
    }
}

fn embed_blocking(texts: &[String], prefix: &str) -> Result<Vec<Vec<f32>>> {
    let mut guard = EMBEDDER.lock().unwrap();
    if guard.is_none() {
        *guard = Some(load_embedder()?);
    }
    let embedder = guard.as_mut().expect("embedder loaded above");

    let prefixed: Vec<String> = texts.iter().map(|t| format!("{prefix}{t}")).collect();
    let encodings = embedder
        .tokenizer
        .encode_batch(prefixed, true)
        .map_err(|e| anyhow!("tokenization failed: {e}"))?;

    let batch = encodings.len();
    let seq = encodings
        .iter()
        .map(|e| e.get_ids().len().min(MAX_TOKENS))
        .max()
        .unwrap_or(0)
        .max(1);

    let mut input_ids = Array2::<i64>::zeros((batch, seq));
    let mut attention_mask = Array2::<i64>::zeros((batch, seq));
    for (row, encoding) in encodings.iter().enumerate() {
        for (col, &id) in encoding.get_ids().iter().take(seq).enumerate() {
            input_ids[[row, col]] = id as i64;
            attention_mask[[row, col]] = 1;
        }
    }

    let outputs = if embedder.wants_token_type_ids {
        let token_type_ids = Array2::<i64>::zeros((batch, seq));
        embedder.session.run(inputs![
            "input_ids" => TensorRef::from_array_view(input_ids.view())?,
            "attention_mask" => TensorRef::from_array_view(attention_mask.view())?,
            "token_type_ids" => TensorRef::from_array_view(token_type_ids.view())?,
        ])?
    } else {
        embedder.session.run(inputs![
            "input_ids" => TensorRef::from_array_view(input_ids.view())?,
            "attention_mask" => TensorRef::from_array_view(attention_mask.view())?,
        ])?
    };

    let hidden = outputs
        .get("last_hidden_state")
        .ok_or_else(|| anyhow!("embedding model output 'last_hidden_state' missing"))?
        .try_extract_array::<f32>()?;
    let hidden = hidden
        .to_owned()
        .into_dimensionality::<ndarray::Ix3>()
        .context("unexpected embedding output shape")?;

    let masks: Vec<Vec<i64>> = (0..batch)
        .map(|row| (0..seq).map(|col| attention_mask[[row, col]]).collect())
        .collect();
    let vectors = mean_pool_normalize(&hidden, &masks)?;
    if vectors.iter().any(|v| v.len() != EMBEDDING_DIMS) {
        return Err(anyhow!(
            "embedding model produced unexpected dimensionality (expected {EMBEDDING_DIMS})"
        ));
    }
    Ok(vectors)
}

fn load_embedder() -> Result<Embedder> {
    let dir = embeddings_dir().ok_or_else(|| anyhow!("models directory not initialized"))?;
    for (_, local) in ARTIFACTS {
        let pin = crate::model_integrity::embedding_file_sha256(local)
            .ok_or_else(|| anyhow!("no integrity pin for embedding file '{local}'"))?;
        crate::model_integrity::verify_file_sha256(&dir.join(local), pin)
            .with_context(|| format!("embedding file '{local}' failed verification at load"))?;
    }

    let mut tokenizer = Tokenizer::from_file(dir.join("tokenizer.json"))
        .map_err(|e| anyhow!("load embedding tokenizer: {e}"))?;
    let _ = tokenizer.with_truncation(Some(tokenizers::TruncationParams {
        max_length: MAX_TOKENS,
        ..Default::default()
    }));

    let session = Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_execution_providers(vec![CPUExecutionProvider::default().build()])?
        .commit_from_file(dir.join("model_quantized.onnx"))?;
    let wants_token_type_ids = session
        .inputs
        .iter()
        .any(|input| input.name == "token_type_ids");

    log::info!("Embedding model loaded ({EMBEDDING_MODEL_ID})");
    Ok(Embedder {
        tokenizer,
        session,
        wants_token_type_ids,
    })
}

/// Mean-pool token vectors over the attention mask, then L2-normalize.
/// Pure so the math is unit-testable without a model.
fn mean_pool_normalize(
    hidden: &ndarray::Array3<f32>,
    masks: &[Vec<i64>],
) -> Result<Vec<Vec<f32>>> {
    let (batch, seq, dims) = hidden.dim();
    if masks.len() != batch {
        return Err(anyhow!("attention mask batch mismatch"));
    }
    let mut vectors = Vec::with_capacity(batch);
    for (row, mask) in masks.iter().enumerate() {
        let mut pooled = vec![0f32; dims];
        let mut count = 0f32;
        for (col, &m) in mask.iter().take(seq).enumerate() {
            if m == 0 {
                continue;
            }
            count += 1.0;
            for (d, value) in pooled.iter_mut().enumerate() {
                *value += hidden[[row, col, d]];
            }
        }
        if count > 0.0 {
            for value in pooled.iter_mut() {
                *value /= count;
            }
        }
        let norm = pooled.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in pooled.iter_mut() {
                *value /= norm;
            }
        }
        vectors.push(pooled);
    }
    Ok(vectors)
}

/// How long since the embedder was last used (None = never / not loaded).
pub fn idle_for() -> Option<Duration> {
    LAST_USED.lock().unwrap().map(|at| at.elapsed())
}

pub fn is_loaded() -> bool {
    EMBEDDER.lock().unwrap().is_some()
}

/// Drop the session + tokenizer to free RAM. The next embed reloads lazily.
pub fn unload() {
    let dropped = EMBEDDER.lock().unwrap().take().is_some();
    if dropped {
        log::info!("Embedding model unloaded (idle)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pooling_averages_only_masked_positions_and_normalizes() {
        // batch=1, seq=3, dims=2; third position is padding and must not count.
        let hidden =
            ndarray::Array3::from_shape_vec((1, 3, 2), vec![1.0, 0.0, 3.0, 0.0, 100.0, 100.0])
                .unwrap();
        let masks = vec![vec![1, 1, 0]];
        let vectors = mean_pool_normalize(&hidden, &masks).unwrap();
        // Mean of (1,0) and (3,0) = (2,0) → normalized (1,0).
        assert!((vectors[0][0] - 1.0).abs() < 1e-6);
        assert!(vectors[0][1].abs() < 1e-6);
        let norm: f32 = vectors[0].iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn pooling_survives_fully_masked_rows() {
        let hidden = ndarray::Array3::from_shape_vec((1, 2, 2), vec![1.0, 2.0, 3.0, 4.0]).unwrap();
        let masks = vec![vec![0, 0]];
        let vectors = mean_pool_normalize(&hidden, &masks).unwrap();
        assert_eq!(vectors[0], vec![0.0, 0.0]);
    }

    #[test]
    fn pooling_rejects_batch_mismatch() {
        let hidden = ndarray::Array3::zeros((2, 1, 2));
        assert!(mean_pool_normalize(&hidden, &[vec![1]]).is_err());
    }

    #[test]
    fn model_absent_paths_are_none_without_touching_ort() {
        // MODELS_DIR is unset in unit tests → available=false, embed=None.
        assert!(!is_model_available());
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(embed_query("hello"));
        assert!(result.is_none());
    }

    #[test]
    fn artifact_pins_exist_for_every_file() {
        for (_, local) in ARTIFACTS {
            assert!(
                crate::model_integrity::embedding_file_sha256(local).is_some(),
                "missing integrity pin for {local}"
            );
        }
    }

    /// Real-model integration smoke: verifies tokenizer load, ONNX input/
    /// output names, pooling, and that semantically related sentences rank
    /// closer than unrelated ones — across languages. Needs the pinned
    /// artifacts on disk (no CI models): point MUESLY_EMBEDDING_MODELS_ROOT at
    /// a models root whose `embeddings/` holds them, then run with --ignored.
    #[test]
    #[ignore]
    fn real_model_smoke_embeds_and_ranks() {
        let root = std::env::var("MUESLY_EMBEDDING_MODELS_ROOT")
            .expect("set MUESLY_EMBEDDING_MODELS_ROOT to run the real-model smoke");
        set_models_root(PathBuf::from(root));
        assert!(is_model_available(), "embedding artifacts missing");

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let query = runtime
            .block_on(embed_query("What did we decide about pricing?"))
            .expect("query embedding");
        assert_eq!(query.len(), EMBEDDING_DIMS);

        let passages = runtime
            .block_on(embed_passages(vec![
                "We discussed the subscription tiers and settled on monthly billing.".to_string(),
                "Hablamos de los niveles de suscripción y los precios.".to_string(),
                "The office plants need watering twice a week.".to_string(),
            ]))
            .expect("passage embeddings");
        let dot = |a: &[f32], b: &[f32]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
        let english_pricing = dot(&query, &passages[0]);
        let spanish_pricing = dot(&query, &passages[1]);
        let plants = dot(&query, &passages[2]);
        assert!(
            english_pricing > plants && spanish_pricing > plants,
            "pricing passages must outrank the unrelated one \
             (en={english_pricing:.3} es={spanish_pricing:.3} plants={plants:.3})"
        );
    }
}
