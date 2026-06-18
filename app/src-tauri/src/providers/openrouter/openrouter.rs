use crate::providers::common::{http_client, ModelCache, REQUEST_TIMEOUT};
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub context_length: Option<u32>,
    pub prompt_price: Option<String>,
    pub completion_price: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterApiModel {
    id: String,
    name: Option<String>,
    context_length: Option<u32>,
    #[serde(default)]
    top_provider: Option<TopProvider>,
    #[serde(default)]
    pricing: Option<Pricing>,
}

#[derive(Debug, Deserialize, Default)]
struct TopProvider {
    context_length: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
struct Pricing {
    prompt: Option<String>,
    completion: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterResponse {
    data: Vec<OpenRouterApiModel>,
}

/// Global cache for OpenRouter models (5 minute TTL)
static MODELS_CACHE: ModelCache<OpenRouterModel> = ModelCache::new();

/// Fetch the OpenRouter model catalog.
///
/// The `/models` endpoint is public (no API key). This is `async` and uses the
/// shared HTTP client with a timeout — the previous `reqwest::blocking` client
/// would panic ("runtime within a runtime") or stall the executor when called
/// from Tauri's async command dispatch.
#[command]
pub async fn get_openrouter_models() -> Result<Vec<OpenRouterModel>, String> {
    if let Some(models) = MODELS_CACHE.get() {
        log::info!("Returning cached OpenRouter models ({} models)", models.len());
        return Ok(models);
    }

    let client = http_client();
    let response = client
        .get("https://openrouter.ai/api/v1/models")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Failed to make HTTP request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP request failed with status: {}", response.status()));
    }

    let api_response: OpenRouterResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON response: {}", e))?;

    let models: Vec<OpenRouterModel> = api_response
        .data
        .into_iter()
        .map(|m| OpenRouterModel {
            id: m.id,
            name: m.name.unwrap_or_else(|| "Unknown".to_string()),
            context_length: m.top_provider
                .as_ref()
                .and_then(|tp| tp.context_length)
                .or(m.context_length),
            prompt_price: m.pricing.as_ref().and_then(|p| p.prompt.clone()),
            completion_price: m.pricing.as_ref().and_then(|p| p.completion.clone()),
        })
        .collect();

    MODELS_CACHE.store(models.clone());

    Ok(models)
}

/// Clear the models cache (useful when settings change)
pub fn clear_cache() {
    MODELS_CACHE.clear();
    log::info!("OpenRouter models cache cleared");
}
