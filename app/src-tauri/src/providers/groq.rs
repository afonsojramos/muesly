use crate::providers::common::{fetch_models, ModelCache, ModelProvider};
use serde::{Deserialize, Serialize};
use tauri::command;

/// Groq model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroqModel {
    pub id: String,
    pub owned_by: Option<String>,
}

/// API response model from Groq (OpenAI-compatible format)
#[derive(Debug, Deserialize)]
pub struct GroqApiModel {
    id: String,
    owned_by: Option<String>,
    #[allow(dead_code)]
    object: String,
}

/// Global cache for Groq models (5 minute TTL)
static MODELS_CACHE: ModelCache<GroqModel> = ModelCache::new();

/// Fallback models when API fetch fails (matches frontend hardcoded values)
const FALLBACK_MODELS: &[&str] = &["llama-3.3-70b-versatile"];

/// Check if model is a chat-capable model (filter out whisper, etc.)
fn is_chat_model(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    // Exclude whisper, tool-use specific models, and embedding models
    !id.contains("whisper")
        && !id.contains("embed")
        && !id.contains("guard")
        && !id.contains("tool-use")
}

struct GroqProvider;

impl ModelProvider for GroqProvider {
    type UiModel = GroqModel;
    type ApiModel = GroqApiModel;

    const NAME: &'static str = "Groq";
    const ENDPOINT: &'static str = "https://api.groq.com/openai/v1/models";

    fn cache() -> &'static ModelCache<Self::UiModel> {
        &MODELS_CACHE
    }

    fn auth_headers(api_key: &str) -> Vec<(&'static str, String)> {
        vec![("Authorization", format!("Bearer {}", api_key))]
    }

    fn fallback_models() -> Vec<Self::UiModel> {
        FALLBACK_MODELS
            .iter()
            .map(|id| GroqModel {
                id: id.to_string(),
                owned_by: None,
            })
            .collect()
    }

    fn map_model(api: Self::ApiModel) -> Option<Self::UiModel> {
        is_chat_model(&api.id).then(|| GroqModel {
            id: api.id,
            owned_by: api.owned_by,
        })
    }
}

/// Fetch Groq models from the API (falls back to a hardcoded list on error).
#[command]
pub async fn get_groq_models(api_key: Option<String>) -> Result<Vec<GroqModel>, String> {
    fetch_models::<GroqProvider>(api_key).await
}

/// Clear the models cache (useful when API key changes)
pub fn clear_cache() {
    MODELS_CACHE.clear();
    log::info!("Groq models cache cleared");
}
