//! Types shared by the transcription engines (Whisper, Parakeet).
//!
//! The two engines manage models with genuinely different on-disk layouts
//! (Whisper = a single GGML `.bin` file; Parakeet = a directory of ONNX files),
//! so their download/discovery I/O is intentionally NOT shared. What they DO
//! share — and what lives here — is the model lifecycle status type, kept as a
//! single definition so the two engines (and the frontend that deserializes it)
//! can never drift apart.

use serde::{Deserialize, Serialize};

/// Lifecycle status of a transcription model on disk.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum ModelStatus {
    /// Present and validated; ready to load.
    Available,
    /// Not present on disk.
    Missing,
    /// Currently downloading, with percentage progress.
    Downloading { progress: u8 },
    /// An error occurred (message included).
    Error(String),
    /// Present but failed validation (size mismatch).
    Corrupted { file_size: u64, expected_min_size: u64 },
}
