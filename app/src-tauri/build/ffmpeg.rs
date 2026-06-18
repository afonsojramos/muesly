// ============================================================================
// FFmpeg Binary Bundling
// ============================================================================
// Download and bundle FFmpeg at build-time so it ships next to the app binary
// and there's no first-run download delay.
//
// Uses the `ffmpeg-sidecar` crate, which resolves to upstream sources
// (gyan.dev on Windows, evermeet.cx on macOS, johnvansickle.com on Linux)
// and handles archive extraction.
//
// Note: ffmpeg-sidecar resolves URLs via `cfg!(target_os/target_arch)` at
// build-script compile time — so this targets the build HOST, not an arbitrary
// cargo TARGET. CI builds run on per-platform native runners, which is fine.

use ffmpeg_sidecar::download::{
    download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg,
};

/// Download and bundle FFmpeg binary for the build host.
/// Skips download if a working cached binary is already present.
pub fn ensure_ffmpeg_binary() {
    let target = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .expect("Neither TARGET nor HOST environment variable set");

    println!("cargo:warning=🎬 Checking FFmpeg binary for target: {}", target);

    let exe_name = if target.contains("windows") { "ffmpeg.exe" } else { "ffmpeg" };
    let binary_name = if target.contains("windows") {
        format!("ffmpeg-{}.exe", target)
    } else {
        format!("ffmpeg-{}", target)
    };

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR environment variable not set");
    let binaries_dir = std::path::PathBuf::from(&manifest_dir).join("binaries");
    let binary_path = binaries_dir.join(&binary_name);

    if binary_path.exists() {
        if verify_ffmpeg_binary(&binary_path) {
            println!("cargo:warning=✅ FFmpeg binary already cached and verified: {}", binary_name);
            return;
        }
        println!("cargo:warning=⚠️  Cached FFmpeg binary appears corrupted, re-downloading...");
        let _ = std::fs::remove_file(&binary_path);
    }

    std::fs::create_dir_all(&binaries_dir).expect("Failed to create binaries directory");

    let url = ffmpeg_download_url()
        .expect("Failed to resolve FFmpeg download URL for host platform");
    println!("cargo:warning=⬇️  Downloading FFmpeg from: {}", url);

    let extract_dir = std::env::temp_dir().join(format!("muesly-ffmpeg-{}", target));
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir).expect("Failed to create extract dir");

    let archive_path = download_ffmpeg_package(url, &extract_dir)
        .expect("Failed to download FFmpeg package");

    unpack_ffmpeg(&archive_path, &extract_dir)
        .expect("Failed to unpack FFmpeg archive");

    let extracted = extract_dir.join(exe_name);
    if !extracted.is_file() {
        panic!(
            "ffmpeg-sidecar did not extract {} to expected path: {:?}",
            exe_name, extracted
        );
    }

    std::fs::copy(&extracted, &binary_path)
        .expect("Failed to copy ffmpeg binary to binaries/");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&binary_path)
            .expect("Failed to get binary metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&binary_path, perms)
            .expect("Failed to set executable permissions");
    }

    let _ = std::fs::remove_dir_all(&extract_dir);

    if !verify_ffmpeg_binary(&binary_path) {
        panic!("Downloaded FFmpeg binary failed verification");
    }

    println!("cargo:warning=✨ FFmpeg ready: {}", binary_name);
}

/// Verify FFmpeg binary is functional by running `ffmpeg -version`.
fn verify_ffmpeg_binary(path: &std::path::Path) -> bool {
    match std::process::Command::new(path).arg("-version").output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(version_line) = stdout.lines().next() {
                println!("cargo:warning=✅ FFmpeg verification passed: {}", version_line);
            }
            true
        }
        _ => false,
    }
}
