use crate::providers::common::{fetch_models, ModelCache, ModelProvider};
use serde::{Deserialize, Serialize};
use tauri::command;

/// xAI model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct XaiModel {
    pub id: String,
    pub owned_by: Option<String>,
}

/// API response model from xAI (OpenAI-compatible format)
#[derive(Debug, Deserialize)]
pub struct XaiApiModel {
    id: String,
    owned_by: Option<String>,
    #[allow(dead_code)]
    object: String,
}

/// Global cache for xAI models (5 minute TTL)
static MODELS_CACHE: ModelCache<XaiModel> = ModelCache::new();

/// Fallback models when API fetch fails (verified from https://docs.x.ai/docs/models as of 2026-06-16)
const FALLBACK_MODELS: &[&str] = &["grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"];

/// Check if model is a chat-capable model (filter out image and embedding models)
fn is_chat_model(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    !id.contains("imagine") && !id.contains("embed")
}

struct XaiProvider;

impl ModelProvider for XaiProvider {
    type UiModel = XaiModel;
    type ApiModel = XaiApiModel;

    const NAME: &'static str = "xAI";
    const ENDPOINT: &'static str = "https://api.x.ai/v1/models";

    fn cache() -> &'static ModelCache<Self::UiModel> {
        &MODELS_CACHE
    }

    fn auth_headers(api_key: &str) -> Vec<(&'static str, String)> {
        vec![("Authorization", format!("Bearer {}", api_key))]
    }

    fn fallback_models() -> Vec<Self::UiModel> {
        FALLBACK_MODELS
            .iter()
            .map(|id| XaiModel {
                id: id.to_string(),
                owned_by: None,
            })
            .collect()
    }

    fn map_model(api: Self::ApiModel) -> Option<Self::UiModel> {
        is_chat_model(&api.id).then(|| XaiModel {
            id: api.id,
            owned_by: api.owned_by,
        })
    }
}

/// Fetch xAI models from the API (falls back to a hardcoded list on error).
#[command]
pub async fn get_xai_models(api_key: Option<String>) -> Result<Vec<XaiModel>, String> {
    fetch_models::<XaiProvider>(api_key).await
}

/// Clear the models cache (useful when API key changes)
pub fn clear_cache() {
    MODELS_CACHE.clear();
    log::info!("xAI models cache cleared");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_models_are_all_chat_models() {
        for id in FALLBACK_MODELS {
            assert!(
                is_chat_model(id),
                "fallback model '{}' would be filtered by is_chat_model",
                id
            );
        }
    }

    #[test]
    fn is_chat_model_filters_image_and_embed() {
        assert!(!is_chat_model("grok-imagine-image-quality"));
        assert!(!is_chat_model("grok-embed-v1"));
        assert!(is_chat_model("grok-4.3"));
        assert!(is_chat_model("grok-4.20-0309-reasoning"));
    }
}
