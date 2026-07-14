use crate::providers::common::{ModelCache, ModelProvider, fetch_models};
use serde::{Deserialize, Serialize};
use tauri::command;

/// Anthropic (Claude) model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
pub struct AnthropicModel {
    pub id: String,
    pub display_name: Option<String>,
}

/// API response model from Anthropic
#[derive(Debug, Deserialize)]
pub struct AnthropicApiModel {
    id: String,
    display_name: Option<String>,
    #[allow(dead_code)]
    created_at: Option<String>,
}

/// Global cache for Anthropic models (5 minute TTL)
static MODELS_CACHE: ModelCache<AnthropicModel> = ModelCache::new();

/// Fallback models when API fetch fails (matches frontend hardcoded values)
const FALLBACK_MODELS: &[(&str, &str)] = &[
    ("claude-sonnet-4-5-20250929", "Claude 4.5 Sonnet"),
    ("claude-haiku-4-5-20251001", "Claude 4.5 Haiku"),
    ("claude-opus-4-1-20250805", "Claude 4.1 Opus"),
    ("claude-sonnet-4-20250514", "Claude 4 Sonnet"),
];

/// Check if model is a chat-capable model
fn is_chat_model(model_id: &str) -> bool {
    // Include Claude models only
    model_id.to_lowercase().starts_with("claude-")
}

struct AnthropicProvider;

impl ModelProvider for AnthropicProvider {
    type UiModel = AnthropicModel;
    type ApiModel = AnthropicApiModel;

    const NAME: &'static str = "Anthropic";
    const ENDPOINT: &'static str = "https://api.anthropic.com/v1/models";

    fn cache() -> &'static ModelCache<Self::UiModel> {
        &MODELS_CACHE
    }

    fn auth_headers(api_key: &str) -> Vec<(&'static str, String)> {
        vec![
            ("x-api-key", api_key.to_string()),
            ("anthropic-version", "2023-06-01".to_string()),
        ]
    }

    fn fallback_models() -> Vec<Self::UiModel> {
        FALLBACK_MODELS
            .iter()
            .map(|(id, name)| AnthropicModel {
                id: id.to_string(),
                display_name: Some(name.to_string()),
            })
            .collect()
    }

    fn map_model(api: Self::ApiModel) -> Option<Self::UiModel> {
        is_chat_model(&api.id).then(|| AnthropicModel {
            id: api.id,
            display_name: api.display_name,
        })
    }
}

/// Fetch Anthropic models from the API (falls back to a hardcoded list on error).
#[command]
#[specta::specta]
pub async fn get_anthropic_models(api_key: Option<String>) -> Result<Vec<AnthropicModel>, String> {
    fetch_models::<AnthropicProvider>(api_key).await
}

/// Clear the models cache (useful when API key changes)
pub fn clear_cache() {
    MODELS_CACHE.clear();
    log::info!("Anthropic models cache cleared");
}
