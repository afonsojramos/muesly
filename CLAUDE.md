## Project Overview

**muesly** is private speech-to-text for everything you say, capturing, transcribing, and summarizing entirely on local infrastructure. It is a single-process Tauri 2 desktop app with no separate backend service.

- **Frontend**: SvelteKit 2 + Svelte 5 (runes) + Tailwind 4, in `app/src-svelte/`
- **Core**: Rust (Tauri), in `app/src-tauri/`
- **Transcription**: whisper-rs (whisper.cpp) and Parakeet (ONNX Runtime), in-process, GPU-accelerated
- **Storage**: SQLite via sqlx, owned by the Rust side
- **Summarization**: local Qwen 3.5 / Gemma GGUF via the `llama-helper` sidecar, or cloud providers. Summaries use a two-pass pipeline: an English base summary, then optional translation to a user-selected output language.

Detailed docs: [docs/architecture.md](docs/architecture.md), [docs/building.md](docs/building.md), [docs/gpu-acceleration.md](docs/gpu-acceleration.md).

The marketing website (muesly.ai) is a separate static Astro project in `site/`, with its own lockfile and deploy. See [site/README.md](site/README.md). Run it with `pnpm -C site install && pnpm -C site dev`; build/check/test with `pnpm -C site build` / `check` / `test`.

## Commands

Run from `app/` (frontend deps install separately in `app/src-svelte/`, each has its own lockfile):

```bash
pnpm install && pnpm -C src-svelte install

pnpm tauri:dev          # dev mode, auto-detects GPU (scripts/tauri-auto.ts)
pnpm tauri:build        # production build, auto-detects GPU
pnpm tauri:dev:cpu      # explicit backend: cpu, metal, coreml, cuda, vulkan, openblas, hipblas
                        # (same suffixes exist for tauri:build:*)

pnpm -C src-svelte dev    # frontend only (Vite, port 1420, strict)
pnpm -C src-svelte check  # svelte-check + TypeScript
```

Override GPU auto-detection with the `TAURI_GPU_FEATURE` env var. Rust checks run from the repo root (Cargo workspace: `app/src-tauri` + `llama-helper`): `cargo check`, `cargo test`.

## Architecture Notes

- **IPC**: Frontend calls Rust via `invoke('command_name', args)`. Commands are registered in `app/src-tauri/src/lib.rs`. Rust pushes updates to the frontend via `app.emit(...)` events (e.g. `transcript-update`).
- **Dual-path audio pipeline** (`app/src-tauri/src/audio/pipeline.rs`): raw mic + system audio are split into a recording path (RMS-based ducking, professional mixing, clipping prevention) and a transcription path (VAD-filtered, only speech segments reach the transcription engine).
- **Module map**: `audio/` (capture, devices, mixing, VAD, recording), `whisper_engine/` and `parakeet_engine/` (transcription), `summary/` (LLM providers + templates), `database/` (sqlx repositories, migrations in `database/setup.rs`). Frontend state lives in Svelte stores under `app/src-svelte/src/lib/stores/`.

## Conventions

- Rust errors: `anyhow::Result` internally, `Result<_, String>` at Tauri command boundaries.
- Audio naming: always "microphone" and "system", never "input"/"output".
- Hot-path logging: use the `perf_debug!` macro (zero cost in release builds), not `log::debug!`.
- File paths: use Tauri path APIs (`app_data_dir`, etc.). Never hardcode paths.
- Class merging: `cn()` is re-exported from `cnfast` (drop-in for `clsx` + `tailwind-merge`, ~3.8x faster, byte-identical) in `app/src-svelte/src/lib/utils.ts`. Always merge conditional/variant classes with `cn()`, never template-literal ternaries; don't import `clsx` directly. (`tailwind-merge` stays in deps only because shadcn's `tailwind-variants` requires it — don't use it directly.)
- UI components: built with **shadcn-svelte** (bits-ui underneath), as source under `app/src-svelte/src/lib/components/ui/`. **Reuse, don't reinvent — before building ANY UI, check whether a component already exists.** Look first in `src/lib/components/ui/` (installed primitives), then `src/lib/components/` (composed feature components), then the shadcn-svelte registry (`bunx --bun shadcn-svelte@latest add` to browse). Never hand-roll markup a primitive already provides (`<button>`→`Button`, custom input→`Input`, card `div`→`Card`, dropdown→`DropdownMenu`/`Select`, modal→`Dialog`, callout→`Alert`, `<hr>`→`Separator`). Only write a new component when none exists — and prefer adding it from the registry over custom markup. Compose with built-in `variant`/`size` props and semantic tokens (`bg-primary`, `text-muted-foreground`, `text-destructive`), never raw palette colors (`green-500`). Follow the `shadcn-svelte` skill for the full conventions (imports, Card/Tabs/Field composition, `data-icon` on button icons, `gap-*` over `space-*`).
- Documentation: when a change affects commands, architecture, or behavior described in this file, `docs/`, or `README.md`, update those docs in the same change.

## Gotchas

- **macOS system audio**: capture uses a CoreAudio process tap (macOS 14.4+) and requires the **System Audio Recording** permission (System Settings → Privacy & Security → Screen & System Audio Recording). Without it the tap silently records zeros, no error, no segments. `pnpm tauri:dev` binaries do not trigger the consent prompt (TCC attributes CLI-launched processes to the terminal), so grant the permission to your terminal app or test with a bundled build. The backend preflights via TCC SPI and emits `system-audio-permission-missing` at recording start when denied.
- **Sample rate**: the pipeline expects 48kHz throughout; resampling happens at capture time.
- **Model caching**: Whisper/Parakeet models load once and stay cached; switching models requires unload/reload. Models live in the app data dir in production and a local dir in dev (see `whisper_engine.rs::new_with_models_dir`).
- **Windows**: WASAPI exclusive mode can conflict with other apps; system capture uses WASAPI loopback.

## Debugging

```bash
RUST_LOG=debug pnpm tauri:dev               # all Rust logs
RUST_LOG=app_lib::audio=debug pnpm tauri:dev  # audio pipeline only
```

DevTools: `Cmd+Shift+I` (macOS) / `Ctrl+Shift+I` (Windows). The app shows real-time audio metrics while recording.
We are currently working purely on main. When ready, we will switch to a feature branching model.
