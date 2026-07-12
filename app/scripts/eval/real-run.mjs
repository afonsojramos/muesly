#!/usr/bin/env node
/**
 * Eval step 2: transcribe checked-in audio fixtures with the REAL Whisper
 * engine (via the `transcribe-fixture` cargo example) and gate results.
 * Dev-machine-only by design — CI keeps the dry-run scripts; see README.md
 * for the boundary and first-run costs (workspace compile, FFmpeg
 * build-download, model download).
 *
 * Fixtures are auto-discovered: every `fixtures/<base>.wav` with a sibling
 * `fixtures/<base>-ref.txt`.
 *   - Non-empty reference: WER run, gated by --max-wer.
 *   - Empty reference (e.g. silence.wav): hallucination check — the engine
 *     should produce (near-)nothing; gated by --max-hallucinated-words.
 *
 * Usage: node real-run.mjs [--max-wer <pct>] [--max-hallucinated-words <n>]
 *                          [--model <name>] [--fixture <base>]
 * Defaults: --max-wer 10 (calibrated: 3 runs of tiny on real-speech scored
 * 0.00%), --max-hallucinated-words 2, --model tiny.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { wer } from './wer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixturesDir = path.join(here, 'fixtures');

function numFlag(args, name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const value = Number(args[idx + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} requires a non-negative number`);
    process.exit(2);
  }
  return value;
}

function strFlag(args, name, fallback) {
  const idx = args.indexOf(name);
  return idx === -1 ? fallback : args[idx + 1];
}

const args = process.argv.slice(2);
const maxWerPct = numFlag(args, '--max-wer', 10);
const maxHallucinatedWords = numFlag(args, '--max-hallucinated-words', 2);
const model = strFlag(args, '--model', 'tiny');
const onlyFixture = strFlag(args, '--fixture', null);

// Discover <base>.wav + <base>-ref.txt pairs.
const fixtures = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.wav'))
  .map((f) => f.slice(0, -4))
  .filter((base) => fs.existsSync(path.join(fixturesDir, `${base}-ref.txt`)))
  .filter((base) => !onlyFixture || base === onlyFixture)
  .sort();

if (fixtures.length === 0) {
  console.error(onlyFixture ? `no fixture named '${onlyFixture}'` : 'no audio fixtures found');
  process.exit(2);
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

console.error(
  `running real transcription with model '${model}' on ${fixtures.length} fixture(s)` +
    ' (first run compiles + downloads the model)...',
);

let failed = false;
for (const base of fixtures) {
  const audio = path.join(fixturesDir, `${base}.wav`);
  const refText = fs.readFileSync(path.join(fixturesDir, `${base}-ref.txt`), 'utf8').trim();

  const run = spawnSync(
    'cargo',
    ['run', '-q', '-p', 'muesly', '--example', 'transcribe-fixture', '--', audio, model],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    console.error(`${base}: real transcription failed (exit ${run.status ?? 'signal'})`);
    process.exit(run.status || 1);
  }
  const hypothesis = (run.stdout ?? '').trim();

  if (refText.length === 0) {
    // Hallucination check: silence in, (near-)nothing out.
    const words = hypothesis.length === 0 ? 0 : hypothesis.split(/\s+/).length;
    console.log(`${base}: hallucinated words = ${words} (limit ${maxHallucinatedWords})`);
    if (words > maxHallucinatedWords) {
      console.error(`FAIL: ${base} hallucinated ${words} words: '${hypothesis}'`);
      failed = true;
    }
  } else {
    if (hypothesis.length === 0) {
      console.error(`FAIL: ${base} produced an empty transcript`);
      failed = true;
      continue;
    }
    const pct = wer(refText, hypothesis) * 100;
    console.log(`${base}: WER ${pct.toFixed(2)}% (limit ${maxWerPct}%)`);
    if (pct > maxWerPct) {
      console.error(`FAIL: ${base} WER ${pct.toFixed(2)}% exceeds threshold ${maxWerPct}%`);
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
