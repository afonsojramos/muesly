//! Shared SHA-256 integrity checks for downloaded model artifacts.
//!
//! Every download path that accepts remote model binaries must verify against a
//! pinned hex digest before the file is treated as available. An empty pin fails
//! closed (never accepted). Hash pins come from Hugging Face LFS OIDs (which are
//! the raw content SHA-256 for LFS-tracked files).

use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, Context, Result};

/// Lowercase-hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Stream-hash a file on disk (avoids loading multi-GB models into memory).
pub fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("open {} for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).context("read for hashing")?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Verify in-memory bytes against a pinned hex digest. Empty pin fails closed.
pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> bool {
    !expected_hex.is_empty() && sha256_hex(bytes).eq_ignore_ascii_case(expected_hex)
}

/// Verify a file on disk against a pinned hex digest. Empty pin fails closed.
pub fn verify_file_sha256(path: &Path, expected_hex: &str) -> Result<()> {
    if expected_hex.is_empty() {
        return Err(anyhow!(
            "refusing to accept {} without a pinned SHA-256",
            path.display()
        ));
    }
    let actual = sha256_file(path)?;
    if !actual.eq_ignore_ascii_case(expected_hex) {
        return Err(anyhow!(
            "SHA-256 mismatch for {}: expected {}, got {}",
            path.display(),
            expected_hex,
            actual
        ));
    }
    Ok(())
}

/// Pinned Whisper ggml model SHA-256 by logical model name (matches download keys).
pub fn whisper_model_sha256(model_name: &str) -> Option<&'static str> {
    Some(match model_name {
        "tiny" => "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        "base" => "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        "small" => "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        "medium" => "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        "large-v3-turbo" => "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        "large-v3" => "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
        "tiny-q5_1" => "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
        "base-q5_1" => "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        "small-q5_1" => "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        "medium-q5_0" => "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
        "large-v3-turbo-q5_0" => "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        "large-v3-q5_0" => "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
        _ => return None,
    })
}

/// Pinned SHA-256 for a Parakeet ONNX/vocab file basename (v3 repo pins).
pub fn parakeet_file_sha256(filename: &str) -> Option<&'static str> {
    Some(match filename {
        "encoder-model.int8.onnx" => {
            "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"
        }
        "decoder_joint-model.int8.onnx" => {
            "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"
        }
        "encoder-model.onnx" => "98a74b21b4cc0017c1e7030319a4a96f4a9506e50f0708f3a516d02a77c96bb1",
        "encoder-model.onnx.data" => {
            "9a22d372c51455c34f13405da2520baefb7125bd16981397561423ed32d24f36"
        }
        "decoder_joint-model.onnx" => {
            "e978ddf6688527182c10fde2eb4b83068421648985ef23f7a86be732be8706c1"
        }
        "nemo128.onnx" => "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
        "vocab.txt" => "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        _ => return None,
    })
}

/// Pinned GGUF summary model SHA-256 by on-disk filename (`ModelDef.gguf_file`).
pub fn gguf_filename_sha256(filename: &str) -> Option<&'static str> {
    Some(match filename {
        "Qwen3.5-2B-Q4_K_M.gguf" => {
            "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223"
        }
        "Qwen3.5-4B-Q4_K_M.gguf" => {
            "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"
        }
        // Local names drop the `google_` prefix from the HF artifact.
        "gemma-3-4b-it-Q4_K_M.gguf" | "google_gemma-3-4b-it-Q4_K_M.gguf" => {
            "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94"
        }
        "gemma-3-1b-it-Q8_0.gguf" | "google_gemma-3-1b-it-Q8_0.gguf" => {
            "375e12a4a18929a641f9744b060d4a7cf4e279530750555828ec0c117870bc96"
        }
        _ => return None,
    })
}

/// Require a pin for `kind`/`id` and verify the file. Deletes the file on mismatch.
pub fn require_and_verify(path: &Path, expected: Option<&str>, label: &str) -> Result<()> {
    let Some(pin) = expected.filter(|s| !s.is_empty()) else {
        let _ = std::fs::remove_file(path);
        return Err(anyhow!(
            "no pinned SHA-256 for {label}; refusing to accept {}",
            path.display()
        ));
    };
    if let Err(e) = verify_file_sha256(path, pin) {
        let _ = std::fs::remove_file(path);
        return Err(e.context(format!("integrity check failed for {label}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_sha256_fails_closed_on_empty_pin() {
        assert!(!verify_sha256(b"abc", ""));
    }

    #[test]
    fn verify_file_sha256_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"abc").unwrap();
        drop(f);
        verify_file_sha256(
            &path,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )
        .unwrap();
        assert!(verify_file_sha256(&path, "deadbeef").is_err());
    }

    #[test]
    fn whisper_pins_cover_supported_models() {
        for name in [
            "tiny",
            "base",
            "small",
            "medium",
            "large-v3-turbo",
            "large-v3",
            "tiny-q5_1",
            "base-q5_1",
            "small-q5_1",
            "medium-q5_0",
            "large-v3-turbo-q5_0",
            "large-v3-q5_0",
        ] {
            assert!(
                whisper_model_sha256(name).is_some(),
                "missing pin for {name}"
            );
        }
    }

    #[test]
    fn require_and_verify_deletes_on_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.bin");
        std::fs::write(&path, b"nope").unwrap();
        let err = require_and_verify(
            &path,
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            "test",
        );
        assert!(err.is_err());
        assert!(!path.exists(), "mismatched file must be deleted");
    }
}
