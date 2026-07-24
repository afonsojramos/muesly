<div align="center">

# muesly

**Private speech-to-text for everything you say**

<a href="https://github.com/afonsojramos/muesly/releases/"><img src="https://img.shields.io/badge/Pre_Release-Link-brightgreen" alt="Pre-Release"></a>
<a href="https://github.com/afonsojramos/muesly/releases"><img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/afonsojramos/muesly?style=flat"></a>
<a href="https://github.com/afonsojramos/muesly/releases"><img alt="GitHub Downloads" src="https://img.shields.io/github/downloads/afonsojramos/muesly/total?style=flat"></a>
<a href="LICENSE.md"><img src="https://img.shields.io/badge/License-PolyForm_Noncommercial-blue" alt="License"></a>
<a href="https://github.com/afonsojramos/muesly/releases"><img src="https://img.shields.io/badge/Supported_OS-macOS,_Windows,_Linux-white" alt="Supported OS"></a>
<a href="https://github.com/afonsojramos/muesly/releases"><img alt="GitHub Tag" src="https://img.shields.io/github/v/tag/afonsojramos/muesly?include_prereleases&color=yellow"></a>

Capture, transcribe, and summarize everything you say, entirely on your own machine. No cloud, no server, no account, just a single self-contained desktop app.

</div>

---

## Why muesly?

- **Speech-to-text for everything.** Meetings, dictation, calls, lectures — not a meeting-only tool. Capture what you say and what others say through the system.
- **Local first.** Audio capture, transcription, and (by default) summarization all run on your device. Nothing leaves your machine unless you explicitly pick a cloud model.
- **Yours to keep.** Recordings, transcripts, and summaries live in a local SQLite database you can export or delete at any time. No vendor lock-in.
- **Flexible AI.** Summarize with the built-in local model, your own Ollama server, or a cloud provider (Anthropic Claude, OpenAI, Groq, xAI Grok, OpenRouter, or any OpenAI-compatible endpoint).
- **Cross-platform.** macOS, Windows, and Linux.

## Features

- **Local transcription** using Whisper models, GPU-accelerated and in-process, with a model selected for your hardware.
- **Real-time transcript** as you speak, with optional named speaker labels after diarization.
- **Dual audio capture** of microphone and system audio at once, with professional mixing (ducking, clipping prevention) and voice-activity filtering so only speech reaches the transcription engine.
- **AI summaries and Ask anything chat** generated locally by default, with optional translation and cloud BYOK. Cross-meeting questions use on-device hybrid search (keyword + semantic embeddings).
- **Calendar-aware recording** (upcoming meetings, record prompts when meetings start, folders) and push-to-talk dictation.
- **Import & enhance** `Beta`: bring in existing audio files, or re-transcribe a recording with a different model or language, all processed locally.
- **GPU acceleration**, auto-detected at build time: Metal + CoreML (macOS), CUDA / Vulkan (Windows/Linux).

## Installation

Download the latest build for your platform from [Releases](https://github.com/afonsojramos/muesly/releases/latest), or build from source ([guide](docs/building.md)):

```bash
git clone https://github.com/afonsojramos/muesly
cd muesly/app
nub install && nub --cwd src-svelte install
nub run tauri:build
```

## Architecture

muesly is a single, self-contained Tauri 2 desktop app:

- **UI:** SvelteKit + Svelte 5 + Tailwind (TypeScript)
- **Core:** Rust, audio capture (cpal), transcription (whisper-rs), summarization (local Qwen / Gemma via the `llama-helper` sidecar, plus optional cloud providers)
- **Storage:** local SQLite via sqlx
- **No backend service, no Docker, no Python.** Everything runs in one process.

See [docs/architecture.md](docs/architecture.md) for details, [docs/building.md](docs/building.md) to build from source, [docs/gpu-acceleration.md](docs/gpu-acceleration.md) for hardware acceleration, and [docs/transcription-models.md](docs/transcription-models.md) for the model-catalog rationale.

## Contributing

Contributions are welcome, open an issue or a pull request.

Import & enhance was contributed by [Jeremi Joslin](https://github.com/jeremi) and improved by [Vishnu P S](https://github.com/p-s-vishnu) and [Mohammed Safvan](https://github.com/mohammedsafvan).

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free for personal and noncommercial use; commercial use requires a separate license from the author.

## Acknowledgments

- Code borrowed from [whisper.cpp](https://github.com/ggerganov/whisper.cpp), [Screenpipe](https://github.com/mediar-ai/screenpipe), and [transcribe-rs](https://crates.io/crates/transcribe-rs).
