use crate::audio::{GpuType, PerformanceTier};
use std::ffi::CStr;
use whisper_rs::whisper_rs_sys as sys;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperCompiledBackend {
    Metal,
    Cuda,
    Vulkan,
    HipBlas,
    Cpu,
}

impl WhisperCompiledBackend {
    pub fn current() -> Self {
        if cfg!(feature = "cuda") {
            Self::Cuda
        } else if cfg!(feature = "vulkan") {
            Self::Vulkan
        } else if cfg!(feature = "hipblas") {
            Self::HipBlas
        } else if cfg!(target_os = "macos") || cfg!(feature = "metal") {
            Self::Metal
        } else {
            Self::Cpu
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Metal => "Metal",
            Self::Cuda => "Cuda",
            Self::Vulkan => "Vulkan",
            Self::HipBlas => "HipBlas",
            Self::Cpu => "Cpu",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WhisperContextAcceleration {
    pub compiled_backend: WhisperCompiledBackend,
    pub runtime_detected_gpu: GpuType,
    pub use_gpu: bool,
    pub flash_attn: bool,
    pub gpu_device: i32,
}

impl WhisperContextAcceleration {
    pub fn status_label(self) -> &'static str {
        match (self.compiled_backend, self.flash_attn) {
            (WhisperCompiledBackend::Metal, true) => "Metal GPU with Flash Attention (Ultra-Fast)",
            (WhisperCompiledBackend::Metal, false) => "Metal GPU acceleration",
            (WhisperCompiledBackend::Cuda, true) => "CUDA GPU with Flash Attention (Ultra-Fast)",
            (WhisperCompiledBackend::Cuda, false) => "CUDA GPU acceleration",
            (WhisperCompiledBackend::Vulkan, _) => "Vulkan GPU acceleration",
            (WhisperCompiledBackend::HipBlas, _) => "HIP BLAS GPU acceleration",
            (WhisperCompiledBackend::Cpu, _) => "CPU processing only",
        }
    }

    /// Keep the compiled backend available while forcing context allocation and
    /// inference onto the CPU. This is an explicit escape hatch for native GPU
    /// backends that abort the process during allocation instead of returning an
    /// error that the normal fallback path can catch.
    pub fn forced_cpu(mut self) -> Self {
        self.use_gpu = false;
        self.flash_attn = false;
        self.gpu_device = 0;
        self
    }
}

pub fn whisper_context_acceleration_for(
    compiled_backend: WhisperCompiledBackend,
    runtime_detected_gpu: GpuType,
    performance_tier: PerformanceTier,
) -> WhisperContextAcceleration {
    let use_gpu = !matches!(compiled_backend, WhisperCompiledBackend::Cpu);
    let fast_tier = matches!(
        performance_tier,
        PerformanceTier::High | PerformanceTier::Ultra
    );
    let flash_attn = match compiled_backend {
        WhisperCompiledBackend::Metal | WhisperCompiledBackend::Cuda => fast_tier,
        WhisperCompiledBackend::Vulkan
        | WhisperCompiledBackend::HipBlas
        | WhisperCompiledBackend::Cpu => false,
    };

    WhisperContextAcceleration {
        compiled_backend,
        runtime_detected_gpu,
        use_gpu,
        flash_attn: use_gpu && flash_attn,
        gpu_device: 0,
    }
}

/// Prove that whisper.cpp can initialize the requested GPU device before an
/// evaluation run is allowed to label its measurements as GPU-backed.
///
/// whisper.cpp intentionally falls back to its CPU backend when `use_gpu` is
/// true but no usable GPU backend exists. That behavior is useful in the app,
/// but would make benchmark provenance dishonest. This preflight mirrors
/// whisper.cpp's GPU-device selection and performs a real backend
/// initialization, then immediately frees the temporary backend.
pub fn verify_gpu_backend_available(gpu_device: i32) -> Result<String, String> {
    if gpu_device < 0 {
        return Err(format!(
            "GPU device index must be non-negative, got {gpu_device}"
        ));
    }

    let mut matching_index = 0_i32;

    // SAFETY: the device registry and device handles are owned by ggml. We do
    // not retain pointers beyond this call, and every successfully initialized
    // temporary backend is freed before returning.
    unsafe {
        for index in 0..sys::ggml_backend_dev_count() {
            let device = sys::ggml_backend_dev_get(index);
            if device.is_null() {
                continue;
            }
            let device_type = sys::ggml_backend_dev_type(device);
            let is_gpu = device_type == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU
                || device_type == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU;
            if !is_gpu {
                continue;
            }
            if matching_index != gpu_device {
                matching_index += 1;
                continue;
            }

            let name_ptr = sys::ggml_backend_dev_name(device);
            let name = if name_ptr.is_null() {
                "unknown GPU".to_string()
            } else {
                CStr::from_ptr(name_ptr).to_string_lossy().into_owned()
            };
            let backend = sys::ggml_backend_dev_init(device, std::ptr::null());
            if backend.is_null() {
                return Err(format!(
                    "failed to initialize GPU device {gpu_device} ({name})"
                ));
            }
            sys::ggml_backend_free(backend);
            return Ok(name);
        }
    }

    Err(format!(
        "GPU device {gpu_device} is unavailable (found {matching_index} GPU devices)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceleration_vulkan_backend_ignores_runtime_cuda_flash_attention() {
        let params = whisper_context_acceleration_for(
            WhisperCompiledBackend::Vulkan,
            GpuType::Cuda,
            PerformanceTier::High,
        );

        assert_eq!(params.compiled_backend, WhisperCompiledBackend::Vulkan);
        assert_eq!(params.runtime_detected_gpu, GpuType::Cuda);
        assert!(params.use_gpu);
        assert!(!params.flash_attn);
    }

    #[test]
    fn acceleration_vulkan_backend_keeps_gpu_without_runtime_gpu_detection() {
        let params = whisper_context_acceleration_for(
            WhisperCompiledBackend::Vulkan,
            GpuType::None,
            PerformanceTier::Low,
        );

        assert!(params.use_gpu);
        assert!(!params.flash_attn);
    }

    #[test]
    fn acceleration_cuda_backend_enables_flash_attention_for_fast_tiers() {
        let high = whisper_context_acceleration_for(
            WhisperCompiledBackend::Cuda,
            GpuType::Cuda,
            PerformanceTier::High,
        );
        let ultra = whisper_context_acceleration_for(
            WhisperCompiledBackend::Cuda,
            GpuType::Cuda,
            PerformanceTier::Ultra,
        );

        assert!(high.use_gpu);
        assert!(high.flash_attn);
        assert!(ultra.use_gpu);
        assert!(ultra.flash_attn);
    }

    #[test]
    fn acceleration_cpu_backend_disables_gpu_and_flash_attention() {
        for runtime_gpu in [GpuType::None, GpuType::Cuda, GpuType::Vulkan] {
            let params = whisper_context_acceleration_for(
                WhisperCompiledBackend::Cpu,
                runtime_gpu,
                PerformanceTier::Ultra,
            );

            assert!(!params.use_gpu);
            assert!(!params.flash_attn);
        }
    }

    #[test]
    fn forced_cpu_disables_gpu_on_a_metal_build() {
        let params = whisper_context_acceleration_for(
            WhisperCompiledBackend::Metal,
            GpuType::Metal,
            PerformanceTier::Ultra,
        )
        .forced_cpu();

        assert_eq!(params.compiled_backend, WhisperCompiledBackend::Metal);
        assert!(!params.use_gpu);
        assert!(!params.flash_attn);
        assert_eq!(params.gpu_device, 0);
    }

    #[test]
    fn gpu_backend_preflight_rejects_negative_device_indexes() {
        assert_eq!(
            verify_gpu_backend_available(-1).unwrap_err(),
            "GPU device index must be non-negative, got -1"
        );
    }
}
