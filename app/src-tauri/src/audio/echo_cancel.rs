//! Acoustic echo cancellation, transcription path only.
//!
//! Wraps the pure-Rust `aec3` LinearPipeline (a WebRTC AEC3 port). The recorded
//! WAV is never touched: AEC runs on the microphone window that feeds the VAD /
//! transcription engine, using the time-aligned system-audio window as the
//! far-end reference. It is a deliberate no-op when the reference is silent or
//! near-silent (headphones, or a system tap that captures post-volume audio that
//! is near-silent at low output volume), so it can never corrupt the mic when there is nothing to
//! cancel. On any internal error it passes the mic through unchanged.

use aec3::nodes::audio::AudioFormat;
use aec3::pipelines::linear::{self, LinearPipeline};
use anyhow::Result;

/// Hardware path delay seed between played audio and its echo in the mic. The
/// ring buffer already time-aligns the two windows, so we start at 0 and leave
/// fine delay tuning to a later pass.
const INITIAL_DELAY_MS: i32 = 0;

/// Below this RMS the far-end reference carries no usable echo to cancel; pass
/// the mic through untouched rather than risk corrupting it. Covers headphones
/// (silent system tap) and the low-volume tap case.
const FAR_END_RMS_FLOOR: f32 = 1e-4;

/// Stateful echo canceller. Create one per recording (it adapts over time) and
/// feed successive windows through [`EchoCanceller::process`].
pub struct EchoCanceller {
    pipeline: LinearPipeline,
    /// Samples per 10ms frame for the configured sample rate (480 at 48kHz).
    frame_samples: usize,
}

impl EchoCanceller {
    /// Build a mono AEC pipeline at `sample_rate` (AEC3 expects 16kHz-48kHz).
    pub fn new(sample_rate: u32) -> Result<Self> {
        let format = AudioFormat::ten_ms(sample_rate, 1);
        let pipeline = linear::builder(format, format)
            .initial_delay_ms(INITIAL_DELAY_MS)
            .build()
            .map_err(|e| anyhow::anyhow!("failed to build aec3 linear pipeline: {e:?}"))?;
        Ok(Self {
            pipeline,
            frame_samples: format.sample_count(),
        })
    }

    /// Cancel echo from `mic` using `reference` (system audio) as the far end.
    /// Returns a buffer the same length as `mic`. Falls back to the original mic
    /// samples (passthrough) when the reference is silent or on any internal
    /// error, so transcription audio is never lost or corrupted.
    pub fn process(&mut self, mic: &[f32], reference: &[f32]) -> Vec<f32> {
        if mic.is_empty() {
            return Vec::new();
        }
        // No usable echo reference -> passthrough untouched.
        if rms(reference) < FAR_END_RMS_FLOOR {
            return mic.to_vec();
        }

        let n = self.frame_samples;
        let mut out = Vec::with_capacity(mic.len());
        let mut offset = 0usize;
        while offset < mic.len() {
            let valid = (mic.len() - offset).min(n);
            let mic_frame = padded_frame(mic, offset, n);
            let ref_frame = padded_frame(reference, offset, n);

            // Feed the far-end (render) frame, then process the near-end (capture).
            if self.pipeline.handle_render_frame(&ref_frame).is_err() {
                return mic.to_vec();
            }
            let mut processed = vec![0.0f32; n];
            match self
                .pipeline
                .process_capture_frame(&mic_frame, &mut processed)
            {
                // Cancelled output ready.
                Ok(true) => out.extend_from_slice(&processed[..valid]),
                // Pipeline still filling its latency buffer (only at the very
                // start): keep the original audio rather than emit silence.
                Ok(false) => out.extend_from_slice(&mic_frame[..valid]),
                Err(_) => return mic.to_vec(),
            }
            offset += n;
        }
        out
    }
}

/// A request to the echo-canceller worker thread: cancel `mic` using `reference`,
/// returning the result on `resp`.
struct EchoRequest {
    mic: Vec<f32>,
    reference: Vec<f32>,
    resp: tokio::sync::oneshot::Sender<Vec<f32>>,
}

/// `Send` handle to an [`EchoCanceller`] that lives on its own OS thread.
///
/// `aec3`'s pipeline holds `Rc` internals, so it is `!Send` and cannot be held
/// across `.await` points in the async audio pipeline. This handle confines the
/// canceller to a dedicated thread and exchanges `Send` audio buffers over
/// channels, so the async side can `.await` a cancelled window without the
/// `!Send` state ever crossing a thread boundary. The worker thread exits when
/// this handle is dropped (the request channel closes).
pub struct EchoCancellerHandle {
    req_tx: tokio::sync::mpsc::UnboundedSender<EchoRequest>,
}

impl EchoCancellerHandle {
    /// Spawn the worker thread and build the canceller on it. Returns an error
    /// if the thread cannot spawn or the pipeline fails to build, so the caller
    /// can fall back to raw mic audio.
    pub fn spawn(sample_rate: u32) -> Result<Self> {
        let (req_tx, mut req_rx) = tokio::sync::mpsc::unbounded_channel::<EchoRequest>();
        // Handshake so build failures surface synchronously to the caller.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();

        std::thread::Builder::new()
            .name("echo-canceller".into())
            .spawn(move || {
                let mut canceller = match EchoCanceller::new(sample_rate) {
                    Ok(c) => {
                        let _ = ready_tx.send(Ok(()));
                        c
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                // Process windows until the handle (and thus the sender) drops.
                while let Some(req) = req_rx.blocking_recv() {
                    let out = canceller.process(&req.mic, &req.reference);
                    let _ = req.resp.send(out);
                }
            })
            .map_err(|e| anyhow::anyhow!("failed to spawn echo-canceller thread: {e}"))?;

        ready_rx
            .recv()
            .map_err(|_| anyhow::anyhow!("echo-canceller thread exited during init"))?
            .map_err(|e| anyhow::anyhow!("{e}"))?;

        Ok(Self { req_tx })
    }

    /// Echo-cancel `mic` using `reference` on the worker thread. Falls back to
    /// the original mic samples if the worker is gone, so transcription audio is
    /// never lost.
    pub async fn process(&self, mic: Vec<f32>, reference: Vec<f32>) -> Vec<f32> {
        let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
        let fallback = mic.clone();
        if self
            .req_tx
            .send(EchoRequest {
                mic,
                reference,
                resp: resp_tx,
            })
            .is_err()
        {
            return fallback;
        }
        resp_rx.await.unwrap_or(fallback)
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Copy `frame_samples` from `samples` starting at `offset`, zero-padding the
/// tail when fewer remain. Always returns exactly `frame_samples` samples.
fn padded_frame(samples: &[f32], offset: usize, frame_samples: usize) -> Vec<f32> {
    let mut frame = vec![0.0f32; frame_samples];
    if offset < samples.len() {
        let count = (samples.len() - offset).min(frame_samples);
        frame[..count].copy_from_slice(&samples[offset..offset + count]);
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    #[test]
    fn silent_reference_is_passthrough() {
        let mut aec = EchoCanceller::new(SR).expect("build");
        let mic: Vec<f32> = (0..1000).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        let reference = vec![0.0f32; 1000];
        let out = aec.process(&mic, &reference);
        assert_eq!(
            out, mic,
            "a silent reference must pass the mic through unchanged"
        );
    }

    #[test]
    fn output_length_matches_input_for_unaligned_window() {
        let mut aec = EchoCanceller::new(SR).expect("build");
        // 1000 is not a multiple of the 480-sample frame.
        let mic: Vec<f32> = (0..1000).map(|i| ((i as f32) * 0.02).sin() * 0.3).collect();
        let reference: Vec<f32> = (0..1000).map(|i| ((i as f32) * 0.03).sin() * 0.3).collect();
        let out = aec.process(&mic, &reference);
        assert_eq!(out.len(), mic.len(), "no samples may be dropped or added");
    }

    #[test]
    fn empty_mic_returns_empty() {
        let mut aec = EchoCanceller::new(SR).expect("build");
        assert!(aec.process(&[], &[0.1, 0.2]).is_empty());
    }

    #[test]
    fn active_path_changes_the_mic_signal() {
        // Complement of the passthrough test: with a loud reference, AEC must
        // actually alter the mic window. This is what makes the transcription
        // path (mic_for_vad) genuinely diverge from the recording path (which
        // uses the raw mic window), so the recorded WAV stays untouched.
        let mut aec = EchoCanceller::new(SR).expect("build");
        let len = (SR as usize) * 2;
        let mic: Vec<f32> = (0..len).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
        let reference = mic.clone();
        let out = aec.process(&mic, &reference);
        assert_eq!(out.len(), mic.len());
        assert!(
            out != mic,
            "AEC with a loud reference must change the mic signal"
        );
    }

    #[test]
    fn output_is_always_finite() {
        // Whatever the filter does during adaptation, it must never emit NaN/Inf
        // into the transcription path.
        let mut aec = EchoCanceller::new(SR).expect("build");
        let len = SR as usize;
        let echo: Vec<f32> = (0..len).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
        let out = aec.process(&echo, &echo);
        assert_eq!(out.len(), echo.len());
        assert!(out.iter().all(|s| s.is_finite()), "output must be finite");
    }

    #[test]
    fn cancels_steady_state_echo_once_converged() {
        // mic == reference (pure echo, no near-end speech). An adaptive filter
        // overshoots during the first frames, so assert on the CONVERGED tail of
        // a multi-second run (a meeting runs for minutes): the echo energy there
        // must be reduced versus the raw echo, not amplified.
        let mut aec = EchoCanceller::new(SR).expect("build");
        let len = (SR as usize) * 6; // ~6s, enough for AEC3 to lock
        let echo: Vec<f32> = (0..len).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect();
        let out = aec.process(&echo, &echo);
        assert_eq!(out.len(), echo.len());

        // Compare the last 25% (converged) of output against the same slice of input.
        let tail = len - len / 4..len;
        let in_tail = rms(&echo[tail.clone()]);
        let out_tail = rms(&out[tail]);
        assert!(
            out_tail < in_tail,
            "converged AEC must reduce steady-state echo (in_tail={in_tail}, out_tail={out_tail})"
        );
    }
}
