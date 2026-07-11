#!/usr/bin/env node
/**
 * Eval step 2: transcribe the checked-in audio fixture with the REAL Whisper
 * engine (via the `transcribe-fixture` cargo example) and gate its WER against
 * the golden reference. Dev-machine-only by design — CI keeps the dry-run
 * scripts; see README.md for the boundary and first-run costs (workspace
 * compile, FFmpeg build-download, ~75 MB model).
 *
 * Usage: node real-run.mjs [--max-wer <pct>]  (default threshold: 10)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { wer } from './wer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixturesDir = path.join(here, 'fixtures');
const audio = path.join(fixturesDir, 'real-speech.wav');
const ref = path.join(fixturesDir, 'real-speech-ref.txt');

const args = process.argv.slice(2);
let maxWerPct = 10; // calibrated tripwire: 3 runs of tiny on this fixture scored 0.00%
const flagIdx = args.indexOf('--max-wer');
if (flagIdx !== -1) {
  maxWerPct = Number(args[flagIdx + 1]);
  if (!Number.isFinite(maxWerPct) || maxWerPct < 0) {
    console.error('--max-wer requires a non-negative percentage');
    process.exit(2);
  }
}

for (const f of [audio, ref]) {
  if (!fs.existsSync(f)) {
    console.error(`missing fixture: ${f}`);
    process.exit(2);
  }
}

// Building the muesly crate requires the Tauri sidecar binaries to exist; stub
// them like CI's rust-check does when absent (the example never invokes them).
const binariesDir = path.join(repoRoot, 'app/src-tauri/binaries');
try {
  const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.startsWith('host: '))
    ?.slice('host: '.length)
    .trim();
  if (triple) {
    fs.mkdirSync(binariesDir, { recursive: true });
    for (const bin of ['llama-helper', 'diarization-helper']) {
      const p = path.join(binariesDir, `${bin}-${triple}`);
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, '', { mode: 0o755 });
        console.error(`stubbed missing sidecar: ${path.relative(repoRoot, p)}`);
      }
    }
  }
} catch {
  // rustc missing entirely — cargo will fail below with its own clear error.
}

console.error('running real transcription (first run compiles + downloads the model)...');
const run = spawnSync(
  'cargo',
  ['run', '-q', '-p', 'muesly', '--example', 'transcribe-fixture', '--', audio, 'tiny'],
  { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 },
);
if (run.status !== 0 || !run.stdout || !run.stdout.trim()) {
  console.error(`real transcription failed (exit ${run.status ?? 'signal'})`);
  process.exit(run.status || 1);
}

const hypothesis = run.stdout.trim();
const pct = wer(fs.readFileSync(ref, 'utf8'), hypothesis) * 100;
console.log(`WER: ${pct.toFixed(2)}%`);
if (pct > maxWerPct) {
  console.error(`FAIL: WER ${pct.toFixed(2)}% exceeds threshold ${maxWerPct}%`);
  process.exit(1);
}
