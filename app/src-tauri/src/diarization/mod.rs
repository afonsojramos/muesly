//! On-device speaker diarization.
//!
//! Diarization runs in a separate `diarization-helper` process: it owns
//! `sherpa-onnx` and its statically-linked ONNX Runtime, which would otherwise
//! collide with the main app's `ort` link (Parakeet). This module resolves and
//! drives that sidecar ([`client`]), reconciles its speaker turns onto
//! transcript segments ([`reconcile`]), manages the model files ([`model`]), and
//! exposes the Tauri [`commands`].

pub mod client;
pub mod commands;
pub mod model;
pub mod reconcile;
