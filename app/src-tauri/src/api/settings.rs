// Model/transcript config, API-key, and custom-OpenAI command handlers.
use log::{error as log_error, info as log_info, warn as log_warn};
use tauri::{AppHandle, Runtime};

use crate::{
    database::repositories::setting::SettingsRepository, keychain::keyring_store, state::AppState,
    summary::CustomOpenAIConfig,
};

use super::types::*;

/// Invalidate a provider's cached model list. The cloud providers cache their
/// `/models` response with a 5-minute TTL, so without this an API-key change
/// would show a stale list (or fallback models) until the TTL elapsed.
fn clear_provider_model_cache(provider: &str) {
    match provider {
        "anthropic" => crate::providers::anthropic::clear_cache(),
        "openai" | "custom-openai" => crate::providers::openai::clear_cache(),
        "groq" => crate::providers::groq::clear_cache(),
        "grok" => crate::providers::xai::clear_cache(),
        "openrouter" => crate::providers::openrouter::clear_cache(),
        _ => {}
    }
}
#[tauri::command]
#[specta::specta]
pub async fn api_get_model_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    _auth_token: Option<String>,
) -> Result<Option<ModelConfig>, String> {
    log_info!("api_get_model_config called (native)");
    let pool = state.db_manager.pool();

    match SettingsRepository::get_model_config(pool).await {
        Ok(Some(config)) => {
            log_info!(
                "✅ Found model config in database: provider={}, model={}, whisperModel={}, ollamaEndpoint={:?}",
                &config.provider,
                &config.model,
                &config.whisper_model,
                &config.ollama_endpoint
            );
            match SettingsRepository::get_api_key(pool, &config.provider, keyring_store()).await {
                Ok(api_key) => {
                    log_info!("Successfully retrieved model config and API key.");
                    Ok(Some(ModelConfig {
                        provider: config.provider,
                        model: config.model,
                        whisper_model: config.whisper_model,
                        api_key,
                        ollama_endpoint: config.ollama_endpoint,
                    }))
                }
                Err(e) => {
                    log_error!(
                        "Failed to get API key for provider {}: {}",
                        &config.provider,
                        e
                    );
                    Err(e)
                }
            }
        }
        Ok(None) => {
            log_warn!("⚠️ No model config found in database - database may be empty or settings table not initialized");
            Ok(None)
        }
        Err(e) => {
            log_error!("❌ Failed to get model config from database: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_save_model_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    whisper_model: String,
    api_key: Option<String>,
    ollama_endpoint: Option<String>,
    _auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "💾 api_save_model_config called (native): provider='{}', model='{}', whisperModel='{}', ollamaEndpoint={:?}",
        &provider,
        &model,
        &whisper_model,
        &ollama_endpoint
    );
    let pool = state.db_manager.pool();

    if let Err(e) = SettingsRepository::save_model_config(
        pool,
        &provider,
        &model,
        &whisper_model,
        ollama_endpoint.as_deref(),
    )
    .await
    {
        log_error!("❌ Failed to save model config to database: {}", e);
        return Err(e.to_string());
    }

    // Skip API key saving for custom-openai provider (it uses customOpenAIConfig JSON instead)
    if let Some(key) = api_key {
        if !key.is_empty() && provider != "custom-openai" {
            log_info!("API key provided, saving...");
            if let Err(e) =
                SettingsRepository::save_api_key(pool, &provider, &key, keyring_store()).await
            {
                log_error!("Failed to save API key: {}", e);
                return Err(e);
            }
            // A new key may expose a different model list; drop the cached one.
            clear_provider_model_cache(&provider);
        }
    }

    // Trigger graceful shutdown of built-in AI sidecar if it's running
    // This ensures that if the user switched models/providers, the old one is cleaned up
    // The shutdown happens in the background, so it won't block the UI
    if let Err(e) = crate::summary::summary_engine::client::shutdown_sidecar_gracefully().await {
        log_warn!("Failed to initiate graceful sidecar shutdown: {}", e);
    }

    log_info!("✅ Successfully saved model configuration to database");
    Ok(
        serde_json::json!({ "status": "success", "message": "Model configuration saved successfully" }).into(),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn api_get_api_key<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    _auth_token: Option<String>,
) -> Result<String, String> {
    log_info!(
        "api_get_api_key called (native) for provider '{}'",
        &provider
    );
    match SettingsRepository::get_api_key(&state.db_manager.pool(), &provider, keyring_store())
        .await
    {
        Ok(key) => {
            log_info!(
                "Successfully retrieved API key for provider '{}'.",
                &provider
            );
            Ok(key.unwrap_or_default())
        }
        Err(e) => {
            log_error!("Failed to get API key for provider '{}': {}", &provider, e);
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_get_transcript_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    _auth_token: Option<String>,
) -> Result<Option<TranscriptConfig>, String> {
    log_info!("api_get_transcript_config called (native)");
    let pool = state.db_manager.pool();

    match SettingsRepository::get_transcript_config(pool).await {
        Ok(Some(config)) => {
            log_info!(
                "Found transcript config: provider={}, model={}",
                &config.provider,
                &config.model
            );
            match SettingsRepository::get_transcript_api_key(
                pool,
                &config.provider,
                keyring_store(),
            )
            .await
            {
                Ok(api_key) => {
                    log_info!("Successfully retrieved transcript config and API key.");
                    Ok(Some(TranscriptConfig {
                        provider: config.provider,
                        model: config.model,
                        api_key,
                    }))
                }
                Err(e) => {
                    log_error!(
                        "Failed to get transcript API key for provider {}: {}",
                        &config.provider,
                        e
                    );
                    Err(e)
                }
            }
        }
        Ok(None) => {
            log_info!("No transcript config found, returning default.");
            Ok(Some(TranscriptConfig {
                provider: "localWhisper".to_string(),
                model: crate::config::recommended_whisper_model(
                    crate::audio::HardwareProfile::detect(),
                )
                .to_string(),
                api_key: None,
            }))
        }
        Err(e) => {
            log_error!("Failed to get transcript config: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_save_transcript_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    model: String,
    api_key: Option<String>,
    _auth_token: Option<String>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_save_transcript_config called (native) for provider '{}'",
        &provider
    );
    let pool = state.db_manager.pool();

    if let Err(e) = SettingsRepository::save_transcript_config(pool, &provider, &model).await {
        log_error!("Failed to save transcript config: {}", e);
        return Err(e.to_string());
    }

    if let Some(key) = api_key {
        if !key.is_empty() {
            log_info!("API key provided, saving for transcript provider...");
            if let Err(e) =
                SettingsRepository::save_transcript_api_key(pool, &provider, &key, keyring_store())
                    .await
            {
                log_error!("Failed to save transcript API key: {}", e);
                return Err(e);
            }
        }
    }

    log_info!("Successfully saved transcript configuration.");
    Ok(
        serde_json::json!({ "status": "success", "message": "Transcript configuration saved successfully" }).into(),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn api_get_transcript_api_key<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    _auth_token: Option<String>,
) -> Result<String, String> {
    log_info!(
        "api_get_transcript_api_key called (native) for provider '{}'",
        &provider
    );
    match SettingsRepository::get_transcript_api_key(
        &state.db_manager.pool(),
        &provider,
        keyring_store(),
    )
    .await
    {
        Ok(key) => {
            log_info!(
                "Successfully retrieved transcript API key for provider '{}'.",
                &provider
            );
            Ok(key.unwrap_or_default())
        }
        Err(e) => {
            log_error!(
                "Failed to get transcript API key for provider '{}': {}",
                &provider,
                e
            );
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn api_delete_api_key<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    _auth_token: Option<String>,
) -> Result<(), String> {
    log_info!(
        "log_api_delete_api_key called (native) for provider '{}'",
        &provider
    );
    match SettingsRepository::delete_api_key(&state.db_manager.pool(), &provider, keyring_store())
        .await
    {
        Ok(_) => {
            log_info!("Successfully deleted API key for provider '{}'.", &provider);
            // Drop the cached model list so it falls back / re-fetches without the key.
            clear_provider_model_cache(&provider);
            Ok(())
        }
        Err(e) => {
            log_error!(
                "Failed to delete API key for provider '{}': {}",
                &provider,
                e
            );
            Err(e)
        }
    }
}

/// Saves the custom OpenAI configuration
/// This configuration is stored as JSON and includes endpoint, apiKey, model, and optional parameters
#[tauri::command]
#[specta::specta]
pub async fn api_save_custom_openai_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    endpoint: String,
    api_key: Option<String>,
    model: String,
    max_tokens: Option<i32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_save_custom_openai_config called: endpoint='{}', model='{}'",
        &endpoint,
        &model
    );

    // Validate required fields
    if endpoint.trim().is_empty() {
        return Err("Endpoint URL is required".to_string());
    }
    if model.trim().is_empty() {
        return Err("Model name is required".to_string());
    }

    // Validate endpoint URL format
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        return Err("Endpoint must start with http:// or https://".to_string());
    }

    // Validate optional numeric parameters
    if let Some(temp) = temperature {
        if !(0.0..=2.0).contains(&temp) {
            return Err("Temperature must be between 0.0 and 2.0".to_string());
        }
    }
    if let Some(top) = top_p {
        if !(0.0..=1.0).contains(&top) {
            return Err("Top P must be between 0.0 and 1.0".to_string());
        }
    }
    if let Some(tokens) = max_tokens {
        if tokens < 1 {
            return Err("Max tokens must be at least 1".to_string());
        }
    }

    let config = CustomOpenAIConfig {
        endpoint: endpoint.trim().to_string(),
        api_key: api_key.filter(|k| !k.trim().is_empty()),
        model: model.trim().to_string(),
        max_tokens,
        temperature,
        top_p,
    };

    let pool = state.db_manager.pool();

    match SettingsRepository::save_custom_openai_config(pool, &config, keyring_store()).await {
        Ok(()) => {
            log_info!(
                "✅ Successfully saved custom OpenAI config for endpoint: {}",
                config.endpoint
            );
            Ok(serde_json::json!({
                "status": "success",
                "message": "Custom OpenAI configuration saved successfully"
            })
            .into())
        }
        Err(e) => {
            log_error!("❌ Failed to save custom OpenAI config: {}", e);
            Err(format!("Failed to save custom OpenAI configuration: {}", e))
        }
    }
}

/// Gets the custom OpenAI configuration
#[tauri::command]
#[specta::specta]
pub async fn api_get_custom_openai_config<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CustomOpenAIConfig>, String> {
    log_info!("api_get_custom_openai_config called");

    let pool = state.db_manager.pool();

    match SettingsRepository::get_custom_openai_config(pool, keyring_store()).await {
        Ok(config) => {
            if let Some(ref c) = config {
                log_info!(
                    "✅ Found custom OpenAI config: endpoint='{}', model='{}'",
                    c.endpoint,
                    c.model
                );
            } else {
                log_info!("No custom OpenAI config found");
            }
            Ok(config)
        }
        Err(e) => {
            log_error!("❌ Failed to get custom OpenAI config: {}", e);
            Err(format!("Failed to get custom OpenAI configuration: {}", e))
        }
    }
}

/// Tests the connection to a custom OpenAI-compatible endpoint
/// Makes a minimal request to verify the endpoint is reachable and responds correctly
#[tauri::command]
#[specta::specta]
pub async fn api_test_custom_openai_connection<R: Runtime>(
    _app: AppHandle<R>,
    endpoint: String,
    api_key: Option<String>,
    model: String,
) -> Result<crate::json::Json, String> {
    log_info!(
        "api_test_custom_openai_connection called: endpoint='{}', model='{}'",
        &endpoint,
        &model
    );

    // Validate endpoint URL format
    if !endpoint.starts_with("http://") && !endpoint.starts_with("https://") {
        return Err("Endpoint must start with http:// or https://".to_string());
    }

    // Build the URL - append /chat/completions to the base endpoint
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    // Create a minimal test request
    let test_request = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": "Hi"
            }
        ],
        "max_tokens": 5
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&test_request);

    // Add authorization if API key provided
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = request.header("Authorization", format!("Bearer {}", key));
    }

    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let response_text = response.text().await.unwrap_or_default();

            if status.is_success() {
                // Parse response as JSON to verify it's a valid OpenAI-compatible response
                match serde_json::from_str::<serde_json::Value>(&response_text) {
                    Ok(json) => {
                        // Verify the response has the expected OpenAI structure
                        if let Some(choices) = json.get("choices") {
                            if let Some(choices_array) = choices.as_array() {
                                if !choices_array.is_empty() {
                                    // Verify the first choice has the required message structure
                                    if let Some(first_choice) = choices_array.get(0) {
                                        // Check if message.content field exists (can be empty string)
                                        let has_message_structure = first_choice
                                            .get("message")
                                            .and_then(|m| {
                                                m.get("content")
                                                    .or_else(|| m.get("reasoning_content"))
                                            })
                                            .is_some();

                                        if has_message_structure {
                                            log_info!("✅ Custom OpenAI connection test successful - response validated");
                                            return Ok(serde_json::json!({
                                                "status": "success",
                                                "message": "Connection successful and response validated",
                                                "http_status": status.as_u16()
                                            }).into());
                                        }
                                    }
                                }
                            }
                        }

                        // Response was 200 but doesn't match OpenAI format
                        log_warn!(
                            "⚠️ Endpoint returned 200 but response doesn't match OpenAI format: {}",
                            response_text
                        );
                        Err("Endpoint is reachable but doesn't appear to be OpenAI-compatible. Response is missing 'choices' array or 'message.content' / 'message.reasoning_content' field.".to_string())
                    }
                    Err(e) => {
                        log_warn!(
                            "⚠️ Endpoint returned 200 but response is not valid JSON: {}",
                            e
                        );
                        Err(format!(
                            "Endpoint is reachable but returned invalid JSON: {}. Response: {}",
                            e, response_text
                        ))
                    }
                }
            } else {
                log_warn!(
                    "⚠️ Custom OpenAI connection test failed with status {}: {}",
                    status,
                    response_text
                );
                Err(format!(
                    "Connection failed with status {}: {}",
                    status, response_text
                ))
            }
        }
        Err(e) => {
            log_error!("❌ Custom OpenAI connection test failed: {}", e);
            if e.is_timeout() {
                Err("Connection timed out. Please check the endpoint URL.".to_string())
            } else if e.is_connect() {
                Err("Could not connect to endpoint. Please verify the URL is correct and the server is running.".to_string())
            } else {
                Err(format!("Connection failed: {}", e))
            }
        }
    }
}

/// Whether transcript cleanup runs before summarization (default off).
#[tauri::command]
#[specta::specta]
pub async fn get_transcript_cleanup_enabled(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_transcript_cleanup_enabled(state.db_manager.pool())
        .await
        .map_err(|e| format!("read transcript cleanup setting: {e}"))
}

/// Enable or disable pre-summary transcript cleanup.
#[tauri::command]
#[specta::specta]
pub async fn set_transcript_cleanup_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_transcript_cleanup_enabled(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| format!("save transcript cleanup setting: {e}"))
}

/// Whether the post-meeting quality pass (batch re-transcription) is enabled.
#[tauri::command]
#[specta::specta]
pub async fn get_post_meeting_quality_pass_enabled(
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    SettingsRepository::get_post_meeting_quality_pass(state.db_manager.pool())
        .await
        .map_err(|e| format!("read quality pass setting: {e}"))
}

/// Enable or disable the post-meeting quality pass.
#[tauri::command]
#[specta::specta]
pub async fn set_post_meeting_quality_pass_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    SettingsRepository::set_post_meeting_quality_pass(state.db_manager.pool(), enabled)
        .await
        .map_err(|e| format!("save quality pass setting: {e}"))
}
