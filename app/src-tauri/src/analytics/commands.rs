use std::sync::Arc;
use std::collections::HashMap;
use serde::Deserialize;
use tauri::command;
use crate::analytics::{AnalyticsClient, AnalyticsConfig, ExceptionFrame};

// Global analytics client
static ANALYTICS_CLIENT: std::sync::Mutex<Option<Arc<AnalyticsClient>>> = std::sync::Mutex::new(None);

#[command]
#[specta::specta]
pub async fn init_analytics() -> Result<(), String> {
    // The PostHog ingest key is injected at build time via POSTHOG_API_KEY and is
    // intentionally NOT committed to source. When unset (e.g. local dev builds),
    // analytics stays disabled instead of shipping a hardcoded credential.
    let api_key = option_env!("POSTHOG_API_KEY");
    if api_key.is_none() {
        log::info!("POSTHOG_API_KEY not set at build time; analytics disabled");
    }

    let config = AnalyticsConfig {
        api_key: api_key.unwrap_or_default().to_string(),
        host: Some("https://us.i.posthog.com".to_string()),
        enabled: api_key.is_some(),
    };

    let client = Arc::new(AnalyticsClient::new(config).await);

    let mut guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some(client);

    Ok(())
}

#[command]
#[specta::specta]
pub async fn disable_analytics() -> Result<(), String> {
    let mut guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
    Ok(())
}

#[command]
#[specta::specta]
pub async fn track_event(event_name: String, properties: Option<HashMap<String, String>>) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_event(&event_name, properties).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn identify_user(user_id: String, properties: Option<HashMap<String, String>>) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.identify(user_id, properties).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_meeting_deleted(meeting_id: String) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_meeting_deleted(&meeting_id).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_settings_changed(setting_type: String, new_value: String) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_settings_changed(&setting_type, &new_value).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_feature_used(feature_name: String) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_feature_used(&feature_name).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn is_analytics_enabled() -> bool {
    let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map_or(false, |client| client.is_enabled())
}

// Enhanced analytics commands
#[command]
#[specta::specta]
pub async fn start_analytics_session(user_id: String) -> Result<String, String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.start_session(user_id).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn end_analytics_session() -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.end_session().await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_daily_active_user() -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_daily_active_user().await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_user_first_launch() -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_user_first_launch().await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

// Summary generation analytics commands
#[command]
#[specta::specta]
pub async fn track_summary_generation_completed(model_provider: String, model_name: String, success: bool, duration_seconds: Option<u64>, error_message: Option<String>) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_summary_generation_completed(&model_provider, &model_name, success, duration_seconds, error_message.as_deref()).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_summary_regenerated(model_provider: String, model_name: String) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_summary_regenerated(&model_provider, &model_name).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_model_changed(old_provider: String, old_model: String, new_provider: String, new_model: String) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };
    
    if let Some(client) = client {
        client.track_model_changed(&old_provider, &old_model, &new_provider, &new_model).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_custom_prompt_used(prompt_length: usize) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client.track_custom_prompt_used(prompt_length).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

/// Metrics for a completed meeting. Bundled into one argument because Specta
/// commands accept at most 10 parameters.
#[derive(Debug, Deserialize, specta::Type)]
pub struct MeetingEndedMetrics {
    pub transcription_provider: String,
    pub transcription_model: String,
    pub summary_provider: String,
    pub summary_model: String,
    pub total_duration_seconds: Option<f64>,
    pub active_duration_seconds: f64,
    pub pause_duration_seconds: f64,
    pub microphone_device_type: String,
    pub system_audio_device_type: String,
    pub chunks_processed: u64,
    pub transcript_segments_count: u64,
    pub had_fatal_error: bool,
}

#[command]
#[specta::specta]
pub async fn track_meeting_ended(metrics: MeetingEndedMetrics) -> Result<(), String> {
    let MeetingEndedMetrics {
        transcription_provider,
        transcription_model,
        summary_provider,
        summary_model,
        total_duration_seconds,
        active_duration_seconds,
        pause_duration_seconds,
        microphone_device_type,
        system_audio_device_type,
        chunks_processed,
        transcript_segments_count,
        had_fatal_error,
    } = metrics;
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client.track_meeting_ended(
            &transcription_provider,
            &transcription_model,
            &summary_provider,
            &summary_model,
            total_duration_seconds,
            active_duration_seconds,
            pause_duration_seconds,
            &microphone_device_type,
            &system_audio_device_type,
            chunks_processed,
            transcript_segments_count,
            had_fatal_error,
        ).await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

// Analytics consent tracking commands
#[command]
#[specta::specta]
pub async fn track_analytics_enabled() -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client.track_analytics_enabled().await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_analytics_disabled() -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client.track_analytics_disabled().await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn track_analytics_transparency_viewed() -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client.track_analytics_transparency_viewed().await
    } else {
        Err("Analytics client not initialized".to_string())
    }
}

#[command]
#[specta::specta]
pub async fn is_analytics_session_active() -> bool {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client.is_session_active().await
    } else {
        false
    }
}

/// An exception forwarded from the frontend (unhandled errors / promise
/// rejections). Bundled into one argument; the message is redacted Rust-side.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionReport {
    pub exception_type: String,
    pub message: String,
    #[serde(default)]
    pub frames: Vec<ExceptionFrame>,
    pub handled: bool,
    pub source: String,
}

#[command]
#[specta::specta]
pub async fn track_exception(report: ExceptionReport) -> Result<(), String> {
    let client = {
        let guard = ANALYTICS_CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().cloned()
    };

    if let Some(client) = client {
        client
            .capture_exception(
                &report.exception_type,
                &report.message,
                report.frames,
                report.handled,
                &report.source,
            )
            .await
    } else {
        // Analytics disabled: silently drop, never surface to the error handler.
        Ok(())
    }
}

/// Snapshot of the global analytics client for the Rust panic hook in `run()`.
pub fn current_client() -> Option<Arc<AnalyticsClient>> {
    ANALYTICS_CLIENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .cloned()
}
