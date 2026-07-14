//! In-process client for the `diarization-helper` sidecar.
//!
//! Spawns the sidecar one-shot per recording: writes the mono 16 kHz f32 PCM to
//! a temp file, sends a JSON request over stdin, and parses the JSON speaker
//! turns from stdout. The sidecar owns `sherpa-onnx`; this side never links it.

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::diarization::reconcile::SpeakerTurn;

#[derive(Serialize)]
struct SidecarRequest<'a> {
    segmentation_model: &'a str,
    embedding_model: &'a str,
    pcm_path: &'a str,
    num_clusters: i32,
    threshold: f32,
    num_threads: i32,
}

#[derive(Deserialize)]
struct SidecarSegment {
    start: f32,
    end: f32,
    speaker: i32,
}

#[derive(Deserialize)]
struct SidecarResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    segments: Vec<SidecarSegment>,
}

/// Locate the `diarization-helper` binary: an explicit override, then alongside
/// the running executable (covers both the bundled sidecar with a target-triple
/// suffix and the dev `target/<profile>/` build, which sit next to the app
/// binary).
fn resolve_sidecar_binary() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("MUESLY_DIARIZATION_HELPER") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["diarization-helper", "diarization-helper.exe"] {
                let candidate = dir.join(name);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
            // Bundled sidecars carry a target-triple suffix next to the app binary.
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("diarization-helper") && !name.ends_with(".d") {
                        return Ok(entry.path());
                    }
                }
            }
        }
    }

    Err(anyhow!(
        "diarization-helper binary not found; build it with `cargo build -p diarization-helper` or set MUESLY_DIARIZATION_HELPER"
    ))
}

/// Run speaker diarization on mono 16 kHz f32 samples, returning speaker turns
/// sorted by start time. `num_clusters <= 0` auto-detects the speaker count.
pub fn diarize(
    samples_16k: &[f32],
    segmentation_model: &Path,
    embedding_model: &Path,
    num_clusters: i32,
    threshold: f32,
) -> Result<Vec<SpeakerTurn>> {
    let binary = resolve_sidecar_binary()?;

    // PCM travels via a temp file (it is large); only the small JSON request
    // goes over stdin, which avoids any pipe-buffer deadlock.
    let mut pcm = tempfile::NamedTempFile::new().context("create diarization PCM temp file")?;
    let mut bytes = Vec::with_capacity(samples_16k.len() * 4);
    for sample in samples_16k {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    pcm.write_all(&bytes).context("write diarization PCM")?;
    pcm.flush().ok();
    let pcm_path = pcm.path().to_string_lossy().to_string();

    let request = SidecarRequest {
        segmentation_model: &segmentation_model.to_string_lossy(),
        embedding_model: &embedding_model.to_string_lossy(),
        pcm_path: &pcm_path,
        num_clusters,
        threshold,
        num_threads: 1,
    };
    let request_json = serde_json::to_string(&request).context("serialize diarization request")?;

    let mut child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn diarization sidecar {}", binary.display()))?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("diarization sidecar stdin unavailable"))?;
        stdin
            .write_all(request_json.as_bytes())
            .context("write diarization request to sidecar")?;
        // Dropping stdin closes it, signalling end-of-request to the sidecar.
    }

    let output = child
        .wait_with_output()
        .context("wait for diarization sidecar")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response: SidecarResponse = serde_json::from_str(stdout.trim()).with_context(|| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("parse diarization response (stdout={stdout:?}, stderr={stderr:?})")
    })?;

    if !response.ok {
        return Err(anyhow!(
            "diarization sidecar failed: {}",
            response
                .error
                .unwrap_or_else(|| "unknown error".to_string())
        ));
    }

    Ok(response
        .segments
        .into_iter()
        .map(|s| SpeakerTurn {
            start: s.start as f64,
            end: s.end as f64,
            speaker: s.speaker,
        })
        .collect())
}
