// Sidecar process lifecycle management for llama-helper
// Handles spawning, health checking, keep-alive, and graceful shutdown

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, RwLock};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use super::models;

// ============================================================================
// Sidecar State Management
// ============================================================================

/// The sidecar protocol version this app expects. Must match `PROTOCOL_VERSION`
/// in `llama-helper/src/main.rs`. Version 1 = pre-streaming binaries (bare
/// `{"type":"pong"}`); version 2 added incremental `Token` streaming.
const EXPECTED_SIDECAR_PROTOCOL: u64 = 2;

/// The sidecar's protocol version from a pong payload. Pre-versioning binaries
/// send no field — read as version 1.
fn pong_protocol_version(pong: &serde_json::Value) -> u64 {
    pong.get("protocol_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(1)
}

/// Warn (once per app run) when the sidecar binary speaks an older protocol
/// than this app expects. A stale binary fails SOFT — e.g. a pre-streaming
/// binary silently answers streaming requests in one bulk response — so
/// without this the mismatch is invisible.
fn warn_once_on_stale_protocol(version: u64) {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if version < EXPECTED_SIDECAR_PROTOCOL && !WARNED.swap(true, Ordering::Relaxed) {
        log::warn!(
            "llama-helper sidecar speaks protocol v{version} but the app expects v{EXPECTED_SIDECAR_PROTOCOL} — \
             the binary in src-tauri/binaries/ is stale (features like token streaming degrade silently). \
             Rebuild it: cargo build --release -p llama-helper --features metal, then copy to binaries/."
        );
    }
}

/// Sidecar process manager with keep-alive and health monitoring
pub struct SidecarManager {
    /// Child process handle
    child_process: Arc<Mutex<Option<Child>>>,

    /// Stdin writer for sending requests
    stdin_writer: Arc<Mutex<Option<ChildStdin>>>,

    /// Stdout reader for receiving responses
    stdout_reader: Arc<Mutex<Option<BufReader<ChildStdout>>>>,

    /// Serializes whole request/response exchanges on the sidecar's stdio. The
    /// stdin and stdout locks alone are per-half, so without this a second
    /// caller could interleave its request between another caller's write and
    /// read and the two would swap responses.
    exchange_lock: Arc<Mutex<()>>,

    /// Last activity timestamp
    last_activity: Arc<RwLock<Instant>>,

    /// Health status
    is_healthy: Arc<AtomicBool>,

    /// Shutdown flag
    should_shutdown: Arc<AtomicBool>,

    /// Active request count (for graceful shutdown)
    active_request_count: Arc<AtomicUsize>,

    /// Path to llama-helper binary
    helper_binary_path: PathBuf,

    /// Current model path (if loaded)
    current_model_path: Arc<RwLock<Option<PathBuf>>>,

    /// Idle timeout in seconds (configurable via env var)
    idle_timeout_secs: u64,
}

/// RAII guard for tracking active requests
/// Decrements the active request count when dropped
struct RequestGuard {
    counter: Arc<AtomicUsize>,
}

impl RequestGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self { counter }
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

impl SidecarManager {
    /// Create a new sidecar manager
    pub fn new(_app_data_dir: PathBuf) -> Result<Self> {
        let helper_binary_path = Self::resolve_helper_binary()?;

        // Get idle timeout from env var or use default
        let idle_timeout_secs = std::env::var("LLAMA_IDLE_TIMEOUT")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(models::DEFAULT_IDLE_TIMEOUT_SECS);

        log::info!(
            "SidecarManager initialized with idle timeout: {}s",
            idle_timeout_secs
        );
        log::info!("Helper binary path: {}", helper_binary_path.display());

        Ok(Self {
            child_process: Arc::new(Mutex::new(None)),
            stdin_writer: Arc::new(Mutex::new(None)),
            stdout_reader: Arc::new(Mutex::new(None)),
            exchange_lock: Arc::new(Mutex::new(())),
            last_activity: Arc::new(RwLock::new(Instant::now())),
            is_healthy: Arc::new(AtomicBool::new(false)),
            should_shutdown: Arc::new(AtomicBool::new(false)),
            active_request_count: Arc::new(AtomicUsize::new(0)),
            helper_binary_path,
            current_model_path: Arc::new(RwLock::new(None)),
            idle_timeout_secs,
        })
    }

    /// Resolve the path to llama-helper binary
    fn resolve_helper_binary() -> Result<PathBuf> {
        // 1. Check environment variable (dev mode or manual override)
        if let Ok(env_path) = std::env::var("MUESLY_LLAMA_HELPER") {
            if !env_path.is_empty() {
                let path = PathBuf::from(env_path);
                if path.exists() {
                    log::info!(
                        "Using llama-helper from MUESLY_LLAMA_HELPER: {}",
                        path.display()
                    );
                    return Ok(path);
                }
            }
        }

        // In production, Tauri bundles the binary with target triple suffix
        // 2. Check relative to current executable (most reliable for AppImage/bundled apps)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                log::info!(
                    "Searching for llama-helper relative to executable: {}",
                    exe_dir.display()
                );

                // Get the target triple (same logic as before)
                let target_triple = std::env::var("TARGET").unwrap_or_else(|_| {
                    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
                    {
                        "x86_64-unknown-linux-gnu".to_string()
                    }
                    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
                    {
                        "aarch64-unknown-linux-gnu".to_string()
                    }
                    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
                    {
                        "x86_64-apple-darwin".to_string()
                    }
                    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                    {
                        "aarch64-apple-darwin".to_string()
                    }
                    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                    {
                        "x86_64-pc-windows-msvc".to_string()
                    }
                    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
                    {
                        "aarch64-pc-windows-msvc".to_string()
                    }
                    #[cfg(not(any(
                        all(
                            target_os = "linux",
                            any(target_arch = "x86_64", target_arch = "aarch64")
                        ),
                        all(
                            target_os = "macos",
                            any(target_arch = "x86_64", target_arch = "aarch64")
                        ),
                        all(
                            target_os = "windows",
                            any(target_arch = "x86_64", target_arch = "aarch64")
                        )
                    )))]
                    {
                        "unknown".to_string()
                    }
                });

                let binary_name = if cfg!(windows) {
                    format!("llama-helper-{}.exe", target_triple)
                } else {
                    format!("llama-helper-{}", target_triple)
                };

                // Try exact match in exe dir
                let bundled = exe_dir.join(&binary_name);
                if bundled.exists() {
                    log::info!(
                        "Found exact match next to executable: {}",
                        bundled.display()
                    );
                    return Ok(bundled);
                }

                // Fuzzy match in exe dir
                log::info!("Attempting fuzzy match in exe dir: {}", exe_dir.display());
                if let Ok(entries) = std::fs::read_dir(exe_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with("llama-helper") && !name.ends_with(".d") {
                                log::info!(
                                    "Found fuzzy match next to executable: {}",
                                    path.display()
                                );
                                return Ok(path);
                            }
                        }
                    }
                }
            }
        }

        // 3. Check bundled resources (RESOURCE_DIR) - Fallback
        if let Ok(resource_dir) = std::env::var("RESOURCE_DIR") {
            log::info!(
                "Searching for llama-helper in RESOURCE_DIR: {}",
                resource_dir
            );
            let resource_path = PathBuf::from(&resource_dir);
            // Get the target triple again (or we could have shared it, but code duplication is safer for this tool usage)
            let target_triple = std::env::var("TARGET").unwrap_or_else(|_| {
                #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
                {
                    "x86_64-unknown-linux-gnu".to_string()
                }
                // ... (abbreviated for brevity in thought, but must be full in tool)
                #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
                {
                    "aarch64-unknown-linux-gnu".to_string()
                }
                #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
                {
                    "x86_64-apple-darwin".to_string()
                }
                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                {
                    "aarch64-apple-darwin".to_string()
                }
                #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                {
                    "x86_64-pc-windows-msvc".to_string()
                }
                #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
                {
                    "aarch64-pc-windows-msvc".to_string()
                }
                #[cfg(not(any(
                    all(
                        target_os = "linux",
                        any(target_arch = "x86_64", target_arch = "aarch64")
                    ),
                    all(
                        target_os = "macos",
                        any(target_arch = "x86_64", target_arch = "aarch64")
                    ),
                    all(
                        target_os = "windows",
                        any(target_arch = "x86_64", target_arch = "aarch64")
                    )
                )))]
                {
                    "unknown".to_string()
                }
            });

            let binary_name = if cfg!(windows) {
                format!("llama-helper-{}.exe", target_triple)
            } else {
                format!("llama-helper-{}", target_triple)
            };

            let bundled = resource_path.join(&binary_name);
            if bundled.exists() {
                log::info!("Found exact match in RESOURCE_DIR: {}", bundled.display());
                return Ok(bundled);
            }

            // Fuzzy match in RESOURCE_DIR
            if let Ok(entries) = std::fs::read_dir(&resource_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.starts_with("llama-helper") && !name.ends_with(".d") {
                            log::info!("Found fuzzy match in RESOURCE_DIR: {}", path.display());
                            return Ok(path);
                        }
                    }
                }
            }
        } else {
            log::warn!("RESOURCE_DIR environment variable not set");
        }

        // 3. Fallback for dev: try relative paths from workspace (no target triple in dev builds)
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let project_root = PathBuf::from(&manifest_dir)
                .parent()
                .and_then(|p| p.parent())
                .ok_or_else(|| anyhow!("Failed to determine project root"))?
                .to_path_buf();

            let candidates = vec![
                project_root.join("target/release/llama-helper"),
                project_root.join("target/debug/llama-helper"),
                project_root.join("target/release/llama-helper.exe"),
                project_root.join("target/debug/llama-helper.exe"),
            ];

            for candidate in candidates {
                if candidate.exists() {
                    log::info!("Using dev llama-helper: {}", candidate.display());
                    return Ok(candidate);
                }
            }
        }

        Err(anyhow!(
            "llama-helper binary not found. Build with 'cd llama-helper && cargo build --release' or set MUESLY_LLAMA_HELPER env var."
        ))
    }

    /// Ensure sidecar is running, spawn if needed
    pub async fn ensure_running(&self, model_path: PathBuf) -> Result<()> {
        // Check if already running with correct model
        {
            let current_model = self.current_model_path.read().await;
            if current_model.as_ref() == Some(&model_path) && self.is_healthy() {
                log::debug!("Sidecar already running with correct model");
                self.update_activity().await;
                return Ok(());
            }
        }

        // Need to spawn or restart
        self.spawn(model_path).await
    }

    /// Spawn the sidecar process
    async fn spawn(&self, model_path: PathBuf) -> Result<()> {
        // Shutdown existing process if running
        self.shutdown().await?;

        log::info!("Spawning llama-helper sidecar");
        log::info!("Model path: {}", model_path.display());

        #[cfg(unix)]
        let mut command = tokio::process::Command::new("nice");

        #[cfg(not(unix))]
        let mut command = tokio::process::Command::new(&self.helper_binary_path);

        #[cfg(unix)]
        command.arg("-n").arg("10").arg(&self.helper_binary_path);

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // Log stderr to main process
            // Guarantee the helper is reaped if the `Child` handle is ever dropped
            // without an explicit kill (panic, aborted drain task, abrupt exit),
            // preventing orphaned llama-helper processes.
            .kill_on_drop(true)
            .env("LLAMA_IDLE_TIMEOUT", self.idle_timeout_secs.to_string());

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;

            command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        }

        let mut child = command.spawn().with_context(|| {
            format!(
                "Failed to spawn llama-helper at {:?}",
                self.helper_binary_path
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Failed to get stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Failed to get stdout"))?;

        // Store handles
        {
            let mut child_lock = self.child_process.lock().await;
            *child_lock = Some(child);
        }

        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            *stdin_lock = Some(stdin);
        }

        {
            let mut stdout_lock = self.stdout_reader.lock().await;
            *stdout_lock = Some(BufReader::new(stdout));
        }

        // Update state
        {
            let mut current_model = self.current_model_path.write().await;
            *current_model = Some(model_path);
        }

        self.is_healthy.store(true, Ordering::SeqCst);
        self.should_shutdown.store(false, Ordering::SeqCst);
        self.update_activity().await;

        log::info!("Sidecar spawned successfully");

        // Start background tasks
        self.start_health_check_loop();
        self.start_idle_check_loop();

        Ok(())
    }

    /// Send a request to the sidecar and wait for response
    pub async fn send_request(&self, request_json: String, timeout: Duration) -> Result<String> {
        // Track active request
        let _guard = RequestGuard::new(self.active_request_count.clone());

        // One exchange at a time: hold from write through read so concurrent
        // callers can't swap responses.
        let _exchange = self.exchange_lock.lock().await;

        // Write request to stdin
        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            let stdin = stdin_lock
                .as_mut()
                .ok_or_else(|| anyhow!("Sidecar not running"))?;

            stdin
                .write_all(request_json.as_bytes())
                .await
                .context("Failed to write request to stdin")?;
            stdin
                .write_all(b"\n")
                .await
                .context("Failed to write newline")?;
            stdin.flush().await.context("Failed to flush stdin")?;
        }

        // Read response from stdout with timeout
        match tokio::time::timeout(timeout, self.read_response()).await {
            Ok(Ok(response)) => {
                self.update_activity().await;
                Ok(response)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // Timeout reached - shutdown sidecar to stop generation
                log::error!("Request timeout after {:?}, shutting down sidecar", timeout);
                if let Err(shutdown_err) = self.shutdown().await {
                    log::error!("Failed to shutdown sidecar after timeout: {}", shutdown_err);
                }
                Err(anyhow!("Request timed out after {:?}", timeout))
            }
        }
    }

    /// Send a request and stream response lines until the terminal one.
    ///
    /// Forwards every incremental `{"type":"token",...}` line to `on_line` and
    /// returns the first non-token line raw (the terminal
    /// `{"type":"response",...}` / error, exactly what `send_request` returns).
    ///
    /// Differences from `send_request`, both deliberate:
    /// - The stdout lock is held for the entire stream (not per line), so the
    ///   health-check `pong` can never interleave into the token stream. The
    ///   `RequestGuard` already makes the ping loop skip while we run; the held
    ///   lock is the belt-and-suspenders.
    /// - The timeout is per read (reset on every line), with a larger allowance
    ///   for the first line (model load + prompt processing happen before any
    ///   token), instead of one wall-clock budget for the whole generation.
    pub async fn send_request_streaming(
        &self,
        request_json: String,
        first_line_timeout: Duration,
        inter_line_timeout: Duration,
        mut on_line: impl FnMut(String),
    ) -> Result<String> {
        // Track active request (keeps the ping loop quiet while we stream).
        let _guard = RequestGuard::new(self.active_request_count.clone());

        // One exchange at a time: hold from write through the whole stream so
        // concurrent callers can't interleave into it.
        let _exchange = self.exchange_lock.lock().await;

        // Write request to stdin
        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            let stdin = stdin_lock
                .as_mut()
                .ok_or_else(|| anyhow!("Sidecar not running"))?;

            stdin
                .write_all(request_json.as_bytes())
                .await
                .context("Failed to write request to stdin")?;
            stdin
                .write_all(b"\n")
                .await
                .context("Failed to write newline")?;
            stdin.flush().await.context("Failed to flush stdin")?;
        }

        // Read lines until the terminal response, holding the lock throughout.
        // The result is computed inside the block so the lock is released
        // before any shutdown/activity calls below.
        let outcome: Result<String> = {
            let mut stdout_lock = self.stdout_reader.lock().await;
            let reader = stdout_lock
                .as_mut()
                .ok_or_else(|| anyhow!("Sidecar not running"))?;

            let mut timeout = first_line_timeout;
            loop {
                let mut line = String::new();
                match tokio::time::timeout(timeout, reader.read_line(&mut line)).await {
                    Ok(Ok(0)) => {
                        break Err(anyhow!(
                            "Sidecar closed stdout mid-stream (process may have crashed)"
                        ));
                    }
                    Ok(Ok(_)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let is_token = serde_json::from_str::<serde_json::Value>(trimmed)
                            .ok()
                            .and_then(|v| {
                                v.get("type").and_then(|t| t.as_str()).map(|t| t == "token")
                            })
                            .unwrap_or(false);
                        if is_token {
                            on_line(trimmed.to_string());
                            timeout = inter_line_timeout;
                        } else {
                            break Ok(trimmed.to_string());
                        }
                    }
                    Ok(Err(e)) => {
                        break Err(anyhow!("Failed to read streaming response: {}", e));
                    }
                    Err(_) => {
                        break Err(anyhow!(
                            "Streaming read timed out after {:?} (stream stalled)",
                            timeout
                        ));
                    }
                }
            }
        };

        match outcome {
            Ok(terminal) => {
                self.update_activity().await;
                Ok(terminal)
            }
            Err(e) => {
                // A stalled/broken stream leaves unread token lines in stdout;
                // kill the sidecar so they can't desync the next request.
                log::error!("Streaming request failed ({}), shutting down sidecar", e);
                if let Err(shutdown_err) = self.shutdown().await {
                    log::error!(
                        "Failed to shutdown sidecar after streaming failure: {}",
                        shutdown_err
                    );
                }
                Err(e)
            }
        }
    }

    /// Read a single line response from stdout
    async fn read_response(&self) -> Result<String> {
        let mut stdout_lock = self.stdout_reader.lock().await;
        let reader = stdout_lock
            .as_mut()
            .ok_or_else(|| anyhow!("Sidecar not running"))?;

        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .context("Failed to read response from stdout")?;

        if line.is_empty() {
            return Err(anyhow!("Sidecar closed stdout (process may have crashed)"));
        }

        Ok(line.trim().to_string())
    }

    /// Send ping to keep sidecar alive
    async fn send_ping(&self) -> Result<()> {
        let request = serde_json::json!({"type": "ping"}).to_string();
        let timeout = Duration::from_secs(5);

        // Note: We don't use send_request here to avoid incrementing active_request_count
        // for internal health checks, as that would prevent graceful shutdown

        // Write request
        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            if let Some(stdin) = stdin_lock.as_mut() {
                stdin.write_all(request.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
            } else {
                return Err(anyhow!("Sidecar not running"));
            }
        }

        // Read response
        let response = tokio::time::timeout(timeout, self.read_response()).await??;

        let resp: serde_json::Value = serde_json::from_str(&response)?;
        if resp.get("type").and_then(|t| t.as_str()) == Some("pong") {
            warn_once_on_stale_protocol(pong_protocol_version(&resp));
            Ok(())
        } else {
            Err(anyhow!("Unexpected ping response: {}", response))
        }
    }

    /// Gracefully shutdown the sidecar
    /// Waits for active requests to complete before killing the process
    /// Number of in-flight send_request / send_request_streaming calls.
    /// Used by cancel paths to avoid hard-killing the process while another
    /// BuiltInAI job is still using the shared sidecar.
    pub fn active_request_count(&self) -> usize {
        self.active_request_count.load(Ordering::SeqCst)
    }

    pub async fn shutdown_gracefully(&self) -> Result<()> {
        log::info!("Initiating graceful shutdown of sidecar");

        // Set shutdown flag to prevent new internal tasks
        self.should_shutdown.store(true, Ordering::SeqCst);

        // Wait for active requests to complete
        // We poll every 500ms
        let start = Instant::now();
        let max_wait = Duration::from_secs(600); // Wait up to 10 minutes for long generations

        loop {
            let count = self.active_request_count.load(Ordering::SeqCst);
            if count == 0 {
                log::info!("No active requests, proceeding with shutdown");
                break;
            }

            if start.elapsed() > max_wait {
                log::warn!(
                    "Timed out waiting for active requests ({} active), forcing shutdown",
                    count
                );
                break;
            }

            log::debug!("Waiting for {} active requests to complete...", count);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        self.shutdown().await
    }

    /// Force shutdown the sidecar
    pub async fn shutdown(&self) -> Result<()> {
        // Set shutdown flag
        self.should_shutdown.store(true, Ordering::SeqCst);

        // Send shutdown command
        if self.is_healthy() {
            let request = serde_json::json!({"type": "shutdown"}).to_string();
            let _timeout = Duration::from_secs(5);

            // Try to send shutdown command, but ignore errors
            // We don't use send_request to avoid incrementing counter
            let _ = async {
                let mut stdin_lock = self.stdin_writer.lock().await;
                if let Some(stdin) = stdin_lock.as_mut() {
                    stdin.write_all(request.as_bytes()).await?;
                    stdin.write_all(b"\n").await?;
                    stdin.flush().await?;
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;
        }

        // Kill process if still running
        {
            let mut child_lock = self.child_process.lock().await;
            if let Some(mut child) = child_lock.take() {
                match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(status)) => {
                        log::info!("Sidecar exited with status: {}", status);
                    }
                    Ok(Err(e)) => {
                        log::error!("Failed to wait for sidecar: {}", e);
                    }
                    Err(_) => {
                        log::warn!("Sidecar didn't exit gracefully, killing");
                        let _ = child.kill().await;
                    }
                }
            }
        }

        // Clear handles
        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            *stdin_lock = None;
        }

        {
            let mut stdout_lock = self.stdout_reader.lock().await;
            *stdout_lock = None;
        }

        {
            let mut current_model = self.current_model_path.write().await;
            *current_model = None;
        }

        self.is_healthy.store(false, Ordering::SeqCst);

        log::info!("Sidecar shutdown complete");
        Ok(())
    }

    /// Check if sidecar is healthy
    pub fn is_healthy(&self) -> bool {
        self.is_healthy.load(Ordering::SeqCst)
    }

    /// Update last activity timestamp
    async fn update_activity(&self) {
        let mut last_activity = self.last_activity.write().await;
        *last_activity = Instant::now();
    }

    /// Get seconds since last activity
    async fn seconds_since_activity(&self) -> u64 {
        let last_activity = self.last_activity.read().await;
        last_activity.elapsed().as_secs()
    }

    /// Start health check loop (runs in background)
    fn start_health_check_loop(&self) {
        let manager = Self {
            child_process: self.child_process.clone(),
            stdin_writer: self.stdin_writer.clone(),
            stdout_reader: self.stdout_reader.clone(),
            exchange_lock: self.exchange_lock.clone(),
            last_activity: self.last_activity.clone(),
            is_healthy: self.is_healthy.clone(),
            should_shutdown: self.should_shutdown.clone(),
            active_request_count: self.active_request_count.clone(),
            helper_binary_path: self.helper_binary_path.clone(),
            current_model_path: self.current_model_path.clone(),
            idle_timeout_secs: self.idle_timeout_secs,
        };

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                if manager.should_shutdown.load(Ordering::SeqCst) {
                    log::debug!("Health check loop: shutdown flag set, exiting");
                    break;
                }

                if !manager.is_healthy() {
                    log::debug!("Health check loop: sidecar unhealthy, skipping ping");
                    continue;
                }

                // Don't ping if we are busy with a request
                if manager.active_request_count.load(Ordering::SeqCst) > 0 {
                    continue;
                }

                log::debug!("Health check: sending ping");
                if let Err(e) = manager.send_ping().await {
                    log::warn!("Health check failed: {}", e);
                    manager.is_healthy.store(false, Ordering::SeqCst);
                }
            }

            log::debug!("Health check loop exited");
        });
    }

    /// Start idle check loop (runs in background)
    fn start_idle_check_loop(&self) {
        let manager = Self {
            child_process: self.child_process.clone(),
            stdin_writer: self.stdin_writer.clone(),
            stdout_reader: self.stdout_reader.clone(),
            exchange_lock: self.exchange_lock.clone(),
            last_activity: self.last_activity.clone(),
            is_healthy: self.is_healthy.clone(),
            should_shutdown: self.should_shutdown.clone(),
            active_request_count: self.active_request_count.clone(),
            helper_binary_path: self.helper_binary_path.clone(),
            current_model_path: self.current_model_path.clone(),
            idle_timeout_secs: self.idle_timeout_secs,
        };

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                if manager.should_shutdown.load(Ordering::SeqCst) {
                    log::debug!("Idle check loop: shutdown flag set, exiting");
                    break;
                }

                // Don't shutdown if we are busy
                if manager.active_request_count.load(Ordering::SeqCst) > 0 {
                    // Update activity to prevent timeout immediately after request finishes
                    manager.update_activity().await;
                    continue;
                }

                let idle_secs = manager.seconds_since_activity().await;
                log::debug!("Idle check: {}s since last activity", idle_secs);

                if idle_secs > manager.idle_timeout_secs {
                    log::info!(
                        "Sidecar idle for {}s (timeout: {}s), shutting down",
                        idle_secs,
                        manager.idle_timeout_secs
                    );

                    if let Err(e) = manager.shutdown().await {
                        log::error!("Failed to shutdown idle sidecar: {}", e);
                    }

                    break;
                }
            }

            log::debug!("Idle check loop exited");
        });
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        // Set shutdown flag so any running loops stop.
        self.should_shutdown.store(true, Ordering::SeqCst);

        // Best-effort synchronous reap: we can't await in Drop, but `start_kill`
        // only signals (no await), and `try_lock` succeeds in the common case
        // where nothing else holds the child lock at drop time. `kill_on_drop`
        // on the spawned command is the backstop for the contended case.
        if let Ok(mut guard) = self.child_process.try_lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
        }

        log::debug!("SidecarManager dropped");
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn pong_without_version_reads_as_v1() {
        let pong: serde_json::Value = serde_json::from_str(r#"{"type":"pong"}"#).unwrap();
        assert_eq!(pong_protocol_version(&pong), 1);
    }

    #[test]
    fn pong_with_version_reads_it() {
        let pong: serde_json::Value =
            serde_json::from_str(r#"{"type":"pong","protocol_version":2}"#).unwrap();
        assert_eq!(pong_protocol_version(&pong), 2);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// `MUESLY_LLAMA_HELPER` is process-global; serialize the tests that set it.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Writes an executable fake llama-helper that speaks the stdio protocol.
    fn write_fake_helper(name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("muesly-fake-helper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn manager_with_fake(name: &str, body: &str) -> SidecarManager {
        let script = write_fake_helper(name, body);
        let _guard = ENV_LOCK.lock().unwrap();
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("MUESLY_LLAMA_HELPER", &script) };
        let manager = SidecarManager::new(std::env::temp_dir()).unwrap();
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::remove_var("MUESLY_LLAMA_HELPER") };
        manager
    }

    #[tokio::test]
    async fn streaming_forwards_token_lines_and_returns_terminal() {
        let manager = manager_with_fake(
            "fake-stream-ok.sh",
            r#"#!/bin/bash
while IFS= read -r line; do
  case "$line" in
    *'"generate"'*)
      echo '{"type":"token","text":"Hello"}'
      echo '{"type":"token","text":" world"}'
      echo '{"type":"response","text":"Hello world!","error":null}'
      ;;
    *'"ping"'*) echo '{"type":"pong"}' ;;
    *'"shutdown"'*) echo '{"type":"goodbye"}'; exit 0 ;;
  esac
done
"#,
        );

        manager
            .ensure_running(PathBuf::from("/fake/model.gguf"))
            .await
            .unwrap();

        let mut lines = Vec::new();
        let terminal = manager
            .send_request_streaming(
                r#"{"type":"generate","prompt":"hi","stream":true}"#.to_string(),
                Duration::from_secs(5),
                Duration::from_secs(5),
                |line| lines.push(line),
            )
            .await
            .unwrap();

        assert_eq!(lines.len(), 2, "expected two token lines, got {lines:?}");
        assert!(lines[0].contains("Hello") && lines[1].contains("world"));
        assert!(terminal.contains(r#""text":"Hello world!""#));

        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_exchanges_cannot_swap_responses() {
        // Request A's answer is delayed, so without the exchange lock request
        // B's read would win the stdout lock and steal answer-A.
        let manager = std::sync::Arc::new(manager_with_fake(
            "fake-concurrent.sh",
            r#"#!/bin/bash
while IFS= read -r line; do
  case "$line" in
    *'"prompt":"A"'*) sleep 0.1; echo '{"type":"response","text":"answer-A","error":null}' ;;
    *'"prompt":"B"'*) echo '{"type":"response","text":"answer-B","error":null}' ;;
    *'"shutdown"'*) echo '{"type":"goodbye"}'; exit 0 ;;
  esac
done
"#,
        ));

        manager
            .ensure_running(PathBuf::from("/fake/model.gguf"))
            .await
            .unwrap();

        let m1 = manager.clone();
        let a = tokio::spawn(async move {
            m1.send_request(
                r#"{"type":"generate","prompt":"A"}"#.to_string(),
                Duration::from_secs(5),
            )
            .await
        });
        // Let A write first, then race B against A's delayed response.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let m2 = manager.clone();
        let b = tokio::spawn(async move {
            m2.send_request(
                r#"{"type":"generate","prompt":"B"}"#.to_string(),
                Duration::from_secs(5),
            )
            .await
        });

        let response_a = a.await.unwrap().unwrap();
        let response_b = b.await.unwrap().unwrap();
        assert!(response_a.contains("answer-A"), "A got: {response_a}");
        assert!(response_b.contains("answer-B"), "B got: {response_b}");

        manager.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn streaming_stall_times_out_and_kills_the_sidecar() {
        let manager = manager_with_fake(
            "fake-stream-stall.sh",
            r#"#!/bin/bash
while IFS= read -r line; do
  case "$line" in
    *'"generate"'*)
      echo '{"type":"token","text":"partial"}'
      sleep 30
      ;;
    *'"shutdown"'*) echo '{"type":"goodbye"}'; exit 0 ;;
  esac
done
"#,
        );

        manager
            .ensure_running(PathBuf::from("/fake/model.gguf"))
            .await
            .unwrap();

        let mut lines = Vec::new();
        let err = manager
            .send_request_streaming(
                r#"{"type":"generate","prompt":"hi","stream":true}"#.to_string(),
                Duration::from_secs(5),
                Duration::from_millis(200),
                |line| lines.push(line),
            )
            .await
            .unwrap_err();

        assert_eq!(lines.len(), 1, "the token before the stall is delivered");
        assert!(
            err.to_string().contains("timed out"),
            "unexpected error: {err}"
        );
        // The stalled sidecar was killed so leftover lines can't desync later
        // requests.
        assert!(!manager.is_healthy());
    }
}
