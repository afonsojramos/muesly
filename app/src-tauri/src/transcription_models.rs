//! Types shared by the Whisper engine and frontend.
//!
//! Whisper models are single GGML `.bin` files. This module keeps the model
//! lifecycle status shared by the engine commands and the frontend bindings.

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
