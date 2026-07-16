//! Types shared by the transcription engines (Whisper, Parakeet).
//!
//! The two engines manage models with genuinely different on-disk layouts
//! (Whisper = a single GGML `.bin` file; Parakeet = a directory of ONNX files),
//! so their download/discovery I/O is intentionally NOT shared. What they DO
//! share — and what lives here — is the model lifecycle status type, kept as a
//! single definition so the two engines (and the frontend that deserializes it)
//! can never drift apart.

use serde::{Deserialize, Serialize};

pub const AUTOMATIC_TRANSCRIPTION_PROVIDER: &str = "automatic";
pub const AUTOMATIC_TRANSCRIPTION_MODEL: &str = "automatic";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
pub struct ResolvedTranscriptionModel {
    pub provider: String,
    pub model: String,
    pub reason: String,
}

/// Choose a stable model for one transcription operation. The caller supplies
/// only models that are already downloaded and verified: automatic mode never
/// starts a surprise download. The returned model remains fixed until the next
/// recording/import/retranscription begins.
pub fn choose_automatic_transcription_model(
    profile: &crate::audio::HardwareProfile,
    available_whisper: &[String],
    available_parakeet: &[String],
) -> Result<ResolvedTranscriptionModel, String> {
    let preferred = crate::config::recommended_whisper_model(profile);
    let tier_candidates: &[&str] = match profile.performance_tier {
        crate::audio::PerformanceTier::Ultra | crate::audio::PerformanceTier::High => &[
            "large-v3-turbo-q5_0",
            "large-v3-turbo",
            "medium-q5_0",
            "medium",
            "small-q5_1",
            "small",
            "base-q5_1",
            "base",
            "tiny-q5_1",
            "tiny",
        ],
        crate::audio::PerformanceTier::Medium => &[
            "small-q5_1",
            "small",
            "base-q5_1",
            "base",
            "tiny-q5_1",
            "tiny",
        ],
        crate::audio::PerformanceTier::Low => &["base-q5_1", "base", "tiny-q5_1", "tiny"],
    };

    if let Some(model) = tier_candidates
        .iter()
        .find(|candidate| available_whisper.iter().any(|model| model == **candidate))
    {
        return Ok(ResolvedTranscriptionModel {
            provider: "localWhisper".to_string(),
            model: (*model).to_string(),
            reason: if *model == preferred {
                "Best balance for this computer".to_string()
            } else {
                format!("Best downloaded model for this computer (preferred: {preferred})")
            },
        });
    }

    if let Some(model) = available_parakeet.first() {
        return Ok(ResolvedTranscriptionModel {
            provider: "parakeet".to_string(),
            model: model.clone(),
            reason: "Fast local fallback because no hardware-suitable Whisper model is downloaded"
                .to_string(),
        });
    }

    // A manually downloaded legacy/full-precision Whisper model is still more
    // useful than refusing to transcribe. Preserve catalog quality order here.
    const WHISPER_FALLBACKS: &[&str] = &[
        "large-v3",
        "large-v3-q5_0",
        "large-v3-turbo",
        "large-v3-turbo-q5_0",
        "medium",
        "medium-q5_0",
        "small",
        "small-q5_1",
        "base",
        "base-q5_1",
        "tiny",
        "tiny-q5_1",
    ];
    if let Some(model) = WHISPER_FALLBACKS
        .iter()
        .find(|candidate| available_whisper.iter().any(|model| model == **candidate))
    {
        return Ok(ResolvedTranscriptionModel {
            provider: "localWhisper".to_string(),
            model: (*model).to_string(),
            reason: "Using the only compatible downloaded Whisper model".to_string(),
        });
    }

    Err(
        "No downloaded transcription model is available. Download a model in Settings first."
            .to_string(),
    )
}

/// Lifecycle status of a transcription model on disk.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub enum ModelStatus {
    /// Present and validated; ready to load.
    Available,
    /// Not present on disk.
    Missing,
    /// Currently downloading, with percentage progress.
    Downloading { progress: u8 },
    /// An error occurred (message included).
    Error(String),
    /// Present but failed validation (size mismatch).
    Corrupted {
        file_size: u64,
        expected_min_size: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::choose_automatic_transcription_model;
    use crate::audio::{GpuType, HardwareProfile, PerformanceTier};

    fn profile(performance_tier: PerformanceTier) -> HardwareProfile {
        HardwareProfile {
            cpu_cores: 8,
            has_gpu_acceleration: performance_tier != PerformanceTier::Low,
            gpu_type: GpuType::None,
            memory_gb: 16,
            performance_tier,
        }
    }

    #[test]
    fn automatic_prefers_the_tier_recommendation() {
        let resolved = choose_automatic_transcription_model(
            &profile(PerformanceTier::High),
            &["base-q5_1".into(), "large-v3-turbo-q5_0".into()],
            &["parakeet-tdt-0.6b-v3-int8".into()],
        )
        .unwrap();
        assert_eq!(resolved.provider, "localWhisper");
        assert_eq!(resolved.model, "large-v3-turbo-q5_0");
    }

    #[test]
    fn automatic_does_not_choose_an_oversized_model_when_a_fast_fallback_exists() {
        let resolved = choose_automatic_transcription_model(
            &profile(PerformanceTier::Low),
            &["large-v3".into()],
            &["parakeet-tdt-0.6b-v3-int8".into()],
        )
        .unwrap();
        assert_eq!(resolved.provider, "parakeet");
    }

    #[test]
    fn automatic_uses_the_best_suitable_downloaded_fallback() {
        let resolved = choose_automatic_transcription_model(
            &profile(PerformanceTier::Medium),
            &["tiny-q5_1".into(), "base-q5_1".into()],
            &[],
        )
        .unwrap();
        assert_eq!(resolved.model, "base-q5_1");
    }

    #[test]
    fn automatic_requires_a_downloaded_model() {
        assert!(
            choose_automatic_transcription_model(&profile(PerformanceTier::Medium), &[], &[])
                .is_err()
        );
    }
}
