// audio/transcription/mod.rs
//
// Transcription module: Whisper engine management and worker pool.

pub mod crosstalk;
pub mod engine;
pub mod provider;
pub mod segment_filter;
pub mod worker;

// Re-export commonly used types
pub use engine::{
    TranscriptionEngine, configured_transcription_model, get_automatic_transcription_model,
    get_or_init_transcription_engine, get_or_init_whisper, resolve_requested_transcription_model,
    validate_transcription_model_ready,
};
pub use provider::TranscriptionError;
pub use worker::{TranscriptUpdate, reset_speech_detected_flag, start_transcription_task};
