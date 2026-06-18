use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tracing::info;

const REQUEST_TIMEOUT_DURATION: Duration = Duration::from_secs(300);

// Generic structure for OpenAI-compatible API chat messages
#[derive(Debug, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// Generic structure for OpenAI-compatible API chat requests
#[derive(Debug, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
}

// Generic structure for OpenAI-compatible API chat responses
#[derive(Deserialize, Debug)]
pub struct ChatResponse {
    pub choices: Vec<Choice>,
}

#[derive(Deserialize, Debug)]
pub struct Choice {
    pub message: MessageContent,
}

#[derive(Deserialize, Debug)]
pub struct MessageContent {
    pub content: String,
}

// Claude-specific request structure
#[derive(Debug, Serialize)]
pub struct ClaudeRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: String,
    pub messages: Vec<ChatMessage>,
}

// Claude-specific response structure
#[derive(Deserialize, Debug)]
pub struct ClaudeChatResponse {
    pub content: Vec<ClaudeChatContent>,
}

#[derive(Deserialize, Debug)]
pub struct ClaudeChatContent {
    pub text: String,
}

/// LLM Provider enumeration for multi-provider support
#[derive(Debug, Clone, PartialEq)]
pub enum LLMProvider {
    OpenAI,
    Claude,
    Groq,
    Grok,
    Ollama,
    OpenRouter,
    BuiltInAI,
    CustomOpenAI,
}

impl LLMProvider {
    /// Parse provider from string (case-insensitive)
    pub fn from_str(s: &str) -> Result<Self, String> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(Self::OpenAI),
            "claude" => Ok(Self::Claude),
            "groq" => Ok(Self::Groq),
            "grok" | "xai" => Ok(Self::Grok),
            "ollama" => Ok(Self::Ollama),
            "openrouter" => Ok(Self::OpenRouter),
            "builtin-ai" | "local-llama" | "localllama" => Ok(Self::BuiltInAI),
            "custom-openai" => Ok(Self::CustomOpenAI),
            _ => Err(format!("Unsupported LLM provider: {}", s)),
        }
    }
}

/// Generates a summary using the specified LLM provider
///
/// # Arguments
/// * `client` - Reqwest HTTP client (reused for performance)
/// * `provider` - The LLM provider to use
/// * `model_name` - The specific model to use (e.g., "gpt-4", "claude-3-opus")
/// * `api_key` - API key for the provider (not needed for Ollama)
/// * `system_prompt` - System instructions for the LLM
/// * `user_prompt` - User query/content to process
/// * `ollama_endpoint` - Optional custom Ollama endpoint (defaults to localhost:11434)
/// * `custom_openai_endpoint` - Optional custom OpenAI-compatible endpoint
/// * `max_tokens` - Optional max tokens (for CustomOpenAI provider)
/// * `temperature` - Optional temperature (for CustomOpenAI provider)
/// * `top_p` - Optional top_p (for CustomOpenAI provider)
/// * `app_data_dir` - Optional app data directory (for BuiltInAI provider)
/// * `cancellation_token` - Optional token to cancel the request
///
/// # Returns
/// The generated summary text or an error message
pub async fn generate_summary(
    client: &Client,
    provider: &LLMProvider,
    model_name: &str,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    app_data_dir: Option<&PathBuf>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String, String> {
    // Check if cancelled before starting
    if let Some(token) = cancellation_token {
        if token.is_cancelled() {
            return Err("Summary generation was cancelled".to_string());
        }
    }

    // Handle BuiltInAI provider separately (uses local sidecar, no HTTP API)
    if provider == &LLMProvider::BuiltInAI {
        let app_data_dir = app_data_dir
            .ok_or_else(|| "app_data_dir is required for BuiltInAI provider".to_string())?;

        return crate::summary::summary_engine::generate_with_builtin(
            app_data_dir,
            model_name,
            system_prompt,
            user_prompt,
            cancellation_token,
        )
        .await
        .map_err(|e| e.to_string());
    }

    let (api_url, headers) = build_request_target(
        provider,
        api_key,
        ollama_endpoint,
        custom_openai_endpoint,
    )?;

    // Build request body based on provider. Sampling params are forwarded for all
    // OpenAI-compatible providers (omitted when None); Claude always needs max_tokens.
    let request_body = if provider != &LLMProvider::Claude {
        build_openai_compatible_body(model_name, system_prompt, user_prompt, max_tokens, temperature, top_p)
    } else {
        build_claude_body(model_name, system_prompt, user_prompt, max_tokens)
    };

    info!("🐞 LLM Request to {}: model={}", provider_name(provider), model_name);

    let mut attempt: u32 = 0;
    let response = loop {
        let send = client
            .post(&api_url)
            .headers(headers.clone())
            .json(&request_body)
            .timeout(REQUEST_TIMEOUT_DURATION)
            .send();

        // Race the request against cancellation when a token is present.
        let result = if let Some(token) = cancellation_token {
            tokio::select! {
                r = send => r,
                _ = token.cancelled() => return Err("Summary generation was cancelled".to_string()),
            }
        } else {
            send.await
        };

        match result {
            Ok(resp) if resp.status().is_success() => break resp,
            Ok(resp) => {
                let status = resp.status();
                if is_retryable_status(status) && attempt + 1 < MAX_SEND_ATTEMPTS {
                    let wait = parse_retry_after(resp.headers())
                        .unwrap_or_else(|| backoff_base(attempt))
                        .min(RETRY_MAX_DELAY);
                    // jitter: up to +250ms so concurrent clients don't sync up
                    let jitter = Duration::from_millis(rand::random::<u64>() % 250);
                    let wait = wait + jitter;
                    log::warn!(
                        "{} returned {}; retrying in {:?} (attempt {}/{})",
                        provider_name(provider), status, wait, attempt + 1, MAX_SEND_ATTEMPTS
                    );
                    let body = resp.text().await.unwrap_or_default();
                    log::debug!("{} retryable error body: {}", provider_name(provider), body);
                    // Cancellation-aware sleep.
                    if let Some(token) = cancellation_token {
                        tokio::select! {
                            _ = tokio::time::sleep(wait) => {}
                            _ = token.cancelled() => return Err("Summary generation was cancelled".to_string()),
                        }
                    } else {
                        tokio::time::sleep(wait).await;
                    }
                    attempt += 1;
                    continue;
                }
                // Non-retryable, or out of attempts: normalize and return.
                let body = resp.text().await.unwrap_or_default();
                log::debug!("{} error {} body: {}", provider_name(provider), status, body);
                return Err(classify_http_error(provider, model_name, status));
            }
            Err(e) => {
                // Retry connect errors only; timeouts are ambiguous (server may be generating).
                if e.is_connect() && attempt + 1 < MAX_SEND_ATTEMPTS {
                    let wait = backoff_base(attempt) + Duration::from_millis(rand::random::<u64>() % 250);
                    log::warn!("{} connect error; retrying in {:?}", provider_name(provider), wait);
                    if let Some(token) = cancellation_token {
                        tokio::select! {
                            _ = tokio::time::sleep(wait) => {}
                            _ = token.cancelled() => return Err("Summary generation was cancelled".to_string()),
                        }
                    } else {
                        tokio::time::sleep(wait).await;
                    }
                    attempt += 1;
                    continue;
                }
                return Err(map_send_error(&e));
            }
        }
    };

    // Parse response based on provider
    if provider == &LLMProvider::Claude {
        let chat_response = response
            .json::<ClaudeChatResponse>()
            .await
            .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

        info!("🐞 LLM Response received from Claude");

        let content = chat_response
            .content
            .get(0)
            .ok_or("No content in LLM response")?
            .text
            .trim();
        Ok(content.to_string())
    } else {
        let chat_response = response
            .json::<ChatResponse>()
            .await
            .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

        info!("🐞 LLM Response received from {}", provider_name(provider));

        let content = chat_response
            .choices
            .get(0)
            .ok_or("No content in LLM response")?
            .message
            .content
            .trim();
        Ok(content.to_string())
    }
}

/// Build the (endpoint URL, headers) for a provider request. BuiltInAI is handled
/// by an early return before this is ever called; passing it is a programmer error.
fn build_request_target(
    provider: &LLMProvider,
    api_key: &str,
    ollama_endpoint: Option<&str>,
    custom_openai_endpoint: Option<&str>,
) -> Result<(String, header::HeaderMap), String> {
    let mut headers = header::HeaderMap::new();

    let url = match provider {
        LLMProvider::OpenAI => "https://api.openai.com/v1/chat/completions".to_string(),
        LLMProvider::Groq => "https://api.groq.com/openai/v1/chat/completions".to_string(),
        LLMProvider::Grok => "https://api.x.ai/v1/chat/completions".to_string(),
        LLMProvider::OpenRouter => "https://openrouter.ai/api/v1/chat/completions".to_string(),
        LLMProvider::Ollama => {
            let host = ollama_endpoint.unwrap_or("http://localhost:11434");
            format!("{}/v1/chat/completions", host.trim_end_matches('/'))
        }
        LLMProvider::CustomOpenAI => {
            let endpoint = custom_openai_endpoint
                .ok_or_else(|| "Custom OpenAI endpoint not configured".to_string())?;
            format!("{}/chat/completions", endpoint.trim_end_matches('/'))
        }
        LLMProvider::Claude => {
            headers.insert(
                "x-api-key",
                api_key.parse().map_err(|_| "Invalid API key format".to_string())?,
            );
            headers.insert(
                "anthropic-version",
                "2023-06-01".parse().map_err(|_| "Invalid anthropic version".to_string())?,
            );
            "https://api.anthropic.com/v1/messages".to_string()
        }
        LLMProvider::BuiltInAI => return Err("BuiltInAI does not use an HTTP target".to_string()),
    };

    // OpenAI-compatible providers authenticate with a Bearer token.
    if provider != &LLMProvider::Claude {
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", api_key)
                .parse()
                .map_err(|_| "Invalid authorization header".to_string())?,
        );
    }
    headers.insert(
        header::CONTENT_TYPE,
        "application/json".parse().map_err(|_| "Invalid content type".to_string())?,
    );

    Ok((url, headers))
}

/// Helper function to get provider name for logging
fn provider_name(provider: &LLMProvider) -> &str {
    match provider {
        LLMProvider::OpenAI => "OpenAI",
        LLMProvider::Claude => "Claude",
        LLMProvider::Groq => "Groq",
        LLMProvider::Grok => "xAI Grok",
        LLMProvider::Ollama => "Ollama",
        LLMProvider::BuiltInAI => "Built-in AI",
        LLMProvider::OpenRouter => "OpenRouter",
        LLMProvider::CustomOpenAI => "Custom OpenAI",
    }
}

/// Map a transport-level send error to a user-facing message (timeout, connect, other).
fn map_send_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("LLM request timed out after {} seconds", REQUEST_TIMEOUT_DURATION.as_secs())
    } else if e.is_connect() {
        format!("Could not reach the {} endpoint.", "LLM provider")
    } else {
        format!("Failed to send request to the LLM provider: {e}")
    }
}

/// Map a non-success HTTP status to a normalized, actionable message. The raw
/// response body is logged at debug by the caller and never surfaced to the UI.
fn classify_http_error(provider: &LLMProvider, model_name: &str, status: reqwest::StatusCode) -> String {
    let name = provider_name(provider);
    let code = status.as_u16();
    match code {
        401 | 403 => format!("{name} rejected the request: authentication failed. Check the API key. [{code}]"),
        404 => format!("{name}: model '{model_name}' not found or not accessible. [{code}]"),
        429 => format!("{name} rate limit reached. Wait a moment and try again. [429]"),
        500..=599 => format!("{name} had a server error ({code}). Try again shortly."),
        _ => format!("{name} request failed ({code})."),
    }
}

/// Max total send attempts (1 initial + retries).
const MAX_SEND_ATTEMPTS: u32 = 3;
/// Base backoff before the exponential factor.
const RETRY_BASE_DELAY: Duration = Duration::from_millis(500);
/// Cap on a single backoff wait.
const RETRY_MAX_DELAY: Duration = Duration::from_secs(20);

/// Retry only on transient statuses: 429 and 5xx. Never on 4xx (except 429).
fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    let code = status.as_u16();
    code == 429 || (500..=599).contains(&code)
}

/// Exponential backoff (no jitter) for a 0-based attempt index, capped.
fn backoff_base(attempt: u32) -> Duration {
    let factor = 2u32.saturating_pow(attempt);
    RETRY_BASE_DELAY.saturating_mul(factor).min(RETRY_MAX_DELAY)
}

/// Parse a `Retry-After` header value in seconds (the only form these APIs use).
fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// Build the OpenAI-compatible chat request body. `max_tokens`/`temperature`/`top_p`
/// are forwarded when present and omitted when `None` (via `skip_serializing_if`).
fn build_openai_compatible_body(
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
) -> serde_json::Value {
    serde_json::json!(ChatRequest {
        model: model_name.to_string(),
        messages: vec![
            ChatMessage { role: "system".to_string(), content: system_prompt.to_string() },
            ChatMessage { role: "user".to_string(), content: user_prompt.to_string() },
        ],
        max_tokens,
        temperature,
        top_p,
    })
}

/// Claude requires `max_tokens`; default to a value matching the local summary default
/// (4096) rather than the previous hard-coded 2048 which truncated long summaries.
const DEFAULT_CLAUDE_MAX_TOKENS: u32 = 4096;

fn build_claude_body(
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: Option<u32>,
) -> serde_json::Value {
    serde_json::json!(ClaudeRequest {
        system: system_prompt.to_string(),
        model: model_name.to_string(),
        max_tokens: max_tokens.unwrap_or(DEFAULT_CLAUDE_MAX_TOKENS),
        messages: vec![ChatMessage { role: "user".to_string(), content: user_prompt.to_string() }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_body_omits_unset_params() {
        let body = build_openai_compatible_body("gpt-4o", "sys", "usr", None, None, None);
        let obj = body.as_object().unwrap();
        assert_eq!(obj.get("model").unwrap(), "gpt-4o");
        assert!(obj.get("max_tokens").is_none());
        assert!(obj.get("temperature").is_none());
        assert!(obj.get("top_p").is_none());
    }

    #[test]
    fn openai_body_forwards_set_params() {
        let body = build_openai_compatible_body("gpt-4o", "sys", "usr", Some(32), Some(0.5), Some(0.8));
        let obj = body.as_object().unwrap();
        assert_eq!(obj.get("max_tokens").unwrap(), 32);
        // f32 values serialise to JSON with limited precision; compare as f64 with epsilon.
        let temp = obj.get("temperature").unwrap().as_f64().unwrap();
        let top_p = obj.get("top_p").unwrap().as_f64().unwrap();
        assert!((temp - 0.5_f64).abs() < 1e-6, "temperature {temp} not close to 0.5");
        assert!((top_p - 0.8_f64).abs() < 1e-6, "top_p {top_p} not close to 0.8");
    }

    #[test]
    fn claude_body_defaults_max_tokens_to_4096() {
        let body = build_claude_body("claude-sonnet-4-5-20250929", "sys", "usr", None);
        assert_eq!(body.as_object().unwrap().get("max_tokens").unwrap(), 4096);
    }

    #[test]
    fn claude_body_honors_explicit_max_tokens() {
        let body = build_claude_body("claude-sonnet-4-5-20250929", "sys", "usr", Some(32));
        assert_eq!(body.as_object().unwrap().get("max_tokens").unwrap(), 32);
    }

    #[test]
    fn classify_http_error_messages() {
        use reqwest::StatusCode;
        let p = LLMProvider::OpenAI;
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::UNAUTHORIZED).contains("authentication failed"));
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::NOT_FOUND).contains("not found"));
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::TOO_MANY_REQUESTS).contains("rate limit"));
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::INTERNAL_SERVER_ERROR).contains("server error"));
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::IM_A_TEAPOT).contains("request failed"));
    }

    #[test]
    fn classify_http_error_never_includes_raw_body() {
        use reqwest::StatusCode;
        let msg = classify_http_error(&LLMProvider::Claude, "claude-x", StatusCode::BAD_REQUEST);
        assert!(!msg.contains("{"), "error message must not embed raw JSON body");
    }

    #[test]
    fn retryable_statuses() {
        use reqwest::StatusCode;
        assert!(is_retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable_status(StatusCode::BAD_GATEWAY));
        assert!(is_retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_retryable_status(StatusCode::UNAUTHORIZED));
        assert!(!is_retryable_status(StatusCode::NOT_FOUND));
        assert!(!is_retryable_status(StatusCode::OK));
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff_base(0), RETRY_BASE_DELAY);
        assert!(backoff_base(1) > backoff_base(0));
        assert!(backoff_base(20) <= RETRY_MAX_DELAY);
    }

    #[test]
    fn parse_retry_after_reads_seconds() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(reqwest::header::RETRY_AFTER, "7".parse().unwrap());
        assert_eq!(parse_retry_after(&h), Some(std::time::Duration::from_secs(7)));
        assert_eq!(parse_retry_after(&reqwest::header::HeaderMap::new()), None);
    }

    #[test]
    fn target_urls_per_provider() {
        let key = "sk-test";
        assert_eq!(build_request_target(&LLMProvider::OpenAI, key, None, None).unwrap().0, "https://api.openai.com/v1/chat/completions");
        assert_eq!(build_request_target(&LLMProvider::Groq, key, None, None).unwrap().0, "https://api.groq.com/openai/v1/chat/completions");
        assert_eq!(build_request_target(&LLMProvider::OpenRouter, key, None, None).unwrap().0, "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(build_request_target(&LLMProvider::Claude, key, None, None).unwrap().0, "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn ollama_uses_default_or_custom_host() {
        assert_eq!(build_request_target(&LLMProvider::Ollama, "", None, None).unwrap().0, "http://localhost:11434/v1/chat/completions");
        assert_eq!(build_request_target(&LLMProvider::Ollama, "", Some("http://box:9999/"), None).unwrap().0, "http://box:9999/v1/chat/completions");
    }

    #[test]
    fn custom_openai_requires_endpoint_and_trims_slash() {
        assert!(build_request_target(&LLMProvider::CustomOpenAI, "", None, None).is_err());
        assert_eq!(build_request_target(&LLMProvider::CustomOpenAI, "k", None, Some("http://x/v1/")).unwrap().0, "http://x/v1/chat/completions");
    }

    #[test]
    fn auth_headers_per_provider() {
        let (_, h) = build_request_target(&LLMProvider::OpenAI, "sk-test", None, None).unwrap();
        assert_eq!(h.get(header::AUTHORIZATION).unwrap(), "Bearer sk-test");
        assert!(h.get("x-api-key").is_none());

        let (_, h) = build_request_target(&LLMProvider::Claude, "sk-test", None, None).unwrap();
        assert_eq!(h.get("x-api-key").unwrap(), "sk-test");
        assert_eq!(h.get("anthropic-version").unwrap(), "2023-06-01");
        assert!(h.get(header::AUTHORIZATION).is_none());
    }
}
