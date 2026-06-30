/**
 * Inject PostHog chunk IDs into the built JS and upload sourcemaps, so frontend
 * `$exception` stack traces symbolicate to real source in PostHog error tracking.
 *
 * Runs after `vite build` (see the `build:tauri` script / tauri beforeBuildCommand).
 * Fully gated and best-effort: a no-op when credentials are absent (local/dev/CI
 * builds), and never fails the build if posthog-cli is missing or PostHog is down,
 * analytics tooling must not be able to break a release.
 *
 * Required env (set as CI secrets): POSTHOG_CLI_TOKEN (personal API key),
 * POSTHOG_CLI_ENV_ID (project/environment id). POSTHOG_CLI_HOST defaults to EU.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUILD_DIR = 'build';
const host = process.env.POSTHOG_CLI_HOST || 'https://eu.posthog.com';

if (!process.env.POSTHOG_CLI_TOKEN || !process.env.POSTHOG_CLI_ENV_ID) {
  console.log('[posthog] POSTHOG_CLI_TOKEN/POSTHOG_CLI_ENV_ID not set — skipping sourcemap upload.');
  process.exit(0);
}

let uploaded = false;
try {
  console.log(`[posthog] Injecting chunk ids and uploading sourcemaps from ./${BUILD_DIR} …`);
  // posthog-cli reads POSTHOG_CLI_TOKEN / POSTHOG_CLI_ENV_ID from the environment.
  execFileSync('posthog-cli', ['--host', host, 'sourcemap', 'process', BUILD_DIR], {
    stdio: 'inherit',
  });
  uploaded = true;
  console.log('[posthog] Sourcemap upload complete.');
} catch (err) {
  console.warn(`[posthog] Sourcemap upload skipped/failed (build continues): ${err?.message ?? err}`);
}

// Only strip .map files once PostHog has them, so a failed upload never loses them.
if (uploaded) removeSourceMaps(BUILD_DIR);

function removeSourceMaps(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      removeSourceMaps(path);
    } else if (name.endsWith('.map')) {
      try {
        rmSync(path);
      } catch {
        /* best-effort */
      }
    }
  }
}
