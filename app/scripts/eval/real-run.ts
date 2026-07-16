#!/usr/bin/env node
/**
 * Eval step 2: transcribe checked-in audio fixtures with a REAL local ASR
 * engine (via the `transcribe-fixture` cargo example) and gate results.
 * Dev-machine-only by design — CI keeps the dry-run scripts; see README.md
 * for the boundary and first-run costs (workspace compile, FFmpeg
 * build-download, model download).
 *
 * Samples come from a validated consent/provenance manifest.
 *   - Non-empty reference: WER run, gated by --max-wer.
 *   - Empty reference (e.g. silence.wav): hallucination check — the engine
 *     should produce (near-)nothing; gated by --max-hallucinated-words.
 *
 * Usage: nub real-run.ts [--max-wer <pct>] [--max-hallucinated-words <n>]
 *                          [--provider whisper|parakeet] [--model <name>]
 *                          [--models-dir <path>] [--manifest <path>]
 *                          [--backend cpu|metal|cuda|vulkan|openblas|hipblas]
 *                          [--accelerator <stable-model-or-device-id>]
 *                          [--output <path>] [--fixture <sample-id>]
 * Defaults: --max-wer 10 (calibrated: 3 runs of tiny on real-speech scored
 * 0.00%), --max-hallucinated-words 2, Whisper + tiny.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	forcesWhisperCpu,
	requiresWhisperGpu,
} from './backend.ts';
import { loadCorpus, whisperLanguageForSample } from './corpus.ts';
import { writeCorpusBoundJson } from './corpus-result.ts';
import { modelArtifactSha256, resolveModelsDirectory } from './model-artifact.ts';
import { parseRealRunArgs } from './real-run-options.ts';
import { werDetails } from './wer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const defaultManifest = path.join(here, 'corpus-manifest.json');

const args = process.argv.slice(2);
let options;
try {
	options = parseRealRunArgs(args, { defaultManifest });
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
const {
	maxWerPct,
	maxHallucinatedWords,
	provider,
	backend,
	accelerator,
	model,
	modelsDir,
	onlyFixture,
	manifestPath,
	outputPath,
} = options;
const evalModelsDir = resolveModelsDirectory(modelsDir, repoRoot);

let corpus;
try {
	corpus = loadCorpus(manifestPath);
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
const fixtures = onlyFixture
	? corpus.samples.filter((sample) => sample.id === onlyFixture)
	: corpus.samples;

if (fixtures.length === 0) {
	console.error(onlyFixture ? `no corpus sample named '${onlyFixture}'` : 'corpus has no samples');
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
	`running real ${provider} transcription with model '${model}' on ${fixtures.length} fixture(s)` +
		' (first run compiles + downloads the model)...',
);

let failed = false;
const runStartedAt = new Date().toISOString();
const runResults = [];
const metricsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-'));
process.once('exit', () => fs.rmSync(metricsDirectory, { recursive: true, force: true }));
for (const sample of fixtures) {
	const audio = sample.audio_file;
	const refText = fs.readFileSync(sample.reference_file, 'utf8').trim();
	const metricsPath = path.join(metricsDirectory, `${sample.id}.json`);

	const exampleArgs = [
		'run',
		'-q',
		'--release',
		'-p',
		'muesly',
		'--no-default-features',
		...(backend === 'cpu' ? [] : ['--features', backend]),
		'--example',
		'transcribe-fixture',
		'--',
		'--provider',
		provider,
		'--vad',
		'--metrics-json',
		metricsPath,
		audio,
		model,
	];
	const whisperLanguage = provider === 'whisper' ? whisperLanguageForSample(sample) : null;
	if (whisperLanguage) {
		exampleArgs.splice(exampleArgs.indexOf('--vad'), 0, '--language', whisperLanguage);
	}
	exampleArgs.push(evalModelsDir);
	const run = spawnSync(
		'cargo',
		exampleArgs,
		{
			cwd: repoRoot,
			env: {
				...process.env,
				MUESLY_EVAL_ACCELERATOR_ID: accelerator ?? '',
				MUESLY_WHISPER_FORCE_CPU: forcesWhisperCpu(provider, backend) ? '1' : '0',
				MUESLY_WHISPER_REQUIRE_ACCELERATION:
					requiresWhisperGpu(provider, backend) ? '1' : '0',
			},
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit'],
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	if (run.status !== 0) {
		console.error(`${sample.id}: real transcription failed (exit ${run.status ?? 'signal'})`);
		process.exit(run.status || 1);
	}
	const hypothesis = (run.stdout ?? '').trim();
	const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
	const result = {
		sample_id: sample.id,
		language: sample.language,
		noise_condition: sample.noise_condition,
		scenario: sample.scenario,
		speakers: sample.speakers,
		provenance_basis: sample.provenance.basis,
		reference_words: null,
		word_errors: null,
		wer_percent: null,
		hallucinated_words: null,
		passed: true,
		metrics,
	};

	if (refText.length === 0) {
		// Hallucination check: silence in, (near-)nothing out.
		const words = hypothesis.length === 0 ? 0 : hypothesis.split(/\s+/).length;
		result.hallucinated_words = words;
		console.log(
			`${sample.id}: hallucinated words = ${words} (limit ${maxHallucinatedWords}), ` +
				`RTF ${metrics.inference_rtf.toFixed(3)}, peak RSS ${metrics.peak_rss_mb.toFixed(1)} MiB`,
		);
		if (words > maxHallucinatedWords) {
			console.error(
				`FAIL: ${sample.id} hallucinated ${words} words (transcript omitted from logs)`,
			);
			failed = true;
			result.passed = false;
		}
	} else {
		const details = werDetails(refText, hypothesis);
		const pct = details.rate * 100;
		result.reference_words = details.referenceWords;
		result.word_errors = details.wordErrors;
		result.wer_percent = pct;
		console.log(
			`${sample.id}: WER ${pct.toFixed(2)}% (limit ${maxWerPct}%), ` +
				`RTF ${metrics.inference_rtf.toFixed(3)}, peak RSS ${metrics.peak_rss_mb.toFixed(1)} MiB`,
		);
		if (hypothesis.length === 0) {
			console.error(`FAIL: ${sample.id} produced an empty transcript`);
			failed = true;
			result.passed = false;
		} else if (pct > maxWerPct) {
			console.error(`FAIL: ${sample.id} WER ${pct.toFixed(2)}% exceeds threshold ${maxWerPct}%`);
			failed = true;
			result.passed = false;
		}
	}
	runResults.push(result);
}

if (outputPath) {
	let modelArtifactDigest;
	try {
		modelArtifactDigest = modelArtifactSha256(provider, model, evalModelsDir);
	} catch (error) {
		console.error(`failed to fingerprint evaluated model: ${error.message}`);
		process.exit(1);
	}
	const report = {
		schema_version: 7,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		started_at: runStartedAt,
		completed_at: new Date().toISOString(),
		provider,
		model,
		model_artifact_sha256: modelArtifactDigest,
		thresholds: {
			max_wer_percent: maxWerPct,
			max_hallucinated_words: maxHallucinatedWords,
		},
		passed: !failed,
		results: runResults,
	};
	const absoluteOutput = path.resolve(outputPath);
	try {
		writeCorpusBoundJson({
			manifestPath,
			expectedFingerprint: corpus.corpus_fingerprint,
			outputPath: absoluteOutput,
			value: report,
		});
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
	console.log(`wrote benchmark report: ${absoluteOutput}`);
}
process.exit(failed ? 1 : 0);
