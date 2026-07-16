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
 *                          [--backend cpu|metal|coreml|cuda|vulkan|openblas|hipblas]
 *                          [--accelerator <stable-model-or-device-id>]
 *                          [--output <path>] [--fixture <sample-id>]
 * Defaults: --max-wer 10 (calibrated: 3 runs of tiny on real-speech scored
 * 0.00%), --max-hallucinated-words 2, Whisper + tiny.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPrivateArtifactSnapshotDirectory } from './artifact-snapshot.ts';
import { forcesWhisperCpu, requiresWhisperGpu } from './backend.ts';
import {
	benchmarkExecutableSha256,
	benchmarkRuntimeEnvironment,
	benchmarkRuntimeDependenciesSha256,
	bindBenchmarkRuntimeDependencies,
	buildBenchmarkExecutable,
	cargoFeaturesForBenchmark,
	prepareBenchmarkModel,
	probeBenchmarkExecutable,
	stageBenchmarkExecutableSnapshot,
} from './benchmark-executable.ts';
import { loadCorpus, whisperLanguageForSample } from './corpus.ts';
import { writeCorpusBoundJson } from './corpus-result.ts';
import {
	attestedRustcVersion,
	evaluatorBuildEnvironment,
	evaluatorRevision,
} from './evaluator-revision.ts';
import {
	modelArtifactSha256,
	resolveModelsDirectory,
	stageModelArtifactSnapshot,
} from './model-artifact.ts';
import { parseRealRunArgs } from './real-run-options.ts';
import { validateBenchmarkMetrics, validateRunReport } from './report.ts';
import { WER_SCORER_ID, werDetails } from './wer.ts';

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
let rustcHostTriple;
try {
	rustcHostTriple = attestedRustcVersion(repoRoot, { buildEnv: process.env }).hostTriple;
	fs.mkdirSync(binariesDir, { recursive: true });
	for (const bin of ['llama-helper', 'diarization-helper']) {
		const p = path.join(binariesDir, `${bin}-${rustcHostTriple}`);
		if (!fs.existsSync(p)) {
			fs.writeFileSync(p, '', { mode: 0o755 });
			console.error(`stubbed missing sidecar: ${path.relative(repoRoot, p)}`);
		}
	}
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

console.error(
	`running real ${provider} transcription with model '${model}' on ${fixtures.length} fixture(s)` +
		' (first run compiles + downloads the model)...',
);

let benchmarkEnvironment = benchmarkRuntimeEnvironment(process.env, {
	accelerator,
	forceWhisperCpu: forcesWhisperCpu(provider, backend),
	requireWhisperAcceleration: requiresWhisperGpu(provider, backend),
});
const buildTargetTriple = process.env.CARGO_BUILD_TARGET || rustcHostTriple;
let buildEnvironment;
try {
	buildEnvironment = evaluatorBuildEnvironment(process.env, buildTargetTriple, rustcHostTriple);
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
let builtBenchmark;
let hardwareProbe;
let initialBenchmarkExecutableDigest = null;
let initialRuntimeDependenciesDigest = null;
let initialEvaluatorRevision = null;
let initialModelArtifactDigest = null;
let benchmarkExecutablePath = null;
let benchmarkModelsDirectory = null;
const privateTemporaryDirectories = [];
let privateDirectoriesCleaned = false;
const cleanupPrivateDirectories = () => {
	if (privateDirectoriesCleaned) return;
	privateDirectoriesCleaned = true;
	for (const directory of privateTemporaryDirectories.reverse()) {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort during process teardown; paths remain private if removal fails.
		}
	}
};
const signalHandlers = {};
const terminateAfterCleanup = (signal) => {
	cleanupPrivateDirectories();
	process.off(signal, signalHandlers[signal]);
	process.kill(process.pid, signal);
};
signalHandlers.SIGINT = () => terminateAfterCleanup('SIGINT');
signalHandlers.SIGTERM = () => terminateAfterCleanup('SIGTERM');
process.once('exit', cleanupPrivateDirectories);
process.on('SIGINT', signalHandlers.SIGINT);
process.on('SIGTERM', signalHandlers.SIGTERM);
try {
	const cargoFeatures = cargoFeaturesForBenchmark(provider, backend);
	if (outputPath) {
		initialEvaluatorRevision = evaluatorRevision(repoRoot, {
			buildEnv: buildEnvironment,
			cargoFeatures,
		});
	}
	builtBenchmark = buildBenchmarkExecutable(repoRoot, {
		provider,
		backend,
		buildEnv: buildEnvironment,
	});
	initialBenchmarkExecutableDigest = benchmarkExecutableSha256(builtBenchmark.executablePath);
	const executableSnapshotDirectory = createPrivateArtifactSnapshotDirectory(
		path.dirname(builtBenchmark.executablePath),
	);
	privateTemporaryDirectories.push(executableSnapshotDirectory);
	const executableSnapshot = stageBenchmarkExecutableSnapshot(
		builtBenchmark.executablePath,
		path.join(executableSnapshotDirectory, 'executable'),
		initialBenchmarkExecutableDigest,
	);
	benchmarkExecutablePath = executableSnapshot.executablePath;
	initialRuntimeDependenciesDigest = executableSnapshot.runtimeDependenciesSha256;
	benchmarkEnvironment = bindBenchmarkRuntimeDependencies(
		benchmarkEnvironment,
		initialRuntimeDependenciesDigest,
		benchmarkExecutablePath,
	);
	if (
		initialEvaluatorRevision &&
		JSON.stringify(builtBenchmark.cargoFeatures) !== JSON.stringify(cargoFeatures)
	) {
		throw new Error('benchmark build features changed after evaluator provenance was collected');
	}
	hardwareProbe = probeBenchmarkExecutable(benchmarkExecutablePath, {
		provider,
		backend,
		environment: benchmarkEnvironment,
	});
	if (hardwareProbe.benchmark_executable_sha256 !== initialBenchmarkExecutableDigest) {
		throw new Error('benchmark executable changed between build and hardware probe');
	}
	prepareBenchmarkModel(benchmarkExecutablePath, {
		provider,
		model,
		modelsDirectory: evalModelsDir,
		environment: benchmarkEnvironment,
	});
	initialModelArtifactDigest = modelArtifactSha256(
		provider,
		model,
		evalModelsDir,
		hardwareProbe.backend,
	);
	const modelSnapshotDirectory = createPrivateArtifactSnapshotDirectory(evalModelsDir);
	privateTemporaryDirectories.push(modelSnapshotDirectory);
	const modelSnapshot = stageModelArtifactSnapshot(
		provider,
		model,
		evalModelsDir,
		hardwareProbe.backend,
		path.join(modelSnapshotDirectory, 'model'),
		initialModelArtifactDigest,
	);
	benchmarkModelsDirectory = modelSnapshot.modelsDirectory;
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

let failed = false;
const runStartedAt = new Date().toISOString();
const runResults = [];
const metricsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-'));
privateTemporaryDirectories.push(metricsDirectory);
for (const sample of fixtures) {
	const audio = sample.audio_file;
	const refText = fs.readFileSync(sample.reference_file, 'utf8').trim();
	const metricsPath = path.join(metricsDirectory, `${sample.id}.json`);

	const exampleArgs = [
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
	exampleArgs.push(benchmarkModelsDirectory);
	let sampleModelArtifactDigest;
	try {
		sampleModelArtifactDigest = modelArtifactSha256(
			provider,
			model,
			benchmarkModelsDirectory,
			hardwareProbe.backend,
		);
	} catch (error) {
		console.error(
			`${sample.id}: failed to fingerprint the model before transcription: ${error.message}`,
		);
		process.exit(1);
	}
	if (sampleModelArtifactDigest !== initialModelArtifactDigest) {
		console.error(`${sample.id}: evaluated model artifact changed before transcription`);
		process.exit(1);
	}
	let sampleBenchmarkExecutableDigest;
	try {
		sampleBenchmarkExecutableDigest = benchmarkExecutableSha256(benchmarkExecutablePath);
	} catch (error) {
		console.error(
			`${sample.id}: failed to fingerprint the benchmark executable before transcription: ${error.message}`,
		);
		process.exit(1);
	}
	if (sampleBenchmarkExecutableDigest !== initialBenchmarkExecutableDigest) {
		console.error(`${sample.id}: benchmark executable changed before transcription`);
		process.exit(1);
	}
	let sampleRuntimeDependenciesDigest;
	try {
		sampleRuntimeDependenciesDigest = benchmarkRuntimeDependenciesSha256(benchmarkExecutablePath);
	} catch (error) {
		console.error(
			`${sample.id}: failed to fingerprint benchmark runtime libraries before transcription: ${error.message}`,
		);
		process.exit(1);
	}
	if (sampleRuntimeDependenciesDigest !== initialRuntimeDependenciesDigest) {
		console.error(`${sample.id}: benchmark runtime libraries changed before transcription`);
		process.exit(1);
	}
	const run = spawnSync(benchmarkExecutablePath, exampleArgs, {
		cwd: repoRoot,
		env: benchmarkEnvironment,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		maxBuffer: 16 * 1024 * 1024,
	});
	let finalSampleBenchmarkExecutableDigest;
	try {
		finalSampleBenchmarkExecutableDigest = benchmarkExecutableSha256(benchmarkExecutablePath);
	} catch (error) {
		console.error(
			`${sample.id}: failed to fingerprint the benchmark executable after transcription: ${error.message}`,
		);
		process.exit(1);
	}
	if (
		finalSampleBenchmarkExecutableDigest !== sampleBenchmarkExecutableDigest ||
		finalSampleBenchmarkExecutableDigest !== initialBenchmarkExecutableDigest
	) {
		console.error(`${sample.id}: benchmark executable changed during transcription`);
		process.exit(1);
	}
	let finalSampleRuntimeDependenciesDigest;
	try {
		finalSampleRuntimeDependenciesDigest =
			benchmarkRuntimeDependenciesSha256(benchmarkExecutablePath);
	} catch (error) {
		console.error(
			`${sample.id}: failed to fingerprint benchmark runtime libraries after transcription: ${error.message}`,
		);
		process.exit(1);
	}
	if (
		finalSampleRuntimeDependenciesDigest !== sampleRuntimeDependenciesDigest ||
		finalSampleRuntimeDependenciesDigest !== initialRuntimeDependenciesDigest
	) {
		console.error(`${sample.id}: benchmark runtime libraries changed during transcription`);
		process.exit(1);
	}
	let finalSampleModelArtifactDigest;
	try {
		finalSampleModelArtifactDigest = modelArtifactSha256(
			provider,
			model,
			benchmarkModelsDirectory,
			hardwareProbe.backend,
		);
	} catch (error) {
		console.error(
			`${sample.id}: failed to fingerprint the model after transcription: ${error.message}`,
		);
		process.exit(1);
	}
	if (
		finalSampleModelArtifactDigest !== sampleModelArtifactDigest ||
		finalSampleModelArtifactDigest !== initialModelArtifactDigest
	) {
		console.error(`${sample.id}: evaluated model artifact changed during transcription`);
		process.exit(1);
	}
	if (run.status !== 0) {
		if (run.signal === 'SIGINT' || run.signal === 'SIGTERM') {
			terminateAfterCleanup(run.signal);
		}
		console.error(`${sample.id}: real transcription failed (exit ${run.status ?? 'signal'})`);
		process.exit(run.status || 1);
	}
	const hypothesis = (run.stdout ?? '').trim();
	let metrics;
	try {
		metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
	} catch {
		console.error(`${sample.id}: benchmark metrics are missing or invalid`);
		process.exit(1);
	}
	const metricsErrors = validateBenchmarkMetrics(metrics, `${sample.id}.metrics`);
	if (metricsErrors.length > 0) {
		console.error(`invalid benchmark metrics:\n- ${metricsErrors.join('\n- ')}`);
		process.exit(1);
	}
	for (const [field, expected] of [
		['schema_version', 5],
		['provider', provider],
		['model', model],
		['backend', hardwareProbe.backend],
		['operating_system', hardwareProbe.operating_system],
		['architecture', hardwareProbe.architecture],
		['hardware_profile', hardwareProbe.hardware_profile],
		['accelerator', hardwareProbe.accelerator],
		['benchmark_executable_sha256', hardwareProbe.benchmark_executable_sha256],
	]) {
		if (metrics[field] !== expected) {
			console.error(`${sample.id}: benchmark metrics ${field} does not match the hardware probe`);
			process.exit(1);
		}
	}
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

let finalModelArtifactDigest;
try {
	finalModelArtifactDigest = modelArtifactSha256(
		provider,
		model,
		benchmarkModelsDirectory,
		hardwareProbe.backend,
	);
} catch (error) {
	console.error(`failed to fingerprint evaluated model: ${error.message}`);
	process.exit(1);
}
if (finalModelArtifactDigest !== initialModelArtifactDigest) {
	console.error('evaluated model artifact changed while the benchmark was running');
	process.exit(1);
}
let finalBenchmarkExecutableDigest;
try {
	finalBenchmarkExecutableDigest = benchmarkExecutableSha256(benchmarkExecutablePath);
} catch (error) {
	console.error(`failed to fingerprint benchmark executable: ${error.message}`);
	process.exit(1);
}
if (finalBenchmarkExecutableDigest !== initialBenchmarkExecutableDigest) {
	console.error('benchmark executable changed while the benchmark was running');
	process.exit(1);
}
let finalRuntimeDependenciesDigest;
try {
	finalRuntimeDependenciesDigest = benchmarkRuntimeDependenciesSha256(benchmarkExecutablePath);
} catch (error) {
	console.error(`failed to fingerprint benchmark runtime libraries: ${error.message}`);
	process.exit(1);
}
if (finalRuntimeDependenciesDigest !== initialRuntimeDependenciesDigest) {
	console.error('benchmark runtime libraries changed while the benchmark was running');
	process.exit(1);
}

if (outputPath) {
	let finalEvaluatorRevision;
	try {
		finalEvaluatorRevision = evaluatorRevision(repoRoot, {
			buildEnv: buildEnvironment,
			cargoFeatures: builtBenchmark.cargoFeatures,
		});
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
	if (finalEvaluatorRevision.sha256 !== initialEvaluatorRevision.sha256) {
		console.error('evaluator revision changed while the benchmark was running');
		process.exit(1);
	}
	const report = {
		schema_version: 9,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		started_at: runStartedAt,
		completed_at: new Date().toISOString(),
		wer_scorer: WER_SCORER_ID,
		evaluator_revision: finalEvaluatorRevision.revision,
		evaluator_revision_sha256: finalEvaluatorRevision.sha256,
		benchmark_executable_sha256: hardwareProbe.benchmark_executable_sha256,
		provider,
		model,
		model_artifact_sha256: initialModelArtifactDigest,
		thresholds: {
			max_wer_percent: maxWerPct,
			max_hallucinated_words: maxHallucinatedWords,
		},
		passed: !failed,
		results: runResults,
	};
	const reportErrors = validateRunReport(report);
	if (reportErrors.length > 0) {
		console.error(`refusing to write invalid benchmark report:\n- ${reportErrors.join('\n- ')}`);
		process.exit(1);
	}
	const absoluteOutput = path.resolve(outputPath);
	try {
		writeCorpusBoundJson({
			manifestPath,
			expectedFingerprint: corpus.corpus_fingerprint,
			outputPath: absoluteOutput,
			value: report,
			benchmarkLockToken: process.env.MUESLY_CORPUS_BENCHMARK_TOKEN,
		});
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
	console.log(`wrote benchmark report: ${absoluteOutput}`);
}
process.exit(failed ? 1 : 0);
