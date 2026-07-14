//! Shared helpers for the cloud LLM model-listing commands (anthropic, openai,
//! groq, openrouter).
//!
//! Each provider keeps its own response/UI types, auth headers, and filtering
//! rules — those genuinely differ. This module centralizes the parts that were
//! previously copy-pasted into every provider: a process-wide HTTP client
//! (so the connection pool and TLS config are reused instead of rebuilt per
//! request) and a TTL'd in-memory cache of the fetched model list.

use serde::de::DeserializeOwned;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

/// How long a fetched model list stays fresh before a re-fetch.
pub const CACHE_TTL: Duration = Duration::from_secs(300);

/// Timeout applied to model-listing HTTP requests.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Process-wide shared reqwest client. `reqwest::Client` is internally
/// reference-counted, so cloning the handle is cheap and shares the pool.
static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// Returns a handle to the shared HTTP client (cheap clone, shared pool).
pub fn http_client() -> reqwest::Client {
    HTTP_CLIENT.clone()
}

/// A TTL'd cache of a single provider's model list.
///
/// Construct as a `static` with [`ModelCache::new`]; read with [`get`](Self::get),
/// populate with [`store`](Self::store), and invalidate (e.g. on API-key change)
/// with [`clear`](Self::clear).
pub struct ModelCache<T> {
    inner: RwLock<Option<(Vec<T>, Instant)>>,
}

impl<T: Clone> ModelCache<T> {
    pub const fn new() -> Self {
        Self {
            inner: RwLock::new(None),
        }
    }

    /// Returns the cached models if present and not yet expired.
    pub fn get(&self) -> Option<Vec<T>> {
        let guard = self.inner.read().ok()?;
        let (models, fetched_at) = guard.as_ref()?;
        if fetched_at.elapsed() < CACHE_TTL {
            Some(models.clone())
        } else {
            None
        }
    }

    /// Stores a freshly fetched model list, stamping it with the current time.
    pub fn store(&self, models: Vec<T>) {
        if let Ok(mut guard) = self.inner.write() {
            *guard = Some((models, Instant::now()));
        }
    }

    /// Clears the cache so the next request re-fetches.
    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.write() {
            *guard = None;
        }
    }
}

/// The common `{ "data": [...] }` envelope used by the OpenAI-compatible
/// model-listing endpoints (OpenAI, Groq) and Anthropic.
#[derive(serde::Deserialize)]
struct ApiModelList<T> {
    data: Vec<T>,
}

/// A cloud provider whose model list is fetched from a `{ "data": [...] }`
/// endpoint with a 5-minute cache and a hardcoded fallback list.
///
/// This captures the shape shared by Anthropic / OpenAI / Groq. OpenRouter is
/// intentionally NOT a `ModelProvider`: its endpoint is unauthenticated, has no
/// fallback, and must fetch even without a key — it would not fit the
/// "no key → fallback" contract below.
pub trait ModelProvider {
    /// UI-facing model type returned to the frontend.
    type UiModel: Clone + Send + Sync + 'static;
    /// Raw model type parsed from each element of the `data` array.
    type ApiModel: DeserializeOwned;

    /// Human-readable provider name, used only in log lines.
    const NAME: &'static str;
    /// The models endpoint URL.
    const ENDPOINT: &'static str;

    /// The provider's process-wide model cache.
    fn cache() -> &'static ModelCache<Self::UiModel>;
    /// Auth headers to attach to the request (name, value pairs).
    fn auth_headers(api_key: &str) -> Vec<(&'static str, String)>;
    /// Hardcoded models returned when the API is unavailable or returns nothing.
    fn fallback_models() -> Vec<Self::UiModel>;
    /// Map a raw API model to a UI model; return `None` to filter it out
    /// (e.g. non-chat models like embeddings/tts).
    fn map_model(api: Self::ApiModel) -> Option<Self::UiModel>;
}

/// Fetch a provider's chat models: returns cached models if fresh, otherwise
/// queries the API, filters/maps via [`ModelProvider::map_model`], caches, and
/// returns. Any failure (no key, network error, bad status, parse error, empty
/// result) falls back to [`ModelProvider::fallback_models`].
pub async fn fetch_models<P: ModelProvider>(
    api_key: Option<String>,
) -> Result<Vec<P::UiModel>, String> {
    let api_key = match api_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => {
            log::info!("No {} API key provided, returning fallback models", P::NAME);
            return Ok(P::fallback_models());
        }
    };

    if let Some(models) = P::cache().get() {
        log::info!(
            "Returning cached {} models ({} models)",
            P::NAME,
            models.len()
        );
        return Ok(models);
    }

    log::info!("Fetching {} models from API...", P::NAME);
    let mut request = http_client().get(P::ENDPOINT).timeout(REQUEST_TIMEOUT);
    for (name, value) in P::auth_headers(&api_key) {
        request = request.header(name, value);
    }

    let response = match request.send().await {
        Ok(resp) => resp,
        Err(e) => {
            log::warn!("Failed to fetch {} models: {}. Using fallback.", P::NAME, e);
            return Ok(P::fallback_models());
        }
    };

    if !response.status().is_success() {
        log::warn!(
            "{} API returned status {}. Using fallback models.",
            P::NAME,
            response.status()
        );
        return Ok(P::fallback_models());
    }

    let parsed: ApiModelList<P::ApiModel> = match response.json().await {
        Ok(data) => data,
        Err(e) => {
            log::warn!(
                "Failed to parse {} response: {}. Using fallback.",
                P::NAME,
                e
            );
            return Ok(P::fallback_models());
        }
    };

    let models: Vec<P::UiModel> = parsed.data.into_iter().filter_map(P::map_model).collect();

    if models.is_empty() {
        log::warn!(
            "No chat models returned from {} API. Using fallback.",
            P::NAME
        );
        return Ok(P::fallback_models());
    }

    log::info!("Fetched {} {} models from API", models.len(), P::NAME);
    P::cache().store(models.clone());
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_cache_returns_none() {
        let cache: ModelCache<String> = ModelCache::new();
        assert!(cache.get().is_none());
    }

    #[test]
    fn store_then_get_returns_models() {
        let cache: ModelCache<String> = ModelCache::new();
        cache.store(vec!["a".to_string(), "b".to_string()]);
        let got = cache.get().expect("fresh cache should return models");
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn clear_invalidates_cache() {
        let cache: ModelCache<String> = ModelCache::new();
        cache.store(vec!["x".to_string()]);
        assert!(cache.get().is_some());
        cache.clear();
        assert!(cache.get().is_none(), "cleared cache should miss");
    }

    #[test]
    fn store_overwrites_previous() {
        let cache: ModelCache<u32> = ModelCache::new();
        cache.store(vec![1, 2, 3]);
        cache.store(vec![9]);
        assert_eq!(cache.get().unwrap(), vec![9]);
    }

    #[test]
    fn shared_client_is_cloneable() {
        // Construction must not panic and handles are independent clones.
        let _a = http_client();
        let _b = http_client();
    }
}
