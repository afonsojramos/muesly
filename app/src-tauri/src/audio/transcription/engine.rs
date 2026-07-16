// audio/transcription/engine.rs
//
// Live transcription engine selection, initialization, and validation.

use log::{info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

/// The engine driving LIVE transcription: Whisper (broad language controls and
/// prompting) or Parakeet (the fast 25-language alternative, but no language
/// lock, vocabulary prompting, or confidence exposed to the app).
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

/// Resolve automatic mode against downloaded, verified models. This performs
/// discovery only; loading still happens in the engine-specific path below.
#[tauri::command]
#[specta::specta]
pub async fn get_automatic_transcription_model()
-> Result<crate::transcription_models::ResolvedTranscriptionModel, String> {
    let requires_translation =
        crate::get_language_preference_internal().as_deref() == Some("auto-translate");
    automatic_transcription_model_for_task(requires_translation).await
}

async fn automatic_transcription_model_for_task(
    requires_translation: bool,
) -> Result<crate::transcription_models::ResolvedTranscriptionModel, String> {
    let mut whisper_models = Vec::new();
    if crate::whisper_engine::commands::whisper_init()
        .await
        .is_ok()
    {
        let engine = {
            let guard = crate::whisper_engine::commands::WHISPER_ENGINE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned()
        };
        if let Some(engine) = engine
            && let Ok(models) = engine.discover_models().await
        {
            whisper_models.extend(models.into_iter().filter_map(|model| {
                matches!(
                    model.status,
                    crate::transcription_models::ModelStatus::Available
                )
                .then_some(model.name)
            }));
        }
    }

    let mut parakeet_models = Vec::new();
    if crate::parakeet_engine::commands::parakeet_init()
        .await
        .is_ok()
    {
        let engine = {
            let guard = crate::parakeet_engine::commands::PARAKEET_ENGINE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            guard.as_ref().cloned()
        };
        if let Some(engine) = engine
            && let Ok(models) = engine.discover_models().await
        {
            parakeet_models.extend(models.into_iter().filter_map(|model| {
                matches!(
                    model.status,
                    crate::transcription_models::ModelStatus::Available
                )
                .then_some(model.name)
            }));
        }
    }

    crate::transcription_models::choose_automatic_transcription_model(
        crate::audio::HardwareProfile::detect(),
        &whisper_models,
        &parakeet_models,
        requires_translation,
    )
}

fn ensure_task_compatible(
    selection: crate::transcription_models::ResolvedTranscriptionModel,
    requires_translation: bool,
) -> Result<crate::transcription_models::ResolvedTranscriptionModel, String> {
    if requires_translation
        && !crate::transcription_models::supports_speech_translation(
            &selection.provider,
            &selection.model,
        )
    {
        return Err(format!(
            "{} cannot translate speech to English. Choose a non-Turbo Whisper model or use original-language transcription.",
            selection.model
        ));
    }
    Ok(selection)
}

/// Resolve the saved setting once at an operation boundary. Manual choices are
/// returned unchanged; automatic choices are derived from current hardware and
/// downloaded models.
pub async fn configured_transcription_model<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<crate::transcription_models::ResolvedTranscriptionModel, String> {
    configured_transcription_model_for_task(
        app,
        crate::get_language_preference_internal().as_deref() == Some("auto-translate"),
    )
    .await
}

async fn configured_transcription_model_for_task<R: Runtime>(
    app: &AppHandle<R>,
    requires_translation: bool,
) -> Result<crate::transcription_models::ResolvedTranscriptionModel, String> {
    let config = crate::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
        .await?
        .ok_or_else(|| "No transcription model is configured".to_string())?;

    if config.provider == crate::transcription_models::AUTOMATIC_TRANSCRIPTION_PROVIDER {
        let resolved = automatic_transcription_model_for_task(requires_translation).await?;
        info!(
            "✨ Automatic transcription resolved to {}/{}: {}",
            resolved.provider, resolved.model, resolved.reason
        );
        return Ok(resolved);
    }

    ensure_task_compatible(
        crate::transcription_models::ResolvedTranscriptionModel {
            provider: if config.provider == "parakeet" {
                "parakeet".to_string()
            } else {
                "localWhisper".to_string()
            },
            model: config.model,
            reason: "Selected manually".to_string(),
        },
        requires_translation,
    )
}

pub async fn resolve_requested_transcription_model<R: Runtime>(
    app: &AppHandle<R>,
    provider: Option<&str>,
    model: Option<&str>,
    language: Option<&str>,
) -> Result<crate::transcription_models::ResolvedTranscriptionModel, String> {
    let requires_translation = language == Some("auto-translate");
    let selection = match (provider, model) {
        (Some("automatic"), _) => {
            automatic_transcription_model_for_task(requires_translation).await
        }
        (Some("parakeet"), Some(model)) if !model.is_empty() => {
            Ok(crate::transcription_models::ResolvedTranscriptionModel {
                provider: "parakeet".to_string(),
                model: model.to_string(),
                reason: "Selected for this operation".to_string(),
            })
        }
        (Some(_), Some(model)) if !model.is_empty() => {
            Ok(crate::transcription_models::ResolvedTranscriptionModel {
                provider: "localWhisper".to_string(),
                model: model.to_string(),
                reason: "Selected for this operation".to_string(),
            })
        }
        _ => configured_transcription_model_for_task(app, requires_translation).await,
    }?;
    ensure_task_compatible(selection, requires_translation)
}

/// Validate that the configured local transcription model is ready before
/// starting a recording.
pub async fn validate_transcription_model_ready<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    let selection = configured_transcription_model(app).await?;
    if selection.provider == "parakeet" {
        info!("🔍 Validating Parakeet model...");
        if let Err(init_error) = crate::parakeet_engine::commands::parakeet_init().await {
            warn!("❌ Failed to initialize Parakeet engine: {}", init_error);
            return Err(format!(
                "Failed to initialize speech recognition: {}",
                init_error
            ));
        }
        get_or_init_parakeet_model(app, &selection.model).await?;
        info!(
            "✅ Parakeet model validation successful: {} is ready",
            selection.model
        );
        return Ok(());
    }

    info!("🔍 Validating Whisper model...");
    if let Err(init_error) = crate::whisper_engine::commands::whisper_init().await {
        warn!("❌ Failed to initialize Whisper engine: {}", init_error);
        return Err(format!(
            "Failed to initialize speech recognition: {}",
            init_error
        ));
    }

    get_or_init_whisper_model(app, &selection.model).await?;
    info!(
        "✅ Whisper model validation successful: {} is ready",
        selection.model
    );
    Ok(())
}

/// Get or initialize the configured live transcription engine.
pub async fn get_or_init_transcription_engine<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<TranscriptionEngine, String> {
    let selection = configured_transcription_model(app).await?;
    if selection.provider == "parakeet" {
        info!("🦜 Initializing Parakeet transcription engine");
        return Ok(TranscriptionEngine::Parakeet(
            get_or_init_parakeet_model(app, &selection.model).await?,
        ));
    }
    info!("🎤 Initializing Whisper transcription engine");
    Ok(TranscriptionEngine::Whisper(
        get_or_init_whisper_model(app, &selection.model).await?,
    ))
}

/// Get or initialize the Parakeet engine with the configured model loaded.
/// Validation at recording start already ensured the model is on disk.
pub async fn get_or_init_parakeet<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Arc<crate::parakeet_engine::ParakeetEngine>, String> {
    let selection = configured_transcription_model(app).await?;
    let model = if selection.provider == "parakeet" {
        selection.model
    } else {
        crate::config::DEFAULT_PARAKEET_MODEL.to_string()
    };
    get_or_init_parakeet_model(app, &model).await
}

async fn get_or_init_parakeet_model<R: Runtime>(
    _app: &AppHandle<R>,
    configured_model: &str,
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

    let configured_model = configured_model.to_string();

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
    let selection = configured_transcription_model(app).await?;
    let model = if selection.provider == "localWhisper" {
        selection.model
    } else {
        crate::config::recommended_whisper_model(crate::audio::HardwareProfile::detect())
            .to_string()
    };
    get_or_init_whisper_model(app, &model).await
}

async fn get_or_init_whisper_model<R: Runtime>(
    _app: &AppHandle<R>,
    configured_model: &str,
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

            if current_model == configured_model {
                info!(
                    "✅ Loaded model '{}' matches the operation selection, reusing",
                    current_model
                );
                return Ok(engine);
            } else {
                info!(
                    "🔄 Loaded model '{}' doesn't match operation selection '{}', reloading...",
                    current_model, configured_model
                );
                engine.unload_model().await;
                info!("📉 Unloaded incorrect model '{}'", current_model);
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

    let model_to_load = configured_model.to_string();

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
