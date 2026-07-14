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

    /// Classify where a summary request's data egresses for this provider.
    ///
    /// Privacy-critical: this is the single source of truth for the calendar
    /// meeting-context PII gate. Default-deny — any provider not provably local
    /// is treated as `Remote`. `Ollama`/`CustomOpenAI` are `Local` only when
    /// their resolved endpoint host is loopback; a remote-host Ollama or vLLM is
    /// `Remote`.
    pub fn data_egress(
        &self,
        ollama_endpoint: Option<&str>,
        custom_openai_endpoint: Option<&str>,
    ) -> Egress {
        match self {
            Self::BuiltInAI => Egress::Local,
            Self::OpenAI | Self::Claude | Self::Groq | Self::Grok | Self::OpenRouter => {
                Egress::Remote
            }
            // Ollama defaults to localhost when no endpoint is configured.
            Self::Ollama => endpoint_egress(ollama_endpoint, true),
            // CustomOpenAI has no default host, so an absent endpoint is remote.
            Self::CustomOpenAI => endpoint_egress(custom_openai_endpoint, false),
        }
    }
}

/// Where a provider's request data actually goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    /// Stays on this device (loopback endpoint or in-process model).
    Local,
    /// Leaves the device to a remote host.
    Remote,
}

/// Classify an endpoint string by host. `default_when_absent_local` decides the
/// result when the endpoint is missing/empty (Ollama assumes localhost; others
/// fall to `Remote` under default-deny).
fn endpoint_egress(endpoint: Option<&str>, default_when_absent_local: bool) -> Egress {
    let absent = || {
        if default_when_absent_local {
            Egress::Local
        } else {
            Egress::Remote
        }
    };
    match endpoint.map(str::trim) {
        None => absent(),
        Some("") => absent(),
        Some(ep) => match host_of(ep) {
            Some(host) if is_loopback_host(&host) => Egress::Local,
            _ => Egress::Remote,
        },
    }
}

/// Extract the lowercased host portion of a URL or `host:port` authority.
fn host_of(endpoint: &str) -> Option<String> {
    // Strip scheme (http://, https://, etc.).
    let without_scheme = endpoint
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(endpoint);
    // Authority ends at the first path/query/fragment separator.
    let authority = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme);
    // Drop any userinfo (user:pass@host).
    let authority = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    if authority.is_empty() {
        return None;
    }
    // IPv6 literal in brackets: [::1] or [::1]:port.
    if let Some(rest) = authority.strip_prefix('[') {
        let host = rest.split(']').next().unwrap_or(rest);
        return (!host.is_empty()).then(|| host.to_lowercase());
    }
    // host or host:port.
    let host = authority.split(':').next().unwrap_or(authority);
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// Whether a host refers to the local machine (loopback). Covers `localhost`,
/// the IPv4 `127.0.0.0/8` block, and IPv6 `::1`.
fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "::1"
        || host == "0:0:0:0:0:0:0:1"
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
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

    let (api_url, headers) =
        build_request_target(provider, api_key, ollama_endpoint, custom_openai_endpoint)?;

    // Build request body based on provider. Sampling params are forwarded for all
    // OpenAI-compatible providers (omitted when None); Claude always needs max_tokens.
    let request_body = if provider != &LLMProvider::Claude {
        build_openai_compatible_body(
            model_name,
            system_prompt,
            user_prompt,
            max_tokens,
            temperature,
            top_p,
        )
    } else {
        build_claude_body(model_name, system_prompt, user_prompt, max_tokens)
    };

    info!(
        "🐞 LLM Request to {}: model={}",
        provider_name(provider),
        model_name
    );

    let response = send_with_retry(
        client,
        provider,
        model_name,
        &api_url,
        &headers,
        &request_body,
        cancellation_token,
        true,
    )
    .await?;

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

/// Sends the request with retry/backoff (retryable statuses and connect errors
/// only — never after response bytes have been received) and returns the
/// successful response. When `bound_body` is true the whole body read is
/// covered by [`REQUEST_TIMEOUT_DURATION`] (buffered path); when false only the
/// connect/headers wait is bounded, so a streaming body may run arbitrarily
/// long (the stream reader enforces its own per-chunk timeout).
#[allow(clippy::too_many_arguments)]
async fn send_with_retry(
    client: &Client,
    provider: &LLMProvider,
    model_name: &str,
    api_url: &str,
    headers: &header::HeaderMap,
    request_body: &serde_json::Value,
    cancellation_token: Option<&CancellationToken>,
    bound_body: bool,
) -> Result<reqwest::Response, String> {
    let mut attempt: u32 = 0;
    loop {
        let mut request = client
            .post(api_url)
            .headers(headers.clone())
            .json(request_body);
        if bound_body {
            request = request.timeout(REQUEST_TIMEOUT_DURATION);
        }
        let send = async {
            if bound_body {
                Ok(request.send().await)
            } else {
                // Bound the headers wait ourselves; the body stays unbounded.
                tokio::time::timeout(REQUEST_TIMEOUT_DURATION, request.send())
                    .await
                    .map_err(|_| {
                        format!(
                            "LLM request timed out after {} seconds",
                            REQUEST_TIMEOUT_DURATION.as_secs()
                        )
                    })
            }
        };

        // Race the request against cancellation when a token is present.
        let result = if let Some(token) = cancellation_token {
            tokio::select! {
                r = send => r?,
                _ = token.cancelled() => return Err("Summary generation was cancelled".to_string()),
            }
        } else {
            send.await?
        };

        match result {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
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
                        provider_name(provider),
                        status,
                        wait,
                        attempt + 1,
                        MAX_SEND_ATTEMPTS
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
                log::debug!(
                    "{} error {} body: {}",
                    provider_name(provider),
                    status,
                    body
                );
                return Err(classify_http_error(provider, model_name, status));
            }
            Err(e) => {
                // Retry connect errors only; timeouts are ambiguous (server may be generating).
                if e.is_connect() && attempt + 1 < MAX_SEND_ATTEMPTS {
                    let wait =
                        backoff_base(attempt) + Duration::from_millis(rand::random::<u64>() % 250);
                    log::warn!(
                        "{} connect error; retrying in {:?}",
                        provider_name(provider),
                        wait
                    );
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
    }
}

/// Max silence between streaming chunks before the stream counts as stalled.
/// Resets on every chunk, so answer length is unbounded; only a stall trips it.
const SSE_INTER_CHUNK_TIMEOUT: Duration = Duration::from_secs(120);

/// Outcome of one parsed SSE line.
#[derive(Debug, PartialEq)]
enum SseDelta {
    /// New content to append.
    Text(String),
    /// The stream finished cleanly.
    Done,
    /// The provider reported an error frame mid-stream (logged, not surfaced).
    Error,
    /// Housekeeping (event names, comments, keep-alives, role/usage deltas).
    Ignore,
}

/// Drains complete `\n`-terminated lines out of the SSE byte buffer, leaving a
/// partial trailing line — possibly mid-UTF-8-character — for the next chunk.
fn drain_sse_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let raw: Vec<u8> = buf.drain(..=pos).collect();
        lines.push(
            String::from_utf8_lossy(&raw)
                .trim_end_matches(['\r', '\n'])
                .to_string(),
        );
    }
    lines
}

/// Parses one OpenAI-compatible SSE line (`data: {"choices":[{"delta":...}]}`,
/// terminated by `data: [DONE]`). Used by every provider except Claude.
fn parse_openai_sse_line(line: &str) -> SseDelta {
    let Some(data) = line.strip_prefix("data:") else {
        return SseDelta::Ignore;
    };
    let data = data.trim();
    if data == "[DONE]" {
        return SseDelta::Done;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return SseDelta::Ignore;
    };
    // Some OpenAI-compatible servers include `"error": null` on normal frames;
    // only a non-null error object is an actual error.
    if value.get("error").is_some_and(|e| !e.is_null()) {
        log::debug!("OpenAI-compatible stream error frame: {}", data);
        return SseDelta::Error;
    }
    match value["choices"][0]["delta"]["content"].as_str() {
        Some(text) if !text.is_empty() => SseDelta::Text(text.to_string()),
        _ => SseDelta::Ignore,
    }
}

/// Parses one Claude Messages-API SSE line (`content_block_delta` text deltas,
/// terminated by `message_stop`).
fn parse_claude_sse_line(line: &str) -> SseDelta {
    let Some(data) = line.strip_prefix("data:") else {
        return SseDelta::Ignore;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
        return SseDelta::Ignore;
    };
    match value["type"].as_str() {
        Some("content_block_delta") => match value["delta"]["text"].as_str() {
            Some(text) if !text.is_empty() => SseDelta::Text(text.to_string()),
            _ => SseDelta::Ignore,
        },
        Some("message_stop") => SseDelta::Done,
        Some("error") => {
            log::debug!("Claude stream error frame received");
            SseDelta::Error
        }
        _ => SseDelta::Ignore,
    }
}

/// Streaming sibling of [`generate_summary`] for HTTP providers: sets
/// `stream: true`, invokes `on_token` with each content delta as it arrives,
/// and returns the full accumulated text. Retries happen only before any bytes
/// are received (same policy as the buffered path). BuiltInAI is not handled
/// here — callers stream it through the sidecar directly.
#[allow(clippy::too_many_arguments)]
pub async fn generate_summary_streaming(
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
    cancellation_token: Option<&CancellationToken>,
    mut on_token: impl FnMut(String),
) -> Result<String, String> {
    use futures_util::StreamExt;

    if provider == &LLMProvider::BuiltInAI {
        return Err("BuiltInAI streams via the local sidecar, not HTTP".to_string());
    }
    if let Some(token) = cancellation_token {
        if token.is_cancelled() {
            return Err("Summary generation was cancelled".to_string());
        }
    }

    let (api_url, headers) =
        build_request_target(provider, api_key, ollama_endpoint, custom_openai_endpoint)?;

    let mut request_body = if provider != &LLMProvider::Claude {
        build_openai_compatible_body(
            model_name,
            system_prompt,
            user_prompt,
            max_tokens,
            temperature,
            top_p,
        )
    } else {
        build_claude_body(model_name, system_prompt, user_prompt, max_tokens)
    };
    request_body["stream"] = serde_json::Value::Bool(true);

    info!(
        "🐞 LLM streaming request to {}: model={}",
        provider_name(provider),
        model_name
    );

    let response = send_with_retry(
        client,
        provider,
        model_name,
        &api_url,
        &headers,
        &request_body,
        cancellation_token,
        false,
    )
    .await?;

    let parse_line: fn(&str) -> SseDelta = if provider == &LLMProvider::Claude {
        parse_claude_sse_line
    } else {
        parse_openai_sse_line
    };

    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut full = String::new();

    'outer: loop {
        let next = tokio::time::timeout(SSE_INTER_CHUNK_TIMEOUT, stream.next());
        let chunk = if let Some(token) = cancellation_token {
            tokio::select! {
                c = next => c,
                _ = token.cancelled() => return Err("Summary generation was cancelled".to_string()),
            }
        } else {
            next.await
        };

        let chunk = match chunk {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(e))) => {
                // Mid-stream transport failure: partial text is already on
                // screen; surface a normalized error (no body leakage).
                log::warn!("{} stream error: {}", provider_name(provider), e);
                return Err(map_send_error(&e));
            }
            // Server closed the stream: treat as end-of-answer (OpenAI ends
            // with [DONE] first; some compatible servers just close).
            Ok(None) => break 'outer,
            Err(_) => {
                return Err(format!(
                    "{} stream stalled (no data for {}s).",
                    provider_name(provider),
                    SSE_INTER_CHUNK_TIMEOUT.as_secs()
                ));
            }
        };

        buf.extend_from_slice(&chunk);
        for line in drain_sse_lines(&mut buf) {
            match parse_line(&line) {
                SseDelta::Text(text) => {
                    full.push_str(&text);
                    on_token(text);
                }
                SseDelta::Done => break 'outer,
                SseDelta::Error => {
                    return Err(format!(
                        "{} reported an error while streaming the response.",
                        provider_name(provider)
                    ));
                }
                SseDelta::Ignore => {}
            }
        }
    }

    if full.trim().is_empty() {
        return Err(format!(
            "{} returned an empty streaming response.",
            provider_name(provider)
        ));
    }

    info!(
        "🐞 LLM streaming response completed from {}",
        provider_name(provider)
    );
    Ok(full)
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
                api_key
                    .parse()
                    .map_err(|_| "Invalid API key format".to_string())?,
            );
            headers.insert(
                "anthropic-version",
                "2023-06-01"
                    .parse()
                    .map_err(|_| "Invalid anthropic version".to_string())?,
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
        "application/json"
            .parse()
            .map_err(|_| "Invalid content type".to_string())?,
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
        format!(
            "LLM request timed out after {} seconds",
            REQUEST_TIMEOUT_DURATION.as_secs()
        )
    } else if e.is_connect() {
        format!("Could not reach the {} endpoint.", "LLM provider")
    } else {
        format!("Failed to send request to the LLM provider: {e}")
    }
}

/// Map a non-success HTTP status to a normalized, actionable message. The raw
/// response body is logged at debug by the caller and never surfaced to the UI.
fn classify_http_error(
    provider: &LLMProvider,
    model_name: &str,
    status: reqwest::StatusCode,
) -> String {
    let name = provider_name(provider);
    let code = status.as_u16();
    match code {
        401 | 403 => format!(
            "{name} rejected the request: authentication failed. Check the API key. [{code}]"
        ),
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
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string()
            },
            ChatMessage {
                role: "user".to_string(),
                content: user_prompt.to_string()
            },
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
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: user_prompt.to_string()
        }],
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
        let body =
            build_openai_compatible_body("gpt-4o", "sys", "usr", Some(32), Some(0.5), Some(0.8));
        let obj = body.as_object().unwrap();
        assert_eq!(obj.get("max_tokens").unwrap(), 32);
        // f32 values serialise to JSON with limited precision; compare as f64 with epsilon.
        let temp = obj.get("temperature").unwrap().as_f64().unwrap();
        let top_p = obj.get("top_p").unwrap().as_f64().unwrap();
        assert!(
            (temp - 0.5_f64).abs() < 1e-6,
            "temperature {temp} not close to 0.5"
        );
        assert!(
            (top_p - 0.8_f64).abs() < 1e-6,
            "top_p {top_p} not close to 0.8"
        );
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
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::UNAUTHORIZED)
            .contains("authentication failed"));
        assert!(classify_http_error(&p, "gpt-4o", StatusCode::NOT_FOUND).contains("not found"));
        assert!(
            classify_http_error(&p, "gpt-4o", StatusCode::TOO_MANY_REQUESTS).contains("rate limit")
        );
        assert!(
            classify_http_error(&p, "gpt-4o", StatusCode::INTERNAL_SERVER_ERROR)
                .contains("server error")
        );
        assert!(
            classify_http_error(&p, "gpt-4o", StatusCode::IM_A_TEAPOT).contains("request failed")
        );
    }

    #[test]
    fn classify_http_error_never_includes_raw_body() {
        use reqwest::StatusCode;
        let msg = classify_http_error(&LLMProvider::Claude, "claude-x", StatusCode::BAD_REQUEST);
        assert!(
            !msg.contains("{"),
            "error message must not embed raw JSON body"
        );
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
        assert_eq!(
            parse_retry_after(&h),
            Some(std::time::Duration::from_secs(7))
        );
        assert_eq!(parse_retry_after(&reqwest::header::HeaderMap::new()), None);
    }

    #[test]
    fn target_urls_per_provider() {
        let key = "sk-test";
        assert_eq!(
            build_request_target(&LLMProvider::OpenAI, key, None, None)
                .unwrap()
                .0,
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            build_request_target(&LLMProvider::Groq, key, None, None)
                .unwrap()
                .0,
            "https://api.groq.com/openai/v1/chat/completions"
        );
        assert_eq!(
            build_request_target(&LLMProvider::OpenRouter, key, None, None)
                .unwrap()
                .0,
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            build_request_target(&LLMProvider::Claude, key, None, None)
                .unwrap()
                .0,
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn ollama_uses_default_or_custom_host() {
        assert_eq!(
            build_request_target(&LLMProvider::Ollama, "", None, None)
                .unwrap()
                .0,
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_request_target(&LLMProvider::Ollama, "", Some("http://box:9999/"), None)
                .unwrap()
                .0,
            "http://box:9999/v1/chat/completions"
        );
    }

    #[test]
    fn custom_openai_requires_endpoint_and_trims_slash() {
        assert!(build_request_target(&LLMProvider::CustomOpenAI, "", None, None).is_err());
        assert_eq!(
            build_request_target(&LLMProvider::CustomOpenAI, "k", None, Some("http://x/v1/"))
                .unwrap()
                .0,
            "http://x/v1/chat/completions"
        );
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

    // ===== Egress classifier (calendar PII gate source of truth) =====

    #[test]
    fn cloud_providers_are_remote() {
        for p in [
            LLMProvider::OpenAI,
            LLMProvider::Claude,
            LLMProvider::Groq,
            LLMProvider::Grok,
            LLMProvider::OpenRouter,
        ] {
            assert_eq!(p.data_egress(None, None), Egress::Remote, "{:?}", p);
        }
    }

    #[test]
    fn builtin_ai_is_local() {
        assert_eq!(
            LLMProvider::BuiltInAI.data_egress(None, None),
            Egress::Local
        );
    }

    #[test]
    fn ollama_defaults_to_local_but_remote_host_is_remote() {
        // Absent endpoint → Ollama assumes localhost.
        assert_eq!(LLMProvider::Ollama.data_egress(None, None), Egress::Local);
        for ep in [
            "http://localhost:11434",
            "http://127.0.0.1:11434",
            "127.0.0.1:11434",
            "http://[::1]:11434",
        ] {
            assert_eq!(
                LLMProvider::Ollama.data_egress(Some(ep), None),
                Egress::Local,
                "{ep}"
            );
        }
        for ep in [
            "http://192.168.1.5:11434",
            "https://ollama.example.com",
            "http://10.0.0.2:11434",
            "http://0.0.0.0:11434",
        ] {
            assert_eq!(
                LLMProvider::Ollama.data_egress(Some(ep), None),
                Egress::Remote,
                "{ep}"
            );
        }
    }

    #[test]
    fn custom_openai_absent_endpoint_is_remote_by_default_deny() {
        assert_eq!(
            LLMProvider::CustomOpenAI.data_egress(None, None),
            Egress::Remote
        );
        assert_eq!(
            LLMProvider::CustomOpenAI.data_egress(None, Some("")),
            Egress::Remote
        );
        assert_eq!(
            LLMProvider::CustomOpenAI.data_egress(None, Some("http://localhost:8000/v1")),
            Egress::Local
        );
        assert_eq!(
            LLMProvider::CustomOpenAI.data_egress(None, Some("https://api.openai.com/v1")),
            Egress::Remote
        );
    }

    #[test]
    fn host_of_handles_schemes_ports_userinfo_and_ipv6() {
        assert_eq!(
            host_of("http://localhost:11434").as_deref(),
            Some("localhost")
        );
        assert_eq!(
            host_of("https://API.OpenAI.com/v1").as_deref(),
            Some("api.openai.com")
        );
        assert_eq!(
            host_of("user:pass@127.0.0.1:8000").as_deref(),
            Some("127.0.0.1")
        );
        assert_eq!(host_of("http://[::1]:11434/v1").as_deref(), Some("::1"));
        assert_eq!(host_of("127.0.0.1").as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn sse_buffer_drains_complete_lines_and_keeps_partials() {
        let mut buf: Vec<u8> = b"data: a\r\ndata: b\ndata: par".to_vec();
        let lines = drain_sse_lines(&mut buf);
        assert_eq!(lines, vec!["data: a", "data: b"]);
        assert_eq!(buf, b"data: par");
        // A multi-byte char split across chunks survives reassembly.
        buf.extend_from_slice("é".as_bytes()[..1].as_ref());
        assert!(drain_sse_lines(&mut buf).is_empty());
        buf.extend_from_slice("é".as_bytes()[1..].as_ref());
        buf.push(b'\n');
        assert_eq!(drain_sse_lines(&mut buf), vec!["data: paré"]);
    }

    #[test]
    fn openai_sse_line_parses_delta_done_and_error() {
        assert_eq!(
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#),
            SseDelta::Text("Hi".to_string())
        );
        assert_eq!(parse_openai_sse_line("data: [DONE]"), SseDelta::Done);
        assert_eq!(
            parse_openai_sse_line(r#"data: {"error":{"message":"secret detail"}}"#),
            SseDelta::Error
        );
        // `"error": null` on a normal frame is NOT an error (seen on some
        // OpenAI-compatible servers).
        assert_eq!(
            parse_openai_sse_line(r#"data: {"error":null,"choices":[{"delta":{"content":"x"}}]}"#),
            SseDelta::Text("x".to_string())
        );
        // Role-only first delta, comments, and blank lines are housekeeping.
        assert_eq!(
            parse_openai_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#),
            SseDelta::Ignore
        );
        assert_eq!(parse_openai_sse_line(": keep-alive"), SseDelta::Ignore);
        assert_eq!(parse_openai_sse_line(""), SseDelta::Ignore);
    }

    #[tokio::test]
    async fn streaming_end_to_end_against_a_fake_sse_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // One-shot fake OpenAI-compatible SSE server. Writes are deliberately
        // split mid-line to exercise chunk-boundary reassembly.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut req = vec![0u8; 4096];
            let _ = socket.read(&mut req).await.unwrap();
            let body_str = String::from_utf8_lossy(&req);
            assert!(body_str.contains("\"stream\":true"), "stream flag missing");

            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n")
                .await
                .unwrap();
            socket
                .write_all(br#"data: {"choices":[{"delta":{"content":"Hel"#)
                .await
                .unwrap();
            socket.flush().await.unwrap();
            socket
                .write_all(b"\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\ndata: [DONE]\n\n")
                .await
                .unwrap();
            socket.flush().await.unwrap();
        });

        let client = Client::new();
        let endpoint = format!("http://{}", addr);
        let mut tokens: Vec<String> = Vec::new();
        let full = generate_summary_streaming(
            &client,
            &LLMProvider::CustomOpenAI,
            "test-model",
            "test-key",
            "system",
            "user",
            None,
            Some(&endpoint),
            None,
            None,
            None,
            None,
            |t| tokens.push(t),
        )
        .await
        .unwrap();

        assert_eq!(full, "Hello");
        assert_eq!(tokens, vec!["Hel".to_string(), "lo".to_string()]);
        server.await.unwrap();
    }

    #[test]
    fn claude_sse_line_parses_delta_stop_and_error() {
        assert_eq!(
            parse_claude_sse_line(
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#
            ),
            SseDelta::Text("Hi".to_string())
        );
        assert_eq!(
            parse_claude_sse_line(r#"data: {"type":"message_stop"}"#),
            SseDelta::Done
        );
        assert_eq!(
            parse_claude_sse_line(r#"data: {"type":"error","error":{"message":"secret"}}"#),
            SseDelta::Error
        );
        // Event-name lines and other frame types are housekeeping.
        assert_eq!(
            parse_claude_sse_line("event: content_block_delta"),
            SseDelta::Ignore
        );
        assert_eq!(
            parse_claude_sse_line(r#"data: {"type":"message_start","message":{}}"#),
            SseDelta::Ignore
        );
    }
}
