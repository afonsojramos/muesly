# Transcription model catalog

Last reviewed: 2026-07-16

Muesly does not bundle ASR weights in the application binary. "Shipped" below
means an artifact the app knows how to discover, download, verify, and run
locally. Downloads are opt-in and remain on the user's device.

## Decision

Keep the current two-engine strategy:

- **Automatic / recommended:** quantized Whisper models selected by hardware
  tier. Base Q5_1, Small Q5_1, and Large v3 Turbo Q5_0 are sensible download and
  memory trade-offs for live transcription.
- **Highest quality:** Large v3 Q5_0. Keep full Large v3 supported for existing
  downloads, but do not make its 2.9 GiB artifact a primary profile.
- **Fastest:** Parakeet TDT 0.6B v3 INT8. It is a strong 25-language CPU option,
  not a universally lower-quality Whisper substitute.
- **Legacy:** Parakeet v2 remains discoverable only when already installed. It
  is English-only and is no longer offered for download.

Do not add another engine to the product catalog yet. Qwen3-ASR 0.6B deserves a
fixture-based spike because it covers 52 languages and dialects, but its own
published multilingual results do not consistently beat Whisper Large v3 and
the app has no Qwen ASR runtime today.

## Current artifacts

The quality labels are product tiers, not universal benchmark grades. Whisper
accuracy varies materially by language and audio domain; quantized artifacts
also lack an upstream, apples-to-apples WER table.

| Artifact | Download | Product role | Decision |
| --- | ---: | --- | --- |
| `tiny` | 75 MiB | Full-precision compatibility | Keep supported, hidden unless installed |
| `tiny-q5_1` | 31 MiB | Smallest fallback | Keep supported |
| `base` | 142 MiB | Full-precision compatibility | Keep supported, hidden unless installed |
| `base-q5_1` | 57 MiB | Low-tier recommendation | Keep |
| `small` | 466 MiB | Full-precision compatibility | Keep supported, hidden unless installed |
| `small-q5_1` | 181 MiB | Medium-tier recommendation / faster profile | Keep |
| `medium` | 1.5 GiB | Full-precision compatibility and translation | Keep supported, hidden unless installed |
| `medium-q5_0` | 514 MiB | Translation-capable fallback | Keep supported |
| `large-v3-turbo` | 1.5 GiB | Full-precision Turbo compatibility | Keep supported; never use for translation |
| `large-v3-turbo-q5_0` | 547 MiB | High/Ultra recommendation | Keep; never use for translation |
| `large-v3` | 2.9 GiB | Maximum full-precision Whisper quality | Keep supported, hidden unless installed |
| `large-v3-q5_0` | 1.1 GiB | Highest-quality profile / high-tier translation | Keep |
| `parakeet-tdt-0.6b-v3-int8` | about 640 MiB | Fastest profile, 25 European languages | Keep |
| `parakeet-tdt-0.6b-v2-int8` | about 630 MiB | Installed legacy, English only | Do not download; preserve discovery/removal |

The Whisper sizes match the official whisper.cpp model inventory. OpenAI lists
the underlying families at 39M (Tiny), 74M (Base), 244M (Small), 769M
(Medium), 1.55B (Large), and 809M (Turbo) parameters. Its published relative
speeds are hardware- and language-dependent; they should not be presented as
fixed Muesly speed multipliers.

Sources:

- [OpenAI Whisper model sizes, speed caveat, and Turbo translation limitation](https://github.com/openai/whisper/blob/main/README.md#available-models-and-languages)
- [whisper.cpp converted artifact sizes](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md#available-models)
- [whisper.cpp quantization behavior](https://github.com/ggml-org/whisper.cpp#quantization)

## Whisper findings

Whisper remains the right broad-coverage engine for Muesly. It supports
language detection, explicit language selection, translation to English,
prompting, and confidence signals that the app uses for custom vocabulary,
language-lock repair, continuity, and hallucination filtering.

Turbo is the important exception. OpenAI describes it as an optimized Large v3
with minimal transcription degradation, but explicitly says it is not trained
for translation and returns the original language even when translation is
requested. Automatic therefore excludes both Turbo artifacts when the task is
`auto-translate`; manual incompatible choices fail with a clear error.

Q5 artifacts remain the right defaults because whisper.cpp documents their
lower disk and memory requirements and possible hardware-efficiency benefit.
There is no upstream evidence for the old UI claim that a given Q5 artifact is
"~50% faster," so catalog copy avoids numerical promises until Muesly has
per-backend benchmarks.

Whisper code and weights are MIT licensed. Downloads use a pinned whisper.cpp
Hugging Face revision plus pinned SHA-256 values for every artifact.

## Parakeet findings

NVIDIA Parakeet TDT 0.6B v3 is a 600M-parameter FastConformer-TDT model. It
auto-detects and transcribes 25 European languages, emits punctuation and
capitalization, and is CC BY 4.0 licensed. NVIDIA reports 11.31% WER on AMI
meetings and 6.34% average WER on the English Open ASR Leaderboard for the
original model. These figures are not directly comparable to every Whisper
size, nor do they validate Muesly's community INT8 ONNX conversion, but they do
invalidate a universal "less accurate than Whisper" label.

Muesly's Parakeet path is intentionally narrower than Whisper's:

- no manual language forcing or translation;
- no custom-vocabulary prompting or prior-segment prompt;
- no confidence exposed to Muesly's segment gate;
- greedy TDT decoding of short VAD segments rather than native streaming.

The active ONNX files are a community export of NVIDIA's official checkpoint,
not an NVIDIA-published ONNX package. The exporter publishes the NeMo export
recipe and an MIT runtime. Muesly pins the repository revision and each file's
SHA-256. An official k2-fsa/sherpa-onnx conversion exists, but its separate
encoder/decoder/joiner layout is not compatible with Muesly's current custom
ONNX loader; adopting it is an engine migration, not a URL swap.

Sources:

- [NVIDIA Parakeet v3 model card, languages, license, and evaluations](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
- [NVIDIA Parakeet v2 model card (English-only predecessor)](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
- [Current ONNX export and reproducible export recipe](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)
- [k2-fsa Parakeet v3 INT8 conversion layout](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html)

## Local end-to-end evidence

The checked-in 27-second public-domain fixture was run through the real decode,
VAD, engine, and segment-filter path on 2026-07-16:

| Engine artifact | WER | Silence result |
| --- | ---: | --- |
| `large-v3-turbo-q5_0` | 0.00% | Not rerun in this audit |
| `parakeet-tdt-0.6b-v3-int8` | 1.85% | 0 VAD segments / no text |

This clean English clip is a regression smoke test, not evidence that one
engine is generally more accurate. The repository now ships a local-only,
consent-aware corpus manifest, privacy-preserving intake procedure, coverage
matrix, real WER/RTF/peak-memory measurement, and transcript-free aggregation.
The actual participant corpus is intentionally not in Git; completing it requires
consented recordings across the target languages and noise conditions. See
`app/scripts/eval/CONSENTED_CORPUS.md`.

## Alternatives reviewed

Qwen3-ASR 0.6B is the most relevant future candidate: the official model
supports 52 languages/dialects, language identification, timestamps, and
streaming via its vLLM backend, and sherpa-onnx now has an INT8 export. However,
Qwen's own table shows the 0.6B model behind Whisper Large v3 on several
multilingual aggregates. It should be benchmarked as an additional broad-
language engine, not adopted from headline coverage alone.

NVIDIA Parakeet Unified 0.6B improves true low-latency streaming, but the
current public model is English-only. Muesly already segments local audio with
VAD, so replacing multilingual v3 would trade away 24 languages for a streaming
architecture the app does not yet exploit.

Sources:

- [Official Qwen3-ASR repository and benchmark tables](https://github.com/QwenLM/Qwen3-ASR)
- [sherpa-onnx Qwen3-ASR support](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md)
- [NVIDIA Parakeet Unified English model card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b)
