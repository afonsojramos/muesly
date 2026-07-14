//! Speaker diarization sidecar.
//!
//! Reads one JSON request from stdin and writes one JSON response to stdout,
//! mirroring the `llama-helper` sidecar's isolation. It runs `sherpa-onnx`
//! offline speaker diarization (pyannote segmentation + a speaker-embedding
//! model + fast clustering) on a mono 16 kHz f32 PCM track and returns
//! speaker-labeled time turns.
//!
//! It lives in its own process because `sherpa-onnx` statically links its own
//! ONNX Runtime, which would collide with the main app's `ort` link (Parakeet).
//!
//! Request (one line of JSON on stdin):
//! ```json
//! { "segmentation_model": "...", "embedding_model": "...",
//!   "pcm_path": "/abs/path/to/mono16k.f32le", "num_clusters": 0,
//!   "threshold": 0.5, "num_threads": 1 }
//! ```
//! `pcm_path` points at a file of raw little-endian f32 mono samples at the
//! diarizer's expected sample rate (16 kHz). `num_clusters <= 0` auto-detects
//! the speaker count using `threshold`.
//!
//! Response (one line of JSON on stdout):
//! ```json
//! { "ok": true, "sample_rate": 16000, "num_speakers": 2,
//!   "segments": [{ "start": 0.0, "end": 1.2, "speaker": 0 }] }
//! ```
//! or `{ "ok": false, "error": "..." }`.

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractorConfig,
};
use std::io::Read;

#[derive(Deserialize)]
struct Request {
    segmentation_model: String,
    embedding_model: String,
    pcm_path: String,
    /// `<= 0` auto-detects the speaker count via `threshold`.
    #[serde(default)]
    num_clusters: i32,
    #[serde(default = "default_threshold")]
    threshold: f32,
    #[serde(default = "default_threads")]
    num_threads: i32,
}

fn default_threshold() -> f32 {
    0.5
}
fn default_threads() -> i32 {
    1
}

#[derive(Serialize)]
struct Segment {
    start: f32,
    end: f32,
    speaker: i32,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_rate: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_speakers: Option<i32>,
    segments: Vec<Segment>,
}

impl Response {
    fn error(message: String) -> Self {
        Self {
            ok: false,
            error: Some(message),
            sample_rate: None,
            num_speakers: None,
            segments: Vec::new(),
        }
    }
}

/// Decode a buffer of raw little-endian `f32` samples. Returns an error if the
/// byte length is not a multiple of 4 (a truncated/misaligned PCM file).
fn decode_f32_le(bytes: &[u8]) -> Result<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return Err(anyhow!(
            "pcm byte length {} is not a multiple of 4 (expected little-endian f32)",
            bytes.len()
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

fn run() -> Result<Response> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("failed to read request from stdin")?;
    let req: Request = serde_json::from_str(input.trim()).context("invalid request JSON")?;

    let bytes = std::fs::read(&req.pcm_path)
        .with_context(|| format!("failed to read pcm file {}", req.pcm_path))?;
    let samples = decode_f32_le(&bytes)?;
    if samples.is_empty() {
        return Err(anyhow!("pcm file {} contained no samples", req.pcm_path));
    }

    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(req.segmentation_model),
            },
            num_threads: req.num_threads,
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(req.embedding_model),
            num_threads: req.num_threads,
            ..Default::default()
        },
        clustering: FastClusteringConfig {
            num_clusters: req.num_clusters,
            threshold: req.threshold,
        },
        ..Default::default()
    };

    let diarizer = OfflineSpeakerDiarization::create(&config)
        .ok_or_else(|| anyhow!("failed to create diarizer (check model paths)"))?;
    let sample_rate = diarizer.sample_rate();
    let result = diarizer
        .process(&samples)
        .ok_or_else(|| anyhow!("diarization processing failed"))?;
    let segments = result
        .sort_by_start_time()
        .into_iter()
        .map(|s| Segment {
            start: s.start,
            end: s.end,
            speaker: s.speaker,
        })
        .collect();

    Ok(Response {
        ok: true,
        error: None,
        sample_rate: Some(sample_rate),
        num_speakers: Some(result.num_speakers()),
        segments,
    })
}

fn main() {
    let response = run().unwrap_or_else(|e| Response::error(format!("{e:#}")));
    let json = serde_json::to_string(&response).unwrap_or_else(|e| {
        format!("{{\"ok\":false,\"error\":\"failed to serialize response: {e}\"}}")
    });
    println!("{json}");
    if !response.ok {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_f32_le_roundtrips_samples() {
        let samples = [0.0f32, 1.5, -2.25, 0.125];
        let mut bytes = Vec::new();
        for s in &samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let decoded = decode_f32_le(&bytes).expect("decode");
        assert_eq!(decoded, samples);
    }

    #[test]
    fn decode_f32_le_empty_is_empty() {
        assert!(decode_f32_le(&[]).expect("decode").is_empty());
    }

    #[test]
    fn decode_f32_le_rejects_misaligned_length() {
        // 5 bytes is not a whole number of f32 samples.
        assert!(decode_f32_le(&[0, 0, 0, 0, 1]).is_err());
    }
}
