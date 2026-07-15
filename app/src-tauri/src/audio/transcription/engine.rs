// audio/transcription/engine.rs
//
// Live transcription engine selection, initialization, and validation.

use log::{info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

/// The engine driving LIVE transcription: Whisper (default, highest quality)
/// or Parakeet (the fast multilingual alternative; ~10x faster on CPU, no GPU
/// use, but no language lock, no vocabulary prompting, and no confidence).
/// Offline jobs (retranscribe/import) resolve their own engines from the
/// request; this enum serves only the live worker, which is why the
/// whisper-only machinery (prompt continuity, auto-language repair, vocabulary
/// learning) is reached through [`TranscriptionEngine::as_whisper`].
#[derive(Clone)]
pub enum TranscriptionEngine {
    Whisper(Arc<crate::whisper_engine::WhisperEngine>),
    Parakeet(Arc<crate::parakeet_engine::ParakeetEngine>),
}

impl TranscriptionEngine {
    /// The inner Whisper engine, when this is the Whisper variant. Gate all
    /// whisper-only behavior (language repair, vocabulary learning) on this.
    pub fn as_whisper(&self) -> Option<&Arc<crate::whisper_engine::WhisperEngine>> {
        match self {
            Self::Whisper(engine) => Some(engine),
            Self::Parakeet(_) => None,
        }
    }

    pub async fn is_model_loaded(&self) -> bool {
        match self {
            Self::Whisper(engine) => engine.is_model_loaded().await,
            Self::Parakeet(engine) => engine.is_model_loaded().await,
        }
    }

    pub async fn get_current_model(&self) -> Option<String> {
        match self {
            Self::Whisper(engine) => engine.get_current_model().await,
            Self::Parakeet(engine) => engine.get_current_model().await,
        }
    }

    pub async fn load_model(&self, model_name: &str) -> Result<(), String> {
        match self {
            Self::Whisper(engine) => engine
                .load_model(model_name)
                .await
                .map_err(|e| e.to_string()),
            Self::Parakeet(engine) => engine
                .load_model(model_name)
                .await
                .map_err(|e| e.to_string()),
        }
    }

    pub async fn unload_model(&self) {
        match self {
            Self::Whisper(engine) => {
                engine.unload_model().await;
            }
            Self::Parakeet(engine) => {
                engine.unload_model().await;
            }
        }
    }

    /// Drop prior-segment prompt context (whisper-only concept; no-op for
    /// Parakeet, which decodes each segment independently).
    pub async fn reset_segment_context(&self) {
        if let Self::Whisper(engine) = self {
            engine.reset_segment_context().await;
        }
    }
}

// ============================================================================
// MODEL VALIDATION AND INITIALIZATION
// ============================================================================

/// The configured live transcription provider ("localWhisper" unless the
/// saved config explicitly selects "parakeet").
async fn configured_provider<R: Runtime>(app: &AppHandle<R>) -> String {
    match crate::api::api_get_transcript_config(app.clone(), app.clone().state(), None).await {
        Ok(Some(config)) if config.provider == "parakeet" => "parakeet".to_string(),
        _ => "localWhisper".to_string(),
    }
}

/// Validate that the configured local transcription model is ready before
/// starting a recording.
pub async fn validate_transcription_model_ready<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    if configured_provider(app).await == "parakeet" {
        info!("🔍 Validating Parakeet model...");
        if let Err(init_error) = crate::parakeet_engine::commands::parakeet_init().await {
            warn!("❌ Failed to initialize Parakeet engine: {}", init_error);
            return Err(format!(
                "Failed to initialize speech recognition: {}",
                init_error
            ));
        }
        return match crate::parakeet_engine::commands::parakeet_validate_model_ready_with_config(
            app,
        )
        .await
        {
            Ok(model_name) => {
                info!(
                    "✅ Parakeet model validation successful: {} is ready",
                    model_name
                );
                Ok(())
            }
            Err(error) => {
                warn!("❌ Parakeet model validation failed: {}", error);
                Err(error)
            }
        };
    }

    info!("🔍 Validating Whisper model...");
    if let Err(init_error) = crate::whisper_engine::commands::whisper_init().await {
        warn!("❌ Failed to initialize Whisper engine: {}", init_error);
        return Err(format!(
            "Failed to initialize speech recognition: {}",
            init_error
        ));
    }

    match crate::whisper_engine::commands::whisper_validate_model_ready_with_config(app).await {
        Ok(model_name) => {
            info!(
                "✅ Whisper model validation successful: {} is ready",
                model_name
            );
            Ok(())
        }
        Err(error) => {
            warn!("❌ Whisper model validation failed: {}", error);
            Err(error)
        }
    }
}

/// Get or initialize the configured live transcription engine.
pub async fn get_or_init_transcription_engine<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<TranscriptionEngine, String> {
    if configured_provider(app).await == "parakeet" {
        info!("🦜 Initializing Parakeet transcription engine");
        return Ok(TranscriptionEngine::Parakeet(
            get_or_init_parakeet(app).await?,
        ));
    }
    info!("🎤 Initializing Whisper transcription engine");
    Ok(TranscriptionEngine::Whisper(
        get_or_init_whisper(app).await?,
    ))
}

/// Get or initialize the Parakeet engine with the configured model loaded.
/// Validation at recording start already ensured the model is on disk.
pub async fn get_or_init_parakeet<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Arc<crate::parakeet_engine::ParakeetEngine>, String> {
    crate::parakeet_engine::commands::parakeet_init().await?;
    let engine = {
        let engine_guard = crate::parakeet_engine::commands::PARAKEET_ENGINE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        engine_guard
            .as_ref()
            .cloned()
            .ok_or("Failed to get initialized Parakeet engine")?
    };

    let configured_model =
        match crate::api::api_get_transcript_config(app.clone(), app.clone().state(), None).await {
            Ok(Some(config)) if config.provider == "parakeet" && !config.model.is_empty() => {
                config.model
            }
            _ => crate::config::DEFAULT_PARAKEET_MODEL.to_string(),
        };

    if engine.is_model_loaded().await
        && engine.get_current_model().await.as_deref() == Some(configured_model.as_str())
    {
        return Ok(engine);
    }
    // `load_model` resolves the model from the discovery cache, so populate it
    // first: this function must stay correct even when validation didn't run.
    let models = engine
        .discover_models()
        .await
        .map_err(|e| format!("Failed to discover Parakeet models: {}", e))?;
    // Mirror validation's fallback: when the configured model isn't on disk,
    // load the first available one rather than failing a recording start that
    // validation already approved.
    let model_to_load = if models.iter().any(|m| {
        m.name == configured_model
            && matches!(
                m.status,
                crate::transcription_models::ModelStatus::Available
            )
    }) {
        configured_model
    } else {
        models
            .iter()
            .find(|m| matches!(m.status, crate::transcription_models::ModelStatus::Available))
            .map(|m| m.name.clone())
            .ok_or_else(|| {
                format!(
                    "Parakeet model '{}' is not downloaded and no other Parakeet model is available",
                    configured_model
                )
            })?
    };
    engine
        .load_model(&model_to_load)
        .await
        .map_err(|e| format!("Failed to load Parakeet model '{}': {}", model_to_load, e))?;
    Ok(engine)
}

/// Get or initialize transcription engine using API configuration
/// Returns Whisper engine if provider is localWhisper, otherwise returns error for non-Whisper providers
pub async fn get_or_init_whisper<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Arc<crate::whisper_engine::WhisperEngine>, String> {
    // Check if engine already exists and has a model loaded
    let existing_engine = {
        let engine_guard = crate::whisper_engine::commands::WHISPER_ENGINE
            .lock()
            .unwrap();
        engine_guard.as_ref().cloned()
    };

    if let Some(engine) = existing_engine {
        // Check if a model is already loaded
        if engine.is_model_loaded().await {
            let current_model = engine
                .get_current_model()
                .await
                .unwrap_or_else(|| "unknown".to_string());

            // NEW: Check if loaded model matches saved config
            let configured_model =
                match crate::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
                    .await
                {
                    Ok(Some(config)) => {
                        info!(
                            "📝 Saved transcript config - provider: {}, model: {}",
                            config.provider, config.model
                        );
                        if config.provider == "localWhisper" && !config.model.is_empty() {
                            Some(config.model)
                        } else {
                            None
                        }
                    }
                    Ok(None) => {
                        info!("📝 No transcript config found in database");
                        None
                    }
                    Err(e) => {
                        warn!("⚠️ Failed to get transcript config: {}", e);
                        None
                    }
                };

            // If loaded model matches config, reuse it
            if let Some(ref expected_model) = configured_model {
                if current_model == *expected_model {
                    info!(
                        "✅ Loaded model '{}' matches saved config, reusing",
                        current_model
                    );
                    return Ok(engine);
                } else {
                    info!(
                        "🔄 Loaded model '{}' doesn't match saved config '{}', reloading correct model...",
                        current_model, expected_model
                    );
                    // Unload the incorrect model
                    engine.unload_model().await;
                    info!("📉 Unloaded incorrect model '{}'", current_model);
                    // Continue to model loading logic below
                }
            } else {
                // No specific config saved, accept currently loaded model
                info!(
                    "✅ No specific model configured, using currently loaded model: '{}'",
                    current_model
                );
                return Ok(engine);
            }
        } else {
            info!("🔄 Whisper engine exists but no model loaded, will load model from config");
        }
    }

    // Initialize new engine if needed
    info!("Initializing Whisper engine");

    // First ensure the engine is initialized
    if let Err(e) = crate::whisper_engine::commands::whisper_init().await {
        return Err(format!("Failed to initialize Whisper engine: {}", e));
    }

    // Get the engine reference
    let engine = {
        let engine_guard = crate::whisper_engine::commands::WHISPER_ENGINE
            .lock()
            .unwrap();
        engine_guard
            .as_ref()
            .cloned()
            .ok_or("Failed to get initialized engine")?
    };

    // Get model configuration from API
    let model_to_load = match crate::api::api_get_transcript_config(
        app.clone(),
        app.clone().state(),
        None,
    )
    .await
    {
        Ok(Some(config)) => {
            info!(
                "Got transcript config from API - provider: {}, model: {}",
                config.provider, config.model
            );
            if config.provider == "localWhisper" && !config.model.is_empty() {
                info!("Using model from API config: {}", config.model);
                config.model
            } else {
                warn!(
                    "Ignoring obsolete transcription provider '{}'; using the recommended Whisper model",
                    config.provider
                );
                crate::config::recommended_whisper_model(crate::audio::HardwareProfile::detect())
                    .to_string()
            }
        }
        Ok(None) => {
            info!("No transcript config found; using the recommended Whisper model");
            crate::config::recommended_whisper_model(crate::audio::HardwareProfile::detect())
                .to_string()
        }
        Err(e) => {
            warn!(
                "Failed to get transcript config from API: {}; using the recommended Whisper model",
                e
            );
            crate::config::recommended_whisper_model(crate::audio::HardwareProfile::detect())
                .to_string()
        }
    };

    info!("Selected model to load: {}", model_to_load);

    // Discover available models to check if the desired model is downloaded
    let models = engine
        .discover_models()
        .await
        .map_err(|e| format!("Failed to discover models: {}", e))?;

    info!("Discovered {} models", models.len());
    for model in &models {
        info!(
            "Model: {} - Status: {:?} - Path: {}",
            model.name,
            model.status,
            model.path.display()
        );
    }

    // Check if the desired model is available
    let model_info = models.iter().find(|model| model.name == model_to_load);

    if model_info.is_none() {
        info!(
            "Model '{}' not found in discovered models. Available models: {:?}",
            model_to_load,
            models.iter().map(|m| &m.name).collect::<Vec<_>>()
        );
    }

    match model_info {
        Some(model) => match model.status {
            crate::whisper_engine::ModelStatus::Available => {
                info!("Loading model: {}", model_to_load);
                engine
                    .load_model(&model_to_load)
                    .await
                    .map_err(|e| format!("Failed to load model '{}': {}", model_to_load, e))?;
                info!("✅ Model '{}' loaded successfully", model_to_load);
            }
            crate::whisper_engine::ModelStatus::Missing => {
                return Err(format!(
                    "Model '{}' is not downloaded. Please download it first from the settings.",
                    model_to_load
                ));
            }
            crate::whisper_engine::ModelStatus::Downloading { progress } => {
                return Err(format!(
                    "Model '{}' is currently downloading ({}%). Please wait for it to complete.",
                    model_to_load, progress
                ));
            }
            crate::whisper_engine::ModelStatus::Error(ref err) => {
                return Err(format!(
                    "Model '{}' has an error: {}. Please check the model or try downloading it again.",
                    model_to_load, err
                ));
            }
            crate::whisper_engine::ModelStatus::Corrupted { .. } => {
                return Err(format!(
                    "Model '{}' is corrupted. Please delete it and download again from the settings.",
                    model_to_load
                ));
            }
        },
        None => {
            // Check if we have any available models and try to load the first one
            let available_models: Vec<_> = models
                .iter()
                .filter(|m| matches!(m.status, crate::whisper_engine::ModelStatus::Available))
                .collect();

            if let Some(fallback_model) = available_models.first() {
                warn!(
                    "Model '{}' not found, falling back to available model: '{}'",
                    model_to_load, fallback_model.name
                );
                engine.load_model(&fallback_model.name).await.map_err(|e| {
                    format!(
                        "Failed to load fallback model '{}': {}",
                        fallback_model.name, e
                    )
                })?;
                info!(
                    "✅ Fallback model '{}' loaded successfully",
                    fallback_model.name
                );
            } else {
                return Err(format!(
                    "Model '{}' is not supported and no other models are available. Please download a model from the settings.",
                    model_to_load
                ));
            }
        }
    }

    Ok(engine)
}
