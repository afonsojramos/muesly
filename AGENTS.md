## Project Overview

**muesly** is private speech-to-text for everything you say, capturing, transcribing, and summarizing entirely on local infrastructure. It is a single-process Tauri 2 desktop app; recording, transcription, and summarization all run locally with no backend in the data path.

- **Frontend**: SvelteKit 2 + Svelte 5 (runes) + Tailwind 4, in `app/src-svelte/`
- **Core**: Rust (Tauri), in `app/src-tauri/`
- **Transcription**: whisper-rs (whisper.cpp) and Parakeet (ONNX Runtime), in-process, GPU-accelerated
- **Storage**: SQLite via sqlx, owned by the Rust side
- **Summarization**: local Qwen 3.5 / Gemma GGUF via the `llama-helper` sidecar, or cloud providers. Summaries use a two-pass pipeline: an English base summary, then optional translation to a user-selected output language.

Detailed docs: [docs/architecture.md](docs/architecture.md), [docs/building.md](docs/building.md), [docs/gpu-acceleration.md](docs/gpu-acceleration.md), [docs/transcription-flows.md](docs/transcription-flows.md) (mermaid diagrams of every transcription/diarization/summary flow — update the matching diagram whenever one of those pipelines changes).

The marketing website (muesly.ai) is a separate static Astro project in `site/`, with its own lockfile and deploy. See [site/README.md](site/README.md). Run it with `nub --cwd site install && nub --cwd site run dev`; build/check/test with `nub --cwd site run build` / `check` / `test`.

The `api/` directory is a small Cloudflare Worker + D1 (schema managed with Drizzle) at `api.muesly.ai`. It stores only anonymous, aggregate "muesly bar" popularity counts (public `builtin:`/`imported:` catalog ids, never user data). See [api/README.md](api/README.md); it deploys via GitHub Actions on push to `main`, or `nub run release` from `api/`.

## Toolchain: mise + nub

The dev toolchain — **node**, **pnpm**, and **nub** — is pinned in `mise.toml`. Run `mise install` (or let mise auto-install on `cd`) to provision it; no separate `brew`/`corepack` setup.

This repo augments Node with **nub** — one Rust CLI that runs TS/JS directly, runs scripts, replaces `npx`, manages packages, and provisions Node, all on the project's real Node and reading/writing the existing pnpm lockfiles (nothing migrates; plain `node`/`pnpm` still work). Prefer it for everyday commands:

| Instead of | Use |
| --- | --- |
| `node file.ts` / `tsx` | `nub file.ts` |
| `npm run <s>` / `pnpm run <s>` | `nub run <s>` |
| `npx <t>` / `pnpm dlx <t>` | `nubx <t>` |
| `pnpm install` | `nub install` |
| `pnpm add` / `remove <p>` | `nub add` / `remove <p>` |

From `app/`, `nub run tauri:dev` / `tauri:build` run the GPU auto-detect TypeScript (`scripts/tauri-auto.ts`); the explicit `:cpu`/`:metal`/… variants skip it. Use `nub --node <file>` for strict, unaugmented Node. Full reference: the `nub` skill or `nub agent docs`.

**nub is the installer for all three projects** (`nub install` / `nub add`). It reads and writes the same `pnpm-lock.yaml`, so pnpm stays a drop-in fallback. CI provisions the toolchain with `jdx/mise-action` (from `mise.toml`) and installs with `nub install --frozen-lockfile`. One caveat lives in `site/`: nub's default `isolated` (pnpm-style) node_modules layout doesn't dedupe astro's peer types the way pnpm's does, so `astro-icon`'s `<Icon>` loses its HTML-attribute props and `astro check` fails. The fix is committed as `node-linker=hoisted` in `site/.npmrc`, which both nub and pnpm honor, so `nub install` in `site/` just works. `api/` and `app/src-svelte/` use nub's default isolated layout.

## Commands

Run from `app/` (frontend deps install separately in `app/src-svelte/`, each has its own lockfile):

```bash
nub install && nub --cwd src-svelte install

nub run tauri:dev          # dev mode, auto-detects GPU (scripts/tauri-auto.ts)
nub run tauri:build        # production build, auto-detects GPU
nub run tauri:dev:cpu      # explicit backend: cpu, metal, coreml, cuda, vulkan, openblas, hipblas
                           # (same suffixes exist for tauri:build:*)

nub --cwd src-svelte run dev    # frontend only (Vite, port 1420, strict)
nub --cwd src-svelte run check  # svelte-check + TypeScript
nub --cwd src-svelte run lint   # Oxlint + eslint-plugin-better-tailwindcss (via Vite+ `vp`)
nub --cwd src-svelte run format # Oxfmt (via Vite+ `vp`); `format:check` verifies without writing
```

The root `package.json` is script-delegation only (no workspace — each of `app/src-svelte`, `site`, and `api` keeps its own lockfile; `nub run setup` installs all three). From the repo root, `nub run check` / `lint` / `format` / `format:check` fan out to app + `site` + `api` (`api`'s `check` is `typecheck`), and `nub run test` to app + `site`; `nub run dev` / `build` target the app. Lint/format everywhere is oxlint + oxfmt via `vp` (Vite+); `site`/`api` carry a small `vite.config.ts` with the shared `fmt`/`lint` config (oxfmt can't format `.astro`, so site's components are hand-maintained).

Override GPU auto-detection with the `TAURI_GPU_FEATURE` env var. Rust checks run from the repo root (Cargo workspace: `app/src-tauri` + `llama-helper`): `cargo check`, `cargo test`.

Seed fake data into the app's dev database for UI testing (folders, favorites, subfolders, meetings, transcripts, summaries, attendees, notes): `nub run seed` (re-runnable/idempotent, all rows `seed-` prefixed), `nub run seed:clear` to remove it. Source: `app/src-tauri/examples/seed-dev-data.rs`. Navigate away and back in the app to pick up changes.

Lint/format are driven by [Vite+](https://viteplus.dev) (`vp`) and configured in `app/src-svelte/vite.config.ts` under the `lint` / `fmt` keys (Tailwind linting via `eslint-plugin-better-tailwindcss` as an Oxlint JS plugin, pointed at `src/app.css`). Requires the `vp` CLI on PATH. The shadcn-svelte primitives in `src/lib/components/ui/**` are excluded from lint (verbatim registry source).

## Architecture Notes

- **IPC**: Frontend calls Rust via `invoke('command_name', args)`. Commands are registered in `app/src-tauri/src/lib.rs`. Rust pushes updates to the frontend via `app.emit(...)` events (e.g. `transcript-update`).
- **Dual-path audio pipeline** (`app/src-tauri/src/audio/pipeline.rs`): raw mic + system audio are split into a recording path (RMS-based ducking, professional mixing, clipping prevention) and a transcription path (VAD-filtered, only speech segments reach the transcription engine).
- **Module map**: `audio/` (capture, devices, mixing, VAD, recording), `whisper_engine/` and `parakeet_engine/` (transcription), `summary/` (LLM providers + templates), `database/` (sqlx repositories; migrations are `.sql` files in `app/src-tauri/migrations/`, applied at startup via `sqlx::migrate!` in `database/manager.rs`). Frontend state lives in Svelte stores under `app/src-svelte/src/lib/stores/`.

## Conventions

- Rust errors: `anyhow::Result` internally, `Result<_, String>` at Tauri command boundaries.
- Audio naming: always "microphone" and "system", never "input"/"output".
- Hot-path logging: use the `perf_debug!` macro (zero cost in release builds), not `log::debug!`.
- File paths: use Tauri path APIs (`app_data_dir`, etc.). Never hardcode paths.
- Class merging: `cn()` is re-exported from `cnfast` (drop-in for `clsx` + `tailwind-merge`, ~3.8x faster, byte-identical) in `app/src-svelte/src/lib/utils.ts`. Always merge conditional/variant classes with `cn()`, never template-literal ternaries; don't import `clsx` directly. (`tailwind-merge` stays in deps only because shadcn's `tailwind-variants` requires it — don't use it directly.)
- UI components: built with **shadcn-svelte** (bits-ui underneath), as source under `app/src-svelte/src/lib/components/ui/`. **Reuse, don't reinvent — before building ANY UI, check whether a component already exists.** Look first in `src/lib/components/ui/` (installed primitives), then `src/lib/components/` (composed feature components), then the shadcn-svelte registry (`bunx --bun shadcn-svelte@latest add` to browse). Never hand-roll markup a primitive already provides (`<button>`→`Button`, custom input→`Input`, card `div`→`Card`, dropdown→`DropdownMenu`/`Select`, modal→`Dialog`, callout→`Alert`, `<hr>`→`Separator`). Only write a new component when none exists — and prefer adding it from the registry over custom markup. Compose with built-in `variant`/`size` props and semantic tokens (`bg-primary`, `text-muted-foreground`, `text-destructive`), never raw palette colors (`green-500`). Follow the `shadcn-svelte` skill for the full conventions (imports, Card/Tabs/Field composition, `data-icon` on button icons, `gap-*` over `space-*`).
- UI feedback: acknowledge user actions optimistically when the request has been accepted, while showing an honest pending state for backend cleanup (for example, switch Stop to “Saving…” immediately while preserving safe finalization). Do not show success toasts when the visible UI already demonstrates success through state, content, or navigation; reserve toasts for errors, background outcomes, or results without an obvious on-screen confirmation. All toasts must be user-dismissible.
- Documentation: when a change affects commands, architecture, or behavior described in this file, `docs/`, or `README.md`, update those docs in the same change.

## Gotchas

- **macOS system audio**: capture uses a CoreAudio process tap (macOS 14.4+) and requires the **System Audio Recording** permission (System Settings → Privacy & Security → Screen & System Audio Recording). Without it the tap silently records zeros, no error, no segments. `nub run tauri:dev` binaries do not trigger the consent prompt (TCC attributes CLI-launched processes to the terminal), so grant the permission to your terminal app or test with a bundled build. The backend preflights via TCC SPI and emits `system-audio-permission-missing` at recording start when denied.
- **Sample rate**: the pipeline expects 48kHz throughout; resampling happens at capture time.
- **Model caching**: Whisper/Parakeet models load once and stay cached; switching models requires unload/reload. Models live in the app data dir in production and a local dir in dev (see `whisper_engine.rs::new_with_models_dir`).
- **Windows**: WASAPI exclusive mode can conflict with other apps; system capture uses WASAPI loopback.

## Debugging

```bash
RUST_LOG=debug nub run tauri:dev               # all Rust logs
RUST_LOG=app_lib::audio=debug nub run tauri:dev  # audio pipeline only
```

DevTools: `Cmd+Shift+I` (macOS) / `Ctrl+Shift+I` (Windows). The app shows real-time audio metrics while recording.
We are currently working purely on main. When ready, we will switch to a feature branching model.
