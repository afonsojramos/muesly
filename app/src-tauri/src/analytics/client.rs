use chrono::{DateTime, Utc};
use posthog_rs::{Client, Event};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticsConfig {
    pub api_key: String,
    pub host: Option<String>,
    pub enabled: bool,
}

impl Default for AnalyticsConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            host: Some("https://eu.i.posthog.com".to_string()),
            enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSession {
    pub session_id: String,
    pub user_id: String,
    pub start_time: DateTime<Utc>,
    pub is_active: bool,
}

impl UserSession {
    pub fn new(user_id: String) -> Self {
        let now = Utc::now();
        Self {
            session_id: format!("session_{}", Uuid::new_v4()),
            user_id,
            start_time: now,
            is_active: true,
        }
    }

    pub fn duration_seconds(&self) -> i64 {
        (Utc::now() - self.start_time).num_seconds()
    }
}

/// Property keys that must never reach analytics, per PRIVACY_POLICY.md and the
/// in-app AnalyticsDataModal. Defense in depth: even if a call site supplies one,
/// it is stripped here before the event is sent. Matched case-insensitively.
const SENSITIVE_PROPERTY_KEYS: &[&str] = &[
    "device_name",
    "meeting_title",
    "meeting_name",
    "user_agent",
    "file_name",
    "file_path",
];

fn strip_sensitive_properties(
    mut properties: std::collections::HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    properties.retain(|key, _| {
        !SENSITIVE_PROPERTY_KEYS
            .iter()
            .any(|sensitive| key.eq_ignore_ascii_case(sensitive))
    });
    properties
}

/// A single stack frame in an exception report. Mirrors the subset of PostHog's
/// frame schema we populate. `filename`/`function` are code locations, not user
/// data; the potentially-sensitive part (the message) is redacted separately.
#[derive(Debug, Clone, Default, Deserialize, Serialize, specta::Type)]
pub struct ExceptionFrame {
    pub filename: Option<String>,
    pub function: Option<String>,
    pub lineno: Option<u32>,
    pub colno: Option<u32>,
}

/// Redact an exception message before it leaves the device: cap its length, then
/// strip emails and filesystem paths. Mirrors the frontend `sanitizeErrorMessage`
/// so Rust-origin panics get the same treatment as forwarded frontend errors.
fn redact_exception_text(text: &str) -> String {
    const MAX_LEN: usize = 1000;
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            (
                Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap(),
                "<email>",
            ),
            (Regex::new(r#"[A-Za-z]:\\[^\s'"]*"#).unwrap(), "<path>"), // Windows
            (Regex::new(r#"~[/\\][^\s'"]*"#).unwrap(), "<path>"),      // home-relative
            (Regex::new(r"/[^\s/]+(?:/[^\s/]*)+").unwrap(), "<path>"), // POSIX absolute
        ]
    });
    let capped: String = text.chars().take(MAX_LEN).collect();
    patterns.iter().fold(capped, |acc, (re, repl)| {
        re.replace_all(&acc, *repl).into_owned()
    })
}

/// Build the PostHog `$exception_list` value from a redacted type/message and
/// optional stack frames. Matches the shape PostHog's ingestion expects
/// (`type`, `value`, `mechanism`, optional `stacktrace.frames`).
fn build_exception_list(
    exception_type: &str,
    value: &str,
    frames: &[ExceptionFrame],
    handled: bool,
) -> serde_json::Value {
    let mut item = serde_json::Map::new();
    item.insert("type".to_string(), json!(exception_type));
    item.insert("value".to_string(), json!(value));
    item.insert(
        "mechanism".to_string(),
        json!({ "type": "generic", "handled": handled, "synthetic": false }),
    );
    if !frames.is_empty() {
        // PostHog renders frames innermost-last; callers pass outermost-first
        // (both JS and the panic location), so reverse into PostHog's order.
        let frames_json: Vec<serde_json::Value> = frames
            .iter()
            .rev()
            .map(|f| {
                json!({
                    "filename": f.filename,
                    "function": f.function.clone().unwrap_or_else(|| "<unknown>".to_string()),
                    "lineno": f.lineno,
                    "colno": f.colno,
                    "in_app": true,
                    "synthetic": false,
                })
            })
            .collect();
        item.insert(
            "stacktrace".to_string(),
            json!({ "type": "raw", "frames": frames_json }),
        );
    }
    json!([serde_json::Value::Object(item)])
}

pub struct AnalyticsClient {
    client: Option<Arc<Client>>,
    config: AnalyticsConfig,
    user_id: Arc<Mutex<Option<String>>>,
    current_session: Arc<Mutex<Option<UserSession>>>,
}

impl AnalyticsClient {
    pub async fn new(config: AnalyticsConfig) -> Self {
        let client = if config.enabled && !config.api_key.is_empty() {
            // Pass the configured host so EU / self-hosted projects reach the
            // correct ingestion endpoint. Without this the client defaults to the
            // US endpoint and silently drops every event for a non-US project.
            let client = match config.host.as_deref() {
                Some(host) => posthog_rs::client((config.api_key.as_str(), host)).await,
                None => posthog_rs::client(config.api_key.as_str()).await,
            };
            Some(Arc::new(client))
        } else {
            None
        };

        Self {
            client,
            config,
            user_id: Arc::new(Mutex::new(None)),
            current_session: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn identify(
        &self,
        user_id: String,
        properties: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        let client = match &self.client {
            Some(client) => Arc::clone(client),
            None => return Ok(()),
        };

        // Store user ID for future events
        *self.user_id.lock().await = Some(user_id.clone());

        let properties = strip_sensitive_properties(properties.unwrap_or_default());

        let mut event = Event::new("$identify", &user_id);

        // Add user properties
        for (key, value) in properties {
            if let Err(e) = event.insert_prop(&key, value) {
                eprintln!("Failed to add property {}: {}", key, e);
            }
        }

        client.capture(event);

        Ok(())
    }

    pub async fn track_event(
        &self,
        event_name: &str,
        properties: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        let client = match &self.client {
            Some(client) => Arc::clone(client),
            None => return Ok(()),
        };

        let user_id = match self.user_id.lock().await.clone() {
            Some(id) => id,
            None => {
                // Don't create anonymous users, wait for proper identification
                log::warn!(
                    "Attempted to track event '{}' before user identification",
                    event_name
                );
                return Ok(());
            }
        };

        let event_name = event_name.to_string();
        let mut properties = strip_sensitive_properties(properties.unwrap_or_default());

        // Add app version to all events
        properties.insert(
            "app_version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        );

        // Add session information to all events
        if let Some(session) = self.current_session.lock().await.as_ref() {
            properties.insert("session_id".to_string(), session.session_id.clone());
            properties.insert(
                "session_duration".to_string(),
                session.duration_seconds().to_string(),
            );
        }

        let mut event = Event::new(&event_name, &user_id);

        // Add event properties
        for (key, value) in properties {
            if let Err(e) = event.insert_prop(&key, value) {
                log::warn!("Failed to add property {}: {}", key, e);
            }
        }

        client.capture(event);

        Ok(())
    }

    // Enhanced user tracking methods
    pub async fn start_session(&self, user_id: String) -> Result<String, String> {
        let session = UserSession::new(user_id.clone());
        let session_id = session.session_id.clone();

        *self.current_session.lock().await = Some(session);

        let mut properties = HashMap::new();
        properties.insert("session_id".to_string(), session_id.clone());
        properties.insert("timestamp".to_string(), Utc::now().to_rfc3339());

        self.track_event("session_started", Some(properties))
            .await?;

        Ok(session_id)
    }

    pub async fn end_session(&self) -> Result<(), String> {
        let mut session_guard = self.current_session.lock().await;

        if let Some(session) = session_guard.take() {
            let mut properties = HashMap::new();
            properties.insert("session_id".to_string(), session.session_id.clone());
            properties.insert(
                "session_duration".to_string(),
                session.duration_seconds().to_string(),
            );
            properties.insert("timestamp".to_string(), Utc::now().to_rfc3339());

            self.track_event("session_ended", Some(properties)).await?;
        }

        Ok(())
    }

    pub async fn track_daily_active_user(&self) -> Result<(), String> {
        let user_id = match self.user_id.lock().await.clone() {
            Some(id) => id,
            None => {
                log::warn!("Attempted to track daily active user before user identification");
                return Ok(());
            }
        };

        let mut properties = HashMap::new();
        properties.insert("user_id".to_string(), user_id);
        properties.insert(
            "date".to_string(),
            Utc::now().format("%Y-%m-%d").to_string(),
        );
        properties.insert("timestamp".to_string(), Utc::now().to_rfc3339());

        self.track_event("daily_active_user", Some(properties))
            .await
    }

    pub async fn track_user_first_launch(&self) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("timestamp".to_string(), Utc::now().to_rfc3339());
        properties.insert(
            "app_version".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        );

        self.track_event("user_first_launch", Some(properties))
            .await
    }

    pub async fn get_current_session(&self) -> Option<UserSession> {
        self.current_session.lock().await.clone()
    }

    pub async fn is_session_active(&self) -> bool {
        self.current_session.lock().await.is_some()
    }

    pub async fn track_meeting_deleted(&self, meeting_id: &str) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("meeting_id".to_string(), meeting_id.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("meeting_deleted", Some(properties)).await
    }

    pub async fn track_settings_changed(
        &self,
        setting_type: &str,
        new_value: &str,
    ) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("setting_type".to_string(), setting_type.to_string());
        properties.insert("new_value".to_string(), new_value.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("settings_changed", Some(properties)).await
    }

    pub async fn track_app_started(&self, version: &str) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("app_version".to_string(), version.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("app_started", Some(properties)).await
    }

    pub async fn track_feature_used(&self, feature_name: &str) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("feature_name".to_string(), feature_name.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("feature_used", Some(properties)).await
    }

    // Summary generation analytics
    pub async fn track_summary_generation_completed(
        &self,
        model_provider: &str,
        model_name: &str,
        success: bool,
        duration_seconds: Option<u64>,
        error_message: Option<&str>,
    ) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("model_provider".to_string(), model_provider.to_string());
        properties.insert("model_name".to_string(), model_name.to_string());
        properties.insert("success".to_string(), success.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        if let Some(duration) = duration_seconds {
            properties.insert("duration_seconds".to_string(), duration.to_string());
        }

        if let Some(error) = error_message {
            properties.insert("error_message".to_string(), error.to_string());
        }

        self.track_event("summary_generation_completed", Some(properties))
            .await
    }

    pub async fn track_summary_regenerated(
        &self,
        model_provider: &str,
        model_name: &str,
    ) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("model_provider".to_string(), model_provider.to_string());
        properties.insert("model_name".to_string(), model_name.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("summary_regenerated", Some(properties))
            .await
    }

    pub async fn track_model_changed(
        &self,
        old_provider: &str,
        old_model: &str,
        new_provider: &str,
        new_model: &str,
    ) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("old_provider".to_string(), old_provider.to_string());
        properties.insert("old_model".to_string(), old_model.to_string());
        properties.insert("new_provider".to_string(), new_provider.to_string());
        properties.insert("new_model".to_string(), new_model.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("model_changed", Some(properties)).await
    }

    pub async fn track_custom_prompt_used(&self, prompt_length: usize) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("prompt_length".to_string(), prompt_length.to_string());
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("custom_prompt_used", Some(properties))
            .await
    }

    pub async fn track_meeting_ended(
        &self,
        transcription_provider: &str,
        transcription_model: &str,
        summary_provider: &str,
        summary_model: &str,
        total_duration_seconds: Option<f64>,
        active_duration_seconds: f64,
        pause_duration_seconds: f64,
        microphone_device_type: &str,
        system_audio_device_type: &str,
        chunks_processed: u64,
        transcript_segments_count: u64,
        had_fatal_error: bool,
    ) -> Result<(), String> {
        let mut properties = HashMap::new();

        // Model information
        properties.insert(
            "transcription_provider".to_string(),
            transcription_provider.to_string(),
        );
        properties.insert(
            "transcription_model".to_string(),
            transcription_model.to_string(),
        );
        properties.insert("summary_provider".to_string(), summary_provider.to_string());
        properties.insert("summary_model".to_string(), summary_model.to_string());

        // Duration metrics
        if let Some(duration) = total_duration_seconds {
            properties.insert("total_duration_seconds".to_string(), duration.to_string());
        }
        properties.insert(
            "active_duration_seconds".to_string(),
            active_duration_seconds.to_string(),
        );
        properties.insert(
            "pause_duration_seconds".to_string(),
            pause_duration_seconds.to_string(),
        );

        // Privacy-safe device types
        properties.insert(
            "microphone_device_type".to_string(),
            microphone_device_type.to_string(),
        );
        properties.insert(
            "system_audio_device_type".to_string(),
            system_audio_device_type.to_string(),
        );

        // Processing stats
        properties.insert("chunks_processed".to_string(), chunks_processed.to_string());
        properties.insert(
            "transcript_segments_count".to_string(),
            transcript_segments_count.to_string(),
        );
        properties.insert("had_fatal_error".to_string(), had_fatal_error.to_string());

        // Timestamp
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("meeting_ended", Some(properties)).await
    }

    // Analytics consent tracking
    pub async fn track_analytics_enabled(&self) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("analytics_enabled", Some(properties))
            .await
    }

    pub async fn track_analytics_disabled(&self) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("analytics_disabled", Some(properties))
            .await
    }

    pub async fn track_analytics_transparency_viewed(&self) -> Result<(), String> {
        let mut properties = HashMap::new();
        properties.insert("timestamp".to_string(), chrono::Utc::now().to_rfc3339());

        self.track_event("analytics_transparency_viewed", Some(properties))
            .await
    }

    pub fn is_enabled(&self) -> bool {
        self.config.enabled && self.client.is_some()
    }

    pub async fn set_user_properties(
        &self,
        properties: HashMap<String, String>,
    ) -> Result<(), String> {
        let client = match &self.client {
            Some(client) => Arc::clone(client),
            None => return Ok(()),
        };

        let user_id = match self.user_id.lock().await.clone() {
            Some(id) => id,
            None => {
                eprintln!("Warning: Attempted to set user properties before user identification");
                return Ok(());
            }
        };

        let properties = strip_sensitive_properties(properties);
        let mut event = Event::new("$set", &user_id);

        // Add user properties
        for (key, value) in properties {
            if let Err(e) = event.insert_prop(&key, value) {
                eprintln!("Failed to add property {}: {}", key, e);
            }
        }

        client.capture(event);

        Ok(())
    }

    /// Capture a frontend-forwarded exception as a PostHog `$exception` event.
    /// No-op when analytics is disabled. Uses the identified user when available,
    /// falling back to "unidentified" so an error is never silently dropped.
    pub async fn capture_exception(
        &self,
        exception_type: &str,
        message: &str,
        frames: Vec<ExceptionFrame>,
        handled: bool,
        source: &str,
    ) -> Result<(), String> {
        if self.client.is_none() {
            return Ok(());
        }
        let distinct_id = self
            .user_id
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| "unidentified".to_string());
        self.emit_exception(
            &distinct_id,
            exception_type,
            message,
            &frames,
            handled,
            source,
        );
        Ok(())
    }

    /// Synchronous capture for the Rust panic hook. Safe to call from any thread
    /// with no async runtime: `capture` only enqueues onto the background worker.
    pub fn capture_panic(&self, message: &str, frames: Vec<ExceptionFrame>) {
        if self.client.is_none() {
            return;
        }
        let distinct_id = self
            .user_id
            .try_lock()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_else(|| "unidentified".to_string());
        self.emit_exception(&distinct_id, "RustPanic", message, &frames, false, "rust");
    }

    /// Shared `$exception` event builder for both the async command path and the
    /// sync panic hook. The message is redacted (emails, paths, length) here.
    fn emit_exception(
        &self,
        distinct_id: &str,
        exception_type: &str,
        message: &str,
        frames: &[ExceptionFrame],
        handled: bool,
        source: &str,
    ) {
        let Some(client) = &self.client else {
            return;
        };
        let value = redact_exception_text(message);
        let exception_list = build_exception_list(exception_type, &value, frames, handled);

        let mut event = Event::new("$exception", distinct_id);
        let _ = event.insert_prop("$exception_list", exception_list);
        let _ = event.insert_prop("$exception_level", "error");
        let _ = event.insert_prop("source", source);
        let _ = event.insert_prop("app_version", env!("CARGO_PKG_VERSION"));
        client.capture(event);
    }
}

// Helper function to create analytics client from config
pub async fn create_analytics_client(config: AnalyticsConfig) -> AnalyticsClient {
    AnalyticsClient::new(config).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn props(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn strips_known_sensitive_keys() {
        let out = strip_sensitive_properties(props(&[
            ("device_name", "Afonso's AirPods"),
            ("meeting_title", "Q3 layoffs"),
            ("user_agent", "Mozilla/5.0 ..."),
        ]));
        assert!(
            out.is_empty(),
            "all sensitive keys must be removed, got {:?}",
            out
        );
    }

    #[test]
    fn keeps_safe_keys() {
        let out = strip_sensitive_properties(props(&[
            ("device_category", "bluetooth"),
            ("duration_seconds", "42"),
            ("meeting_id", "uuid-123"),
        ]));
        assert_eq!(out.len(), 3);
        assert_eq!(out.get("device_category"), Some(&"bluetooth".to_string()));
    }

    #[test]
    fn matching_is_case_insensitive() {
        let out = strip_sensitive_properties(props(&[
            ("Device_Name", "x"),
            ("USER_AGENT", "y"),
            ("safe", "z"),
        ]));
        assert_eq!(out.keys().collect::<Vec<_>>(), vec![&"safe".to_string()]);
    }

    #[test]
    fn empty_map_stays_empty() {
        assert!(strip_sensitive_properties(HashMap::new()).is_empty());
    }

    #[test]
    fn redact_strips_emails_and_paths() {
        let out = redact_exception_text(
            "failed for alice@example.com reading /Users/alice/secret.wav and C:\\Users\\bob\\x.db",
        );
        assert!(!out.contains('@'), "email leaked: {out}");
        assert!(!out.contains("secret.wav"), "posix path leaked: {out}");
        assert!(!out.contains("bob"), "windows path leaked: {out}");
        assert!(out.contains("<email>") && out.contains("<path>"));
    }

    #[test]
    fn redact_caps_length() {
        let long = "x".repeat(5000);
        assert_eq!(redact_exception_text(&long).chars().count(), 1000);
    }

    #[test]
    fn exception_list_has_type_value_and_mechanism() {
        let list = build_exception_list("TypeError", "boom", &[], true);
        let item = &list.as_array().unwrap()[0];
        assert_eq!(item["type"], "TypeError");
        assert_eq!(item["value"], "boom");
        assert_eq!(item["mechanism"]["handled"], true);
        // No frames -> no stacktrace key, but PostHog still groups on type+value.
        assert!(item.get("stacktrace").is_none());
    }

    #[test]
    fn exception_list_includes_frames_when_present() {
        let frames = vec![ExceptionFrame {
            filename: Some("engine.rs".to_string()),
            function: Some("collect_segments".to_string()),
            lineno: Some(572),
            colno: None,
        }];
        let list = build_exception_list("RustPanic", "unwrap on None", &frames, false);
        let item = &list.as_array().unwrap()[0];
        let frames_json = item["stacktrace"]["frames"].as_array().unwrap();
        assert_eq!(frames_json.len(), 1);
        assert_eq!(frames_json[0]["function"], "collect_segments");
        assert_eq!(frames_json[0]["lineno"], 572);
        assert_eq!(item["mechanism"]["handled"], false);
    }
}
