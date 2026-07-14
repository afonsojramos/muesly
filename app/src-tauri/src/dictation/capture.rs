//! Microphone capture for a dictation burst.
//!
//! A cpal `Stream` is `!Send`, so it cannot be held across `.await` or moved
//! between threads. This confines the stream to a dedicated OS thread (the same
//! approach the echo canceller uses): the thread builds the input stream, the
//! cpal callback appends downmixed-to-mono samples to a shared buffer, and the
//! thread keeps the stream alive until a stop signal arrives, then returns the
//! captured samples and their sample rate over a channel.

use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

use anyhow::{Result, anyhow};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat, StreamConfig};

/// Downmix an interleaved `channels`-channel buffer to mono by averaging each
/// frame. Returns the input unchanged when already mono. Pure, so it is tested.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// A running microphone capture confined to its own thread.
pub struct DictationCapture {
    stop_tx: Sender<()>,
    done_rx: Receiver<(Vec<f32>, u32)>,
}

impl DictationCapture {
    /// Start capturing the default input device. Returns once the stream is live
    /// (so a too-soon `stop` still yields whatever was captured).
    pub fn start() -> Result<Self> {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<(Vec<f32>, u32)>();
        // Surface build errors synchronously to the caller.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<std::result::Result<(), String>>();

        std::thread::Builder::new()
            .name("dictation-capture".into())
            .spawn(move || {
                let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
                let sample_rate = match build_and_play(buffer.clone()) {
                    Ok((stream, sr)) => {
                        let _ = ready_tx.send(Ok(()));
                        // Hold the (!Send) stream alive on this thread until stop.
                        let _ = stop_rx.recv();
                        drop(stream);
                        sr
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let samples = buffer.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let _ = done_tx.send((samples, sample_rate));
            })
            .map_err(|e| anyhow!("failed to spawn dictation capture thread: {e}"))?;

        ready_rx
            .recv()
            .map_err(|_| anyhow!("dictation capture thread exited during init"))?
            .map_err(|e| anyhow!("{e}"))?;
        Ok(Self { stop_tx, done_rx })
    }

    /// Stop capturing and return `(mono samples, sample_rate)`.
    pub fn stop(self) -> Result<(Vec<f32>, u32)> {
        let _ = self.stop_tx.send(());
        self.done_rx
            .recv()
            .map_err(|_| anyhow!("dictation capture thread did not return samples"))
    }
}

/// Build and start the default-input stream, appending downmixed-to-mono samples
/// to `buffer`. Returns the live stream (kept alive by the caller) and its rate.
fn build_and_play(buffer: Arc<Mutex<Vec<f32>>>) -> Result<(cpal::Stream, u32)> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| anyhow!("no default input device"))?;
    let config = device
        .default_input_config()
        .map_err(|e| anyhow!("default input config: {e}"))?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let stream_config: StreamConfig = config.clone().into();
    let err_fn = |e| log::error!("dictation capture stream error: {e}");

    let append = move |samples: Vec<f32>, buffer: &Arc<Mutex<Vec<f32>>>| {
        let mono = downmix_to_mono(&samples, channels);
        buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend_from_slice(&mono);
    };

    let stream = match config.sample_format() {
        SampleFormat::F32 => {
            let buf = buffer.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| append(data.to_vec(), &buf),
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    append(data.iter().map(|&s| s.to_sample()).collect(), &buf)
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    append(data.iter().map(|&s| s.to_sample()).collect(), &buf)
                },
                err_fn,
                None,
            )
        }
        other => return Err(anyhow!("unsupported sample format: {other:?}")),
    }
    .map_err(|e| anyhow!("build input stream: {e}"))?;

    stream.play().map_err(|e| anyhow!("play stream: {e}"))?;
    Ok((stream, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_passthrough() {
        let data = [0.1f32, -0.2, 0.3];
        assert_eq!(downmix_to_mono(&data, 1), data);
    }

    #[test]
    fn stereo_averages_each_frame() {
        // [L0,R0, L1,R1] with channels=2 -> [(L0+R0)/2, (L1+R1)/2]
        let data = [1.0f32, 0.0, 0.5, -0.5];
        assert_eq!(downmix_to_mono(&data, 2), vec![0.5, 0.0]);
    }
}
