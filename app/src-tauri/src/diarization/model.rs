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

/// Pyannote segmentation model file name on disk.
pub const SEGMENTATION_MODEL_FILE: &str = "sherpa-onnx-pyannote-segmentation-3.onnx";
/// WeSpeaker CAM++ (English/VoxCeleb) speaker-embedding model file name on disk.
pub const EMBEDDING_MODEL_FILE: &str = "wespeaker_en_voxceleb_CAM++.onnx";

/// Pinned SHA-256 of the segmentation model. Empty until verified against the
/// real release artifact (see module docs).
pub const SEGMENTATION_MODEL_SHA256: &str = "";
/// Pinned SHA-256 of the embedding model. Empty until verified.
pub const EMBEDDING_MODEL_SHA256: &str = "";

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
