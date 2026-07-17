//! Shared SHA-256 integrity checks for downloaded model artifacts.
//!
//! Every download path that accepts remote model binaries must verify against a
//! pinned hex digest before the file is treated as available. An empty pin fails
//! closed (never accepted). Hash pins come from Hugging Face LFS OIDs (which are
//! the raw content SHA-256 for LFS-tracked files).

use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result, anyhow};

/// Lowercase-hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Stream-hash a file on disk (avoids loading multi-GB models into memory).
fn sha256_opened_file(file: &mut std::fs::File) -> Result<String> {
    use sha2::{Digest, Sha256};
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

/// Stream-hash a file on disk (avoids loading multi-GB models into memory).
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = crate::model_storage::open_attested_file_for_read(path, "model artifact")
        .with_context(|| format!("open {} for hashing", path.display()))?;
    let digest = sha256_opened_file(&mut file)?;
    crate::model_storage::attest_opened_file(path, &file, "hashed model artifact")?;
    Ok(digest)
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

/// Canonical file set for the actively shipped Parakeet v3 INT8 artifact.
///
/// Keep the model-name binding here, next to the file pins: the evaluator must
/// not apply v3 hashes to an installed legacy model that happens to reuse the
/// same filenames.
pub fn parakeet_model_artifact_files(model_name: &str) -> Option<&'static [&'static str]> {
    const V3_INT8_FILES: &[&str] = &[
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
        "nemo128.onnx",
        "vocab.txt",
    ];

    match model_name {
        "parakeet-tdt-0.6b-v3-int8" => Some(V3_INT8_FILES),
        _ => None,
    }
}

/// Return the canonical product digest for a shipped Whisper artifact.
pub fn expected_whisper_model_artifact_sha256(model_name: &str) -> Result<&'static str> {
    whisper_model_sha256(model_name).ok_or_else(|| {
        anyhow!("no pinned SHA-256 for whisper model '{model_name}'; refusing to benchmark it")
    })
}

/// Return the stable filename + per-file-pin manifest digest used by the
/// evaluator for the actively shipped Parakeet artifact.
pub fn expected_parakeet_model_artifact_sha256(model_name: &str) -> Result<String> {
    let files = parakeet_model_artifact_files(model_name).ok_or_else(|| {
        anyhow!(
            "no pinned artifact set for parakeet model '{model_name}'; refusing to benchmark it"
        )
    })?;

    let mut manifest = String::new();
    for filename in files {
        let pin = parakeet_file_sha256(filename).ok_or_else(|| {
            anyhow!(
                "no pinned SHA-256 for parakeet model '{model_name}' file '{filename}'; refusing to benchmark it"
            )
        })?;
        if !manifest.is_empty() {
            manifest.push('\n');
        }
        manifest.push_str(filename);
        manifest.push('\0');
        manifest.push_str(pin);
    }
    Ok(sha256_hex(manifest.as_bytes()))
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

/// Require and verify a direct provider artifact, deleting only that confined
/// single-link file on failure.
pub fn require_and_verify_confined(
    parent: &Path,
    filename: &str,
    expected: Option<&str>,
    label: &str,
) -> Result<()> {
    let path = parent.join(filename);
    crate::model_storage::attest_model_file(parent, filename, label)?
        .ok_or_else(|| anyhow!("{label} is missing: {}", path.display()))?;
    let result = expected
        .filter(|pin| !pin.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "no pinned SHA-256 for {label}; refusing to accept {}",
                path.display()
            )
        })
        .and_then(|pin| {
            verify_file_sha256(&path, pin)
                .with_context(|| format!("integrity check failed for {label}"))
        });
    if let Err(error) = result {
        crate::model_storage::remove_model_file(parent, filename, label)
            .with_context(|| format!("securely remove rejected {label}"))?;
        return Err(error);
    }
    crate::model_storage::attest_model_file(parent, filename, label)?
        .ok_or_else(|| anyhow!("{label} disappeared after verification"))?;
    Ok(())
}

/// Verify a confined partial artifact before atomically publishing it under the
/// filename observed by model discovery and loading.
pub fn verify_and_publish_confined(
    parent: &Path,
    partial_filename: &str,
    final_filename: &str,
    expected: Option<&str>,
    label: &str,
) -> Result<()> {
    let path = parent.join(partial_filename);
    let Some(pin) = expected.filter(|pin| !pin.is_empty()) else {
        crate::model_storage::remove_model_file(parent, partial_filename, label)?;
        return Err(anyhow!(
            "no pinned SHA-256 for {label}; refusing to accept {}",
            path.display()
        ));
    };
    crate::model_storage::attest_model_file(parent, partial_filename, label)?
        .ok_or_else(|| anyhow!("{label} is missing: {}", path.display()))?;
    let mut file = crate::model_storage::open_attested_file_for_read(&path, label)?;
    let actual = sha256_opened_file(&mut file)?;
    crate::model_storage::attest_opened_file(&path, &file, label)?;
    if !actual.eq_ignore_ascii_case(pin) {
        drop(file);
        crate::model_storage::remove_model_file(parent, partial_filename, label)?;
        return Err(anyhow!(
            "SHA-256 mismatch for {}: expected {}, got {}",
            path.display(),
            pin,
            actual
        ));
    }
    crate::model_storage::rename_opened_model_file(
        parent,
        partial_filename,
        final_filename,
        &file,
    )?;
    crate::model_storage::attest_model_file(parent, final_filename, label)?
        .ok_or_else(|| anyhow!("{label} disappeared after publication"))?;
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
        assert!(
            path.exists(),
            "read-only verification must not delete a mismatch"
        );
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
    fn parakeet_pins_cover_the_active_model_artifact() {
        let files = parakeet_model_artifact_files("parakeet-tdt-0.6b-v3-int8").unwrap();
        assert_eq!(files.len(), 4);
        for filename in files {
            assert!(
                parakeet_file_sha256(filename).is_some(),
                "missing pin for {filename}"
            );
        }
        assert!(parakeet_model_artifact_files("parakeet-tdt-0.6b-v2-int8").is_none());
        let manifest = files
            .iter()
            .map(|filename| format!("{filename}\0{}", parakeet_file_sha256(filename).unwrap()))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            sha256_hex(manifest.as_bytes()),
            "b58197a2d6a6a6b8757ed61005451878028147605499da69d12d16ae4d7efba8"
        );
    }

    #[test]
    fn expected_whisper_artifact_digest_fails_closed_for_unknown_models() {
        let unknown = expected_whisper_model_artifact_sha256("not-in-the-catalog").unwrap_err();
        assert!(unknown.to_string().contains("no pinned SHA-256"));
        assert_eq!(
            expected_whisper_model_artifact_sha256("large-v3-turbo-q5_0").unwrap(),
            "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
        );
    }

    #[test]
    fn expected_parakeet_artifact_digest_fails_closed_for_unknown_models() {
        let unknown =
            expected_parakeet_model_artifact_sha256("parakeet-tdt-0.6b-v2-int8").unwrap_err();
        assert!(unknown.to_string().contains("no pinned artifact set"));
        assert_eq!(
            expected_parakeet_model_artifact_sha256("parakeet-tdt-0.6b-v3-int8").unwrap(),
            "b58197a2d6a6a6b8757ed61005451878028147605499da69d12d16ae4d7efba8"
        );
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

    #[test]
    fn confined_verification_rejects_hardlinked_artifacts_without_deleting_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.bin");
        let alias = outside.path().join("alias.bin");
        std::fs::write(&path, b"abc").unwrap();
        std::fs::hard_link(&path, &alias).unwrap();

        let error = require_and_verify_confined(
            dir.path(),
            "bad.bin",
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177b7acdd1b1919c6e1b21"),
            "test artifact",
        )
        .unwrap_err();

        assert!(error.to_string().contains("single-link"));
        assert!(path.exists());
        assert!(alias.exists());
    }

    #[test]
    fn confined_publication_never_exposes_unverified_partial_bytes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("model.bin.part"), b"untrusted").unwrap();

        assert!(
            verify_and_publish_confined(
                dir.path(),
                "model.bin.part",
                "model.bin",
                Some("ba7816bf8f01cfea414140de5dae2223b00361a396177b7acdd1b1919c6e1b21"),
                "test artifact",
            )
            .is_err()
        );
        assert!(!dir.path().join("model.bin.part").exists());
        assert!(!dir.path().join("model.bin").exists());

        std::fs::write(dir.path().join("model.bin.part"), b"abc").unwrap();
        verify_and_publish_confined(
            dir.path(),
            "model.bin.part",
            "model.bin",
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            "test artifact",
        )
        .unwrap();
        assert!(!dir.path().join("model.bin.part").exists());
        assert_eq!(std::fs::read(dir.path().join("model.bin")).unwrap(), b"abc");
    }
}
