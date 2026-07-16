/// Application configuration constants
///
/// Centralized definitions for default models and settings.
/// Used across database initialization, import, and retranscription.

/// Default Whisper model for transcription when no preference is configured.
/// This is the recommended balance of accuracy and speed.
pub const DEFAULT_WHISPER_MODEL: &str = "large-v3-turbo";

/// Pick the smallest Whisper model that preserves a good live experience on
/// the detected hardware. Quantized models keep onboarding downloads and memory
/// low while higher tiers retain Large v3 Turbo accuracy.
pub fn recommended_whisper_model(profile: &crate::audio::HardwareProfile) -> &'static str {
    recommended_whisper_model_for_task(profile, false)
}

/// Turbo is optimized for transcription, but OpenAI explicitly does not train
/// it for speech translation. Keep automatic recommendations task-compatible
/// instead of silently returning original-language text for "translate to
/// English".
pub fn recommended_whisper_model_for_task(
    profile: &crate::audio::HardwareProfile,
    requires_translation: bool,
) -> &'static str {
    match profile.performance_tier {
        crate::audio::PerformanceTier::Ultra | crate::audio::PerformanceTier::High => {
            if requires_translation {
                "large-v3-q5_0"
            } else {
                "large-v3-turbo-q5_0"
            }
        }
        crate::audio::PerformanceTier::Medium => "small-q5_1",
        crate::audio::PerformanceTier::Low => "base-q5_1",
    }
}

/// Default Parakeet model for transcription when no preference is configured.
/// This is the quantized version optimized for speed.
pub const DEFAULT_PARAKEET_MODEL: &str = "parakeet-tdt-0.6b-v3-int8";

/// Whisper model catalog with metadata for all supported models.
/// Used by both WhisperEngine::discover_models() and discover_models_standalone().
///
/// Format: (name, filename, size_mb, accuracy, speed, description)
pub const WHISPER_MODEL_CATALOG: &[(&str, &str, u32, &str, &str, &str)] = &[
    // Standard f16 models (full precision)
    (
        "tiny",
        "ggml-tiny.bin",
        75,
        "Decent",
        "Very Fast",
        "Smallest full-precision Whisper model",
    ),
    (
        "base",
        "ggml-base.bin",
        142,
        "Good",
        "Fast",
        "Entry-size full-precision Whisper model",
    ),
    (
        "small",
        "ggml-small.bin",
        466,
        "Good",
        "Medium",
        "Mid-size full-precision Whisper model",
    ),
    (
        "medium",
        "ggml-medium.bin",
        1463,
        "High",
        "Slow",
        "Large full-precision Whisper model with translation support",
    ),
    (
        "large-v3-turbo",
        "ggml-large-v3-turbo.bin",
        1549,
        "High",
        "Medium",
        "Fast high-quality transcription; does not translate speech",
    ),
    (
        "large-v3",
        "ggml-large-v3.bin",
        2951,
        "High",
        "Slow",
        "Highest-quality Whisper model with translation support",
    ),
    // Q5_1 quantized models (balanced speed/accuracy, slightly better quality than Q5_0)
    (
        "tiny-q5_1",
        "ggml-tiny-q5_1.bin",
        31,
        "Decent",
        "Very Fast",
        "Smallest compressed Whisper model",
    ),
    (
        "base-q5_1",
        "ggml-base-q5_1.bin",
        57,
        "Good",
        "Fast",
        "Compressed entry-size Whisper model",
    ),
    (
        "small-q5_1",
        "ggml-small-q5_1.bin",
        181,
        "Good",
        "Fast",
        "Compressed mid-size Whisper model",
    ),
    // Q5_0 quantized models (balanced speed/accuracy)
    (
        "medium-q5_0",
        "ggml-medium-q5_0.bin",
        514,
        "High",
        "Medium",
        "Compressed large Whisper model with translation support",
    ),
    (
        "large-v3-turbo-q5_0",
        "ggml-large-v3-turbo-q5_0.bin",
        547,
        "High",
        "Medium",
        "Compressed Turbo transcription model; does not translate speech",
    ),
    (
        "large-v3-q5_0",
        "ggml-large-v3-q5_0.bin",
        1031,
        "High",
        "Slow",
        "Compressed highest-quality Whisper model with translation support",
    ),
];

#[cfg(test)]
mod tests {
    use super::{recommended_whisper_model, recommended_whisper_model_for_task};
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
    fn recommends_a_model_each_hardware_tier_can_run_interactively() {
        assert_eq!(
            recommended_whisper_model(&profile(PerformanceTier::Low)),
            "base-q5_1"
        );
        assert_eq!(
            recommended_whisper_model(&profile(PerformanceTier::Medium)),
            "small-q5_1"
        );
        assert_eq!(
            recommended_whisper_model(&profile(PerformanceTier::High)),
            "large-v3-turbo-q5_0"
        );
        assert_eq!(
            recommended_whisper_model(&profile(PerformanceTier::Ultra)),
            "large-v3-turbo-q5_0"
        );
    }

    #[test]
    fn translation_recommendations_never_use_turbo() {
        for tier in [
            PerformanceTier::Low,
            PerformanceTier::Medium,
            PerformanceTier::High,
            PerformanceTier::Ultra,
        ] {
            assert!(!recommended_whisper_model_for_task(&profile(tier), true).contains("turbo"));
        }
        assert_eq!(
            recommended_whisper_model_for_task(&profile(PerformanceTier::High), true),
            "large-v3-q5_0"
        );
    }
}
