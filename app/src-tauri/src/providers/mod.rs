//! Cloud LLM provider integrations: model-catalog discovery and per-provider
//! metadata. The chat/inference path lives in `summary::llm_client`.

/// Shared helpers for the provider model-listing commands (HTTP client, model
/// cache, the `ModelProvider` trait, `fetch_models`).
pub mod common;

pub mod anthropic;
pub mod groq;
pub mod ollama;
pub mod openai;
pub mod openrouter;
pub mod xai;
