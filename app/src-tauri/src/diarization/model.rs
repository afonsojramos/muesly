//! Diarization model files and integrity checks.
//!
//! Diarization needs two ONNX models, downloaded on demand into the app data
//! dir (under `models/diarization/`):
//!   - a pyannote segmentation model (`sherpa-onnx-pyannote-segmentation-3`, ~7MB)
//!   - a speaker-embedding model (`wespeaker_en_voxceleb_CAM++`, ~28MB)
//!
//! Both are published by the sherpa-onnx project. Their pinned SHA-256 hashes
//! must be filled from the actual release artifacts before shipping the
//! downloader (see [`verify_sha256`]); until a hash is pinned, verification of
//! that file is skipped.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

/// Pyannote segmentation model file name on disk.
pub const SEGMENTATION_MODEL_FILE: &str = "sherpa-onnx-pyannote-segmentation-3.onnx";
/// WeSpeaker CAM++ (English/VoxCeleb) speaker-embedding model file name on disk.
pub const EMBEDDING_MODEL_FILE: &str = "wespeaker_en_voxceleb_CAM++.onnx";

// TODO: pin SHA-256 from the release artifacts. The download verifies each file
// against these; an empty hash skips verification (see `verify_sha256`). Do not
// invent values — compute them from the real downloaded artifacts.
/// Pinned SHA-256 of the segmentation model. Empty until verified against the
/// real release artifact (see module docs).
pub const SEGMENTATION_MODEL_SHA256: &str = "";
/// Pinned SHA-256 of the embedding model. Empty until verified.
pub const EMBEDDING_MODEL_SHA256: &str = "";

/// Direct download URL for the embedding model (`.onnx`).
const EMBEDDING_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_CAM++.onnx";
/// Download URL for the segmentation model archive (`tar.bz2` containing
/// `sherpa-onnx-pyannote-segmentation-3-0/model.onnx`).
const SEGMENTATION_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";

/// Directory holding the diarization models, under the app data dir.
pub fn models_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models").join("diarization")
}

/// Path to the segmentation model on disk.
pub fn segmentation_model_path(app_data_dir: &Path) -> PathBuf {
    models_dir(app_data_dir).join(SEGMENTATION_MODEL_FILE)
}

/// Path to the embedding model on disk.
pub fn embedding_model_path(app_data_dir: &Path) -> PathBuf {
    models_dir(app_data_dir).join(EMBEDDING_MODEL_FILE)
}

/// Whether both diarization models are present on disk.
pub fn models_ready(app_data_dir: &Path) -> bool {
    segmentation_model_path(app_data_dir).exists() && embedding_model_path(app_data_dir).exists()
}

/// Lowercase-hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Verify `bytes` match `expected_hex` (case-insensitive lowercase-hex SHA-256).
/// An empty `expected_hex` means the hash is not yet pinned, so verification is
/// skipped (returns `true`); a non-empty hash is strictly checked.
pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> bool {
    if expected_hex.is_empty() {
        return true;
    }
    sha256_hex(bytes).eq_ignore_ascii_case(expected_hex)
}

/// Stream-download `url` to `dest`, invoking `on_progress(downloaded, total)` as
/// bytes arrive (`total` is 0 when the server omits Content-Length).
async fn download_file(
    url: &str,
    dest: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<()> {
    use futures_util::StreamExt;
    use std::io::Write;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .context("build http client")?;
    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("request {url}"))?;
    if !response.status().is_success() {
        return Err(anyhow!("download {url} failed: HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut file =
        std::fs::File::create(dest).with_context(|| format!("create {}", dest.display()))?;
    let mut downloaded = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("download stream error")?;
        file.write_all(&chunk).context("write downloaded chunk")?;
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total);
    }
    file.flush().context("flush download")?;
    Ok(())
}

/// Extract the inner `model.onnx` from the pyannote `tar.bz2` archive to `dest`.
fn extract_segmentation_model(archive: &Path, dest: &Path) -> Result<()> {
    let file =
        std::fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let decoder = bzip2_rs::DecoderReader::new(std::io::BufReader::new(file));
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().context("read tar archive")? {
        let mut entry = entry.context("read tar entry")?;
        let path = entry.path().context("tar entry path")?.into_owned();
        if path.file_name().and_then(|n| n.to_str()) == Some("model.onnx") {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut out = std::fs::File::create(dest)
                .with_context(|| format!("create {}", dest.display()))?;
            std::io::copy(&mut entry, &mut out).context("extract model.onnx")?;
            return Ok(());
        }
    }
    Err(anyhow!("model.onnx not found in segmentation archive"))
}

/// Download both diarization models into the app data dir, verifying each
/// against its pinned SHA-256 (skipped while a hash is unpinned). `on_progress`
/// receives `(phase, downloaded_bytes, total_bytes)`, where `phase` is
/// `"embedding"` or `"segmentation"`.
pub async fn download_models(
    app_data_dir: &Path,
    mut on_progress: impl FnMut(&str, u64, u64),
) -> Result<()> {
    std::fs::create_dir_all(models_dir(app_data_dir)).context("create diarization models dir")?;

    // Embedding model: a direct .onnx download.
    let embedding = embedding_model_path(app_data_dir);
    download_file(EMBEDDING_MODEL_URL, &embedding, |d, t| {
        on_progress("embedding", d, t)
    })
    .await?;
    let embedding_bytes = std::fs::read(&embedding).context("read embedding model")?;
    if !verify_sha256(&embedding_bytes, EMBEDDING_MODEL_SHA256) {
        std::fs::remove_file(&embedding).ok();
        return Err(anyhow!("embedding model failed SHA-256 verification"));
    }

    // Segmentation model: download the tar.bz2 and extract its inner model.onnx.
    let archive = tempfile::NamedTempFile::new().context("create archive temp file")?;
    download_file(SEGMENTATION_ARCHIVE_URL, archive.path(), |d, t| {
        on_progress("segmentation", d, t)
    })
    .await?;
    let segmentation = segmentation_model_path(app_data_dir);
    extract_segmentation_model(archive.path(), &segmentation)?;
    let segmentation_bytes = std::fs::read(&segmentation).context("read segmentation model")?;
    if !verify_sha256(&segmentation_bytes, SEGMENTATION_MODEL_SHA256) {
        std::fs::remove_file(&segmentation).ok();
        return Err(anyhow!("segmentation model failed SHA-256 verification"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vector() {
        // SHA-256("abc") is a standard test vector.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_accepts_matching_hash_any_case() {
        let hash = sha256_hex(b"hello");
        assert!(verify_sha256(b"hello", &hash));
        assert!(verify_sha256(b"hello", &hash.to_uppercase()));
    }

    #[test]
    fn verify_rejects_wrong_hash() {
        let hash = sha256_hex(b"hello");
        assert!(!verify_sha256(b"world", &hash));
    }

    #[test]
    fn verify_skips_when_hash_unpinned() {
        // Empty expected hash means "not yet pinned" -> skip (true).
        assert!(verify_sha256(b"anything", ""));
    }
}
