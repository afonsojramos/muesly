use crate::providers::common::{ModelCache, ModelProvider, fetch_models};
use serde::{Deserialize, Serialize};
use tauri::command;

/// OpenAI model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
pub struct OpenAIModel {
    pub id: String,
}

/// API response model from OpenAI
#[derive(Debug, Deserialize)]
pub struct OpenAIApiModel {
    id: String,
    #[allow(dead_code)]
    object: String,
    #[allow(dead_code)]
    owned_by: String,
}

/// Global cache for OpenAI models (5 minute TTL)
static MODELS_CACHE: ModelCache<OpenAIModel> = ModelCache::new();

/// Fallback models when API fetch fails (matches frontend hardcoded values)
const FALLBACK_MODELS: &[&str] = &[
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4.1",
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-4o-2024-11-20",
    "gpt-4o-2024-08-06",
    "gpt-4o-mini-2024-07-18",
    "gpt-4.1-2025-04-14",
    "gpt-4.1-nano-2025-04-14",
    "gpt-4.1-mini-2025-04-14",
    "o4-mini-2025-04-16",
    "o3-2025-04-16",
    "o3-mini-2025-01-31",
    "o1-2024-12-17",
    "o1-mini-2024-09-12",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-0125-Preview",
    "gpt-4-vision-preview",
    "gpt-4-1106-Preview",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
];

/// Check if model is a chat-capable model (filter out embedding, tts, etc.)
fn is_chat_model(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    // Include gpt-*, o1-*, o3-*, o4-* models
    // Exclude embedding, tts, whisper, dall-e, babbage, davinci (non-chat models)
    (id.starts_with("gpt-")
        || id.starts_with("o1-")
        || id.starts_with("o3-")
        || id.starts_with("o4-")
        || id.starts_with("chatgpt-"))
        && !id.contains("embedding")
        && !id.contains("tts")
        && !id.contains("whisper")
        && !id.contains("dall-e")
        && !id.contains("babbage")
        && !id.contains("davinci")
        && !id.contains("instruct")
        && !id.contains("realtime")
        && !id.contains("audio")
}

struct OpenAiProvider;

impl ModelProvider for OpenAiProvider {
    type UiModel = OpenAIModel;
    type ApiModel = OpenAIApiModel;

    const NAME: &'static str = "OpenAI";
    const ENDPOINT: &'static str = "https://api.openai.com/v1/models";

    fn cache() -> &'static ModelCache<Self::UiModel> {
        &MODELS_CACHE
    }

    fn auth_headers(api_key: &str) -> Vec<(&'static str, String)> {
        vec![("Authorization", format!("Bearer {}", api_key))]
    }

    fn fallback_models() -> Vec<Self::UiModel> {
        FALLBACK_MODELS
            .iter()
            .map(|id| OpenAIModel { id: id.to_string() })
            .collect()
    }

    fn map_model(api: Self::ApiModel) -> Option<Self::UiModel> {
        is_chat_model(&api.id).then(|| OpenAIModel { id: api.id })
    }
}

/// Fetch OpenAI models from the API (falls back to a hardcoded list on error).
#[command]
#[specta::specta]
pub async fn get_openai_models(api_key: Option<String>) -> Result<Vec<OpenAIModel>, String> {
    fetch_models::<OpenAiProvider>(api_key).await
}

/// Clear the models cache (useful when API key changes)
pub fn clear_cache() {
    MODELS_CACHE.clear();
    log::info!("OpenAI models cache cleared");
}
