// audio/transcription/mod.rs
//
// Transcription module: Whisper engine management and worker pool.

pub mod crosstalk;
pub mod provider;
pub mod segment_filter;
pub mod engine;
pub mod worker;

// Re-export commonly used types
pub use provider::TranscriptionError;
pub use engine::{
    TranscriptionEngine,
    validate_transcription_model_ready,
    get_or_init_transcription_engine,
    get_or_init_whisper
};
pub use worker::{
    start_transcription_task,
    reset_speech_detected_flag,
    TranscriptUpdate
};
