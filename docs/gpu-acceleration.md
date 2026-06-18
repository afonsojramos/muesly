# GPU Acceleration

Transcription (`whisper-rs`) and local summarization (the llama sidecar) share the same acceleration backends:

| Backend | Hardware |
| --- | --- |
| CUDA | NVIDIA GPUs |
| Metal / Core ML | Apple Silicon (Metal also on Intel Macs) |
| Vulkan | AMD / Intel GPUs (cross-platform) |
| HIPBLAS | AMD GPUs on Linux (ROCm) |
| OpenBLAS | optimized CPU fallback |

## Auto-detection

`pnpm tauri:dev` and `pnpm tauri:build` run `app/scripts/tauri-auto.ts`, which detects your GPU (via `app/scripts/auto-detect-gpu.ts`) and builds with the matching `--features` flag. On macOS, Metal and Core ML are always enabled. On Windows/Linux, detection runs in priority order:

| Priority | Backend | Detected when | Feature |
| --- | --- | --- | --- |
| 1 | CUDA | `nvidia-smi` + (`CUDA_PATH` or `nvcc`) | `cuda` |
| 2 | ROCm | `rocm-smi` + (`ROCM_PATH` or `hipcc`) | `hipblas` |
| 3 | Vulkan | `vulkaninfo` + `VULKAN_SDK` + `BLAS_INCLUDE_DIRS` | `vulkan` |
| 4 | OpenBLAS | `BLAS_INCLUDE_DIRS` | `openblas` |
| 5 | CPU | none of the above | (none) |

GPU drivers alone are not enough: the development SDK (CUDA Toolkit, ROCm, or Vulkan SDK plus a BLAS) must be installed and discoverable through the environment variables above. Installing those SDKs is outside the scope of this guide.

## Forcing a backend

```bash
pnpm tauri:build:cuda          # also: vulkan, metal, coreml, openblas, hipblas, cpu
TAURI_GPU_FEATURE=vulkan pnpm tauri:build
```

## Build environment variables

| Variable | Purpose |
| --- | --- |
| `TAURI_GPU_FEATURE` | Force a backend and skip detection |
| `CUDA_PATH` / `ROCM_PATH` / `VULKAN_SDK` | SDK locations used by detection |
| `BLAS_INCLUDE_DIRS` | BLAS headers (required for Vulkan and OpenBLAS) |
| `CMAKE_CUDA_ARCHITECTURES` | GPU compute capability, e.g. `86` for compute 8.6 (auto-detect defaults to `75`) |
| `NO_STRIP` | Set `true` if an AppImage build fails on stripped symbols |
