# GitHub Actions Workflows

Most workflows are **manual** (`workflow_dispatch`). The exceptions are `rust-check.yml` and `audit.yml`, which run automatically on pull requests and pushes to `main` (`audit.yml` also runs on a weekly schedule).

## Workflows at a Glance

| Workflow | Purpose | Platforms | Default Signing | Retention |
|---|---|---|---|---|
| `build-dev.yml` | Fast dev/test builds | All | OFF | 14 days |
| `build-macos.yml` | macOS standalone build | macOS | Optional | 30 days |
| `build-windows.yml` | Windows standalone build | Windows | Optional | 30 days |
| `build-linux.yml` | Linux standalone build | Linux | Optional | 30 days |
| `build-test.yml` | Pre-release builds, signed | All | ON | 30 days |
| `build.yml` | Reusable build / sign / verify workflow (called by every `build-*` and `release` workflow) | - | - | - |
| `release.yml` | Production release (draft GitHub Release) | macOS + Windows + Linux | macOS only | Permanent |
| `pr-main-check.yml` | Version/config validation, no builds | - | - | - |
| `rust-check.yml` | Auto: test / clippy / fmt on PR + push to `main` | - | - | - |
| `audit.yml` | Auto: `cargo audit` on PR + push + weekly cron | - | - | - |

## Choosing a Workflow

- **Routine development** → `build-dev.yml` (fastest; unsigned ~25-30 min, signed ~35-45 min)
- **Platform-specific testing** → `build-macos.yml` / `build-windows.yml` / `build-linux.yml`
- **Pre-release verification** → `build-test.yml` (signed, all platforms)
- **Publishing** → `release.yml`

## Running a Workflow

1. Go to the **Actions** tab and select the workflow
2. Click **Run workflow**, pick the branch and options (signing, artifact upload)
3. Download artifacts from the run page after completion

Artifacts are named `muesly-{workflow}-{platform}-{target}-{version}`, e.g. `muesly-dev-macOS-aarch64-apple-darwin-0.3.0`.

## Code Signing

When signing is enabled:

- **macOS**: Apple Developer ID certificate + notarization; verified with `codesign` and `spctl`
- **Windows**: DigiCert KeyLocker (cloud HSM); signs MSI and NSIS installers. **Not enabled in `release.yml`** (no DigiCert account): Windows ships unsigned, so it shows a SmartScreen "unknown publisher" prompt on first install. To enable, add the `SM_*` secrets below and set `sign: true` on the Windows matrix entry in `release.yml`.
- **Updater (all platforms)**: Tauri Ed25519 signatures for auto-update manifests. Always produced regardless of OS code signing, so auto-update works on Windows even while unsigned.

Required secrets:

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `KEYCHAIN_PASSWORD`
- Windows (optional, for Authenticode): `SM_HOST`, `SM_API_KEY`, `SM_CLIENT_CERT_FILE_B64`, `SM_CLIENT_CERT_PASSWORD`, `SM_CODE_SIGNING_CERT_SHA1_HASH`
- Updater: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## Releases (`release.yml`)

- Version comes from `tauri.conf.json` and must be plain `X.Y.Z` (no pre-release suffixes; Windows MSI rejects them)
- If the version tag already exists, the workflow auto-increments: `0.1.1` → `0.1.1.1` → ... up to `.100`
- Creates a **draft** GitHub Release with installers (macOS signed + notarized, Windows unsigned) and a `latest.json` updater manifest
- **Linux** ships a `.deb` and an AppImage as downloads, and the AppImage auto-updates: its bundled `libwayland-client.so` is stripped for Wayland compatibility, then the AppImage is re-signed (so the updater signature matches) and a `linux-x86_64` entry is added to `latest.json`

## CI Hardware Acceleration

CI builds use the fastest available backend per runner: Metal (macOS, default), Vulkan (Windows), OpenBLAS (Linux). CUDA is not used in CI (no GPU runners).

## Troubleshooting

- **Signing fails**: verify the secrets above are configured and not expired; check run logs
- **Windows MSI version error**: ensure `tauri.conf.json` version is plain semver (`0.3.0`, not `0.3.0-beta`)
- **Artifacts missing**: the build must succeed, "upload artifacts" must be enabled, and retention may have expired
- **Workflow not listed in Actions**: YAML syntax error, or the file isn't in `.github/workflows/`
