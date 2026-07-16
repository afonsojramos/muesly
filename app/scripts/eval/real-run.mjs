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
 * Usage: node real-run.mjs [--max-wer <pct>] [--max-hallucinated-words <n>]
 *                          [--provider whisper|parakeet] [--model <name>]
 *                          [--models-dir <path>] [--manifest <path>]
 *                          [--backend cpu|metal|cuda|vulkan|openblas|hipblas]
 *                          [--output <path>] [--fixture <sample-id>]
 * Defaults: --max-wer 10 (calibrated: 3 runs of tiny on real-speech scored
 * 0.00%), --max-hallucinated-words 2, Whisper + tiny.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { forcesWhisperCpu, requiresWhisperGpu, supportedBackends } from './backend.mjs';
import { loadCorpus, whisperLanguageForSample } from './corpus.mjs';
import { modelArtifactSha256, resolveModelsDirectory } from './model-artifact.mjs';
import { werDetails } from './wer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const defaultManifest = path.join(here, 'corpus-manifest.json');

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

function integerFlag(args, name, fallback) {
	const value = numFlag(args, name, fallback);
	if (!Number.isInteger(value)) {
		console.error(`${name} requires a non-negative integer`);
		process.exit(2);
	}
	return value;
}

function strFlag(args, name, fallback) {
	const idx = args.indexOf(name);
	if (idx === -1) return fallback;
	const value = args[idx + 1];
	if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
		console.error(`${name} requires a value`);
		process.exit(2);
	}
	return value;
}

const args = process.argv.slice(2);
const maxWerPct = numFlag(args, '--max-wer', 10);
const maxHallucinatedWords = integerFlag(args, '--max-hallucinated-words', 2);
const provider = strFlag(args, '--provider', 'whisper');
if (!['whisper', 'parakeet'].includes(provider)) {
	console.error('--provider requires whisper or parakeet');
	process.exit(2);
}
const backend = strFlag(args, '--backend', 'cpu');
if (!supportedBackends.includes(backend)) {
	console.error(`--backend requires one of: ${supportedBackends.join(', ')}`);
	process.exit(2);
}
if (provider === 'parakeet' && backend !== 'cpu') {
	console.error("Parakeet currently supports only --backend cpu (reported as 'onnx-cpu')");
	process.exit(2);
}
const model = strFlag(
	args,
	'--model',
	provider === 'parakeet' ? 'parakeet-tdt-0.6b-v3-int8' : 'tiny',
);
const modelsDir = strFlag(args, '--models-dir', null);
const onlyFixture = strFlag(args, '--fixture', null);
const manifestPath = strFlag(args, '--manifest', defaultManifest);
const outputPath = strFlag(args, '--output', null);
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
			console.error(`FAIL: ${sample.id} hallucinated ${words} words: '${hypothesis}'`);
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
		schema_version: 5,
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
	fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
	fs.writeFileSync(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`wrote benchmark report: ${absoluteOutput}`);
}
process.exit(failed ? 1 : 0);
