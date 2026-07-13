# Building muesly from Source

All builds run from the `app/` directory.

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install)
- [mise](https://mise.jdx.dev/) — provisions the JS toolchain (Node, pnpm, and [nub](https://nubjs.com/)) from `mise.toml`; run `mise install`. nub runs the TypeScript in the auto-GPU `tauri:dev` / `tauri:build` scripts; the explicit GPU variants below don't need it.
- [CMake](https://cmake.org/) and a C/C++ toolchain (whisper.cpp and the llama sidecar compile native code)
- **Windows only:** Visual Studio Build Tools ("Desktop development with C++") and LLVM. `whisper-rs`'s bindgen needs `libclang`; if it isn't found, set `LIBCLANG_PATH` (e.g. `C:\Program Files\LLVM\bin`).
- **Optional GPU:** the development SDK for your GPU, see the [GPU Acceleration Guide](gpu-acceleration.md).

Installing these toolchains is out of scope here; follow each project's own instructions.

## Build

```bash
cd app
pnpm install && pnpm -C src-svelte install   # frontend deps install separately

pnpm tauri:dev      # development, with hot reload
pnpm tauri:build    # production build
```

Both commands auto-detect your GPU and build with the matching acceleration backend. To force one, use an explicit variant (`pnpm tauri:build:cuda`, `:vulkan`, `:metal`, `:coreml`, `:openblas`, `:hipblas`, `:cpu`) or set `TAURI_GPU_FEATURE`. See the [GPU Acceleration Guide](gpu-acceleration.md).

## Output

Bundles are written under `target/release/bundle/` (relative to the repository root): `.dmg` on macOS, MSI + NSIS installers on Windows, `.AppImage` on Linux. If an AppImage build fails on stripped symbols, set `NO_STRIP=true`.
