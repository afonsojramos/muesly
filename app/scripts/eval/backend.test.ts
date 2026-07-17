import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	forcesWhisperCpu,
	requiresExplicitAccelerator,
	requiresWhisperGpu,
	supportedBackends,
} from './backend.ts';

function isolatedToolEnvironment(temporaryRoot) {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !['path', 'temp', 'tmp', 'tmpdir'].includes(key.toLowerCase()),
			),
		),
		PATH: temporaryRoot,
		TEMP: temporaryRoot,
		TMP: temporaryRoot,
		TMPDIR: temporaryRoot,
	};
}

function writeFakeBenchmarkToolchain(temporaryRoot, regularRunSource) {
	const benchmarkExecutable = path.join(temporaryRoot, 'transcribe-fixture');
	const modelsDirectory = path.join(temporaryRoot, 'models');
	fs.mkdirSync(modelsDirectory);
	fs.writeFileSync(path.join(modelsDirectory, 'ggml-tiny.bin'), 'prepared whisper model');
	const hardwareProbe = {
		schema_version: 1,
		backend: 'cpu',
		operating_system: 'linux',
		architecture: 'x86_64',
		hardware_profile: `cpu=test;logical_cpus=1;memory_bytes=1;runtime_env_sha256=${'d'.repeat(64)}`,
		accelerator: 'none',
	};
	fs.writeFileSync(
		benchmarkExecutable,
		`#!${process.execPath}
const { createHash } = require('node:crypto');
const fs = require('node:fs');
if (process.argv.includes('--hardware-json')) {
	const probe = ${JSON.stringify(hardwareProbe)};
	probe.benchmark_executable_sha256 = createHash('sha256')
		.update(fs.readFileSync(process.argv[1]))
		.digest('hex');
	process.stdout.write(JSON.stringify(probe) + '\\n');
	process.exit(0);
}
if (process.argv.includes('--prepare-model-json')) {
	const provider = process.argv[process.argv.indexOf('--provider') + 1];
	const model = process.argv[process.argv.indexOf('--model') + 1];
	const modelsDirectory = process.argv[process.argv.indexOf('--models-dir') + 1];
	const modelArtifactSha256 = createHash('sha256')
		.update(fs.readFileSync(modelsDirectory + '/ggml-' + model + '.bin'))
		.digest('hex');
	process.stdout.write(JSON.stringify({
		schema_version: 2,
		provider,
		model,
		model_artifact_sha256: modelArtifactSha256,
	}) + '\\n');
	process.exit(0);
}
${regularRunSource}
`,
		{ mode: 0o700 },
	);
	const cargoArtifact = {
		reason: 'compiler-artifact',
		target: { name: 'transcribe-fixture', kind: ['example'] },
		executable: benchmarkExecutable,
	};
	fs.writeFileSync(
		path.join(temporaryRoot, 'cargo'),
		`#!${process.execPath}
process.stdout.write(${JSON.stringify(`${JSON.stringify(cargoArtifact)}\n`)});
`,
		{ mode: 0o700 },
	);
	fs.writeFileSync(
		path.join(temporaryRoot, 'rustc'),
		`#!${process.execPath}
process.stdout.write([
	'rustc 1.88.0 (6b00bc388 2025-06-23)',
	'binary: rustc',
	'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc',
	'commit-date: 2025-06-23',
	'host: x86_64-unknown-linux-gnu',
	'release: 1.88.0',
	'LLVM version: 20.1.5',
].join('\\n') + '\\n');
`,
		{ mode: 0o700 },
	);
	return { benchmarkExecutable, modelsDirectory };
}

async function waitForPath(filePath, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filePath)}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test('requires strict acceleration only for Whisper GPU backends', () => {
	for (const backend of ['metal', 'coreml', 'cuda', 'vulkan', 'hipblas']) {
		assert.equal(requiresWhisperGpu('whisper', backend), true, backend);
	}
	for (const backend of ['cpu', 'openblas']) {
		assert.equal(requiresWhisperGpu('whisper', backend), false, backend);
	}
	assert.equal(requiresWhisperGpu('parakeet', 'cpu'), false);
});

test('classifies every supported backend', () => {
	for (const backend of supportedBackends) {
		assert.equal(typeof requiresWhisperGpu('whisper', backend), 'boolean');
	}
});

test('forces CPU execution for plain and OpenBLAS Whisper runs', () => {
	assert.equal(forcesWhisperCpu('whisper', 'cpu'), true);
	assert.equal(forcesWhisperCpu('whisper', 'openblas'), true);
	assert.equal(forcesWhisperCpu('whisper', 'metal'), false);
	assert.equal(forcesWhisperCpu('parakeet', 'cpu'), false);
});

test('requires an explicit accelerator identity unless Apple Silicon identifies integrated Metal', () => {
	assert.equal(requiresExplicitAccelerator('whisper', 'metal', 'darwin', 'arm64'), false);
	assert.equal(requiresExplicitAccelerator('whisper', 'coreml', 'darwin', 'arm64'), false);
	assert.equal(requiresExplicitAccelerator('whisper', 'metal', 'darwin', 'x64'), true);
	assert.equal(requiresExplicitAccelerator('whisper', 'coreml', 'darwin', 'x64'), true);
	for (const backend of ['cuda', 'vulkan', 'hipblas']) {
		assert.equal(requiresExplicitAccelerator('whisper', backend, 'linux', 'x64'), true, backend);
	}
	assert.equal(requiresExplicitAccelerator('whisper', 'cpu', 'linux', 'x64'), false);
	assert.equal(requiresExplicitAccelerator('parakeet', 'cpu', 'linux', 'x64'), false);
});

test('rejects ambiguous GPU benchmarks before starting cargo', () => {
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	const run = spawnSync(process.execPath, [realRun, '--backend', 'cuda'], { encoding: 'utf8' });
	assert.equal(run.status, 2);
	assert.match(run.stderr, /requires --accelerator/);
	assert.doesNotMatch(run.stderr, /running real/);
});

test('rejects missing output paths before starting a benchmark', () => {
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	for (const args of [['--output'], ['--output', '--fixture', 'en-gettysburg-clean']]) {
		const run = spawnSync(process.execPath, [realRun, ...args], { encoding: 'utf8' });
		assert.equal(run.status, 2);
		assert.match(run.stderr, /--output requires a value/);
		assert.doesNotMatch(run.stderr, /running real/);
	}
});

test('selects fixtures only by unique manifest sample ID', () => {
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	const run = spawnSync(process.execPath, [realRun, '--fixture', 'real-speech'], {
		encoding: 'utf8',
	});
	assert.equal(run.status, 2);
	assert.match(run.stderr, /no corpus sample named 'real-speech'/);
	assert.doesNotMatch(run.stderr, /running real/);
});

test('removes temporary metrics after a failed transcription process', (t) => {
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-cleanup-test-'));
	t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
	const { modelsDirectory } = writeFakeBenchmarkToolchain(temporaryRoot, 'process.exit(17);');
	const run = spawnSync(
		process.execPath,
		[realRun, '--fixture', 'und-synthetic-silence', '--models-dir', modelsDirectory],
		{
			encoding: 'utf8',
			env: isolatedToolEnvironment(temporaryRoot),
		},
	);
	assert.equal(run.status, 17);
	assert.match(run.stderr, /real transcription failed \(exit 17\)/);
	assert.doesNotMatch(run.stderr, /failed to build transcribe-fixture/);
	assert.deepEqual(
		fs.readdirSync(temporaryRoot).filter((entry) => entry.includes('muesly-eval')),
		[],
	);
	assert.deepEqual(
		fs.readdirSync(modelsDirectory).filter((entry) => entry.includes('muesly-eval')),
		[],
	);
});

test('runs inference only from private executable and model snapshots', (t) => {
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-snapshot-test-'));
	t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
	const originalExecutable = path.join(temporaryRoot, 'transcribe-fixture');
	const originalModelsDirectory = path.join(temporaryRoot, 'models');
	const originalModel = path.join(originalModelsDirectory, 'ggml-tiny.bin');
	const heldExecutable = path.join(temporaryRoot, 'held-transcribe-fixture');
	const heldModel = path.join(temporaryRoot, 'held-model.bin');
	const regularRunSource = `
const metricsPath = process.argv[process.argv.indexOf('--metrics-json') + 1];
const expectedAudioSha256 =
	process.argv[process.argv.indexOf('--expected-audio-sha256') + 1];
const modelsDirectory = process.argv.at(-1);
if (process.argv[1] === ${JSON.stringify(originalExecutable)}) process.exit(31);
if (modelsDirectory === ${JSON.stringify(originalModelsDirectory)}) process.exit(32);
if (fs.readFileSync(modelsDirectory + '/ggml-tiny.bin', 'utf8') !== 'prepared whisper model') {
	process.exit(33);
}
fs.renameSync(${JSON.stringify(originalExecutable)}, ${JSON.stringify(heldExecutable)});
fs.renameSync(${JSON.stringify(originalModel)}, ${JSON.stringify(heldModel)});
try {
	fs.writeFileSync(${JSON.stringify(originalExecutable)}, 'transient malicious executable', {
		mode: 0o700,
	});
	fs.writeFileSync(${JSON.stringify(originalModel)}, 'transient malicious model');
	const benchmarkExecutableSha256 = createHash('sha256')
		.update(fs.readFileSync(process.argv[1]))
		.digest('hex');
	fs.writeFileSync(
		metricsPath,
		JSON.stringify({
			schema_version: 7,
			provider: 'whisper',
			model: 'tiny',
			backend: 'cpu',
			operating_system: 'linux',
			architecture: 'x86_64',
			hardware_profile:
				'cpu=test;logical_cpus=1;memory_bytes=1;runtime_env_sha256=${'d'.repeat(64)}',
			accelerator: 'none',
			benchmark_executable_sha256: benchmarkExecutableSha256,
			audio_sha256: expectedAudioSha256,
			audio_duration_seconds: 20,
			decode_seconds: 0,
			vad_seconds: 0,
			model_download_seconds: 0,
			model_load_seconds: 0,
			inference_seconds: 0,
			inference_rtf: 0,
			inference_audio_seconds: 20,
			model_inference_rtf: 0,
			measured_total_seconds: 0,
			baseline_rss_mb: 1,
			peak_rss_mb: 1,
			peak_rss_delta_mb: 0,
		}) + '\\n',
	);
} finally {
	fs.rmSync(${JSON.stringify(originalExecutable)}, { force: true });
	fs.rmSync(${JSON.stringify(originalModel)}, { force: true });
	fs.renameSync(${JSON.stringify(heldExecutable)}, ${JSON.stringify(originalExecutable)});
	fs.renameSync(${JSON.stringify(heldModel)}, ${JSON.stringify(originalModel)});
}
`;
	const { modelsDirectory } = writeFakeBenchmarkToolchain(temporaryRoot, regularRunSource);
	const run = spawnSync(
		process.execPath,
		[realRun, '--fixture', 'und-synthetic-silence', '--models-dir', modelsDirectory],
		{
			encoding: 'utf8',
			env: isolatedToolEnvironment(temporaryRoot),
		},
	);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(fs.readFileSync(originalExecutable, 'utf8').includes('--hardware-json'), true);
	assert.equal(fs.readFileSync(originalModel, 'utf8'), 'prepared whisper model');
	assert.deepEqual(
		fs.readdirSync(temporaryRoot).filter((entry) => entry.includes('muesly-eval')),
		[],
	);
	assert.deepEqual(
		fs.readdirSync(modelsDirectory).filter((entry) => entry.includes('muesly-eval')),
		[],
	);
});

test('cleans private snapshots when the benchmark process group is terminated', async (t) => {
	if (process.platform === 'win32') {
		return t.skip('negative-PID process-group signals are Unix-specific');
	}
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-signal-test-'));
	const markerPath = path.join(temporaryRoot, 'inference-started');
	t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
	const { modelsDirectory } = writeFakeBenchmarkToolchain(
		temporaryRoot,
		`fs.writeFileSync(${JSON.stringify(markerPath)}, 'ready'); setInterval(() => {}, 1000);`,
	);
	const run = spawn(
		process.execPath,
		[realRun, '--fixture', 'und-synthetic-silence', '--models-dir', modelsDirectory],
		{
			detached: true,
			env: isolatedToolEnvironment(temporaryRoot),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	let stderr = '';
	run.stderr.setEncoding('utf8');
	run.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	t.after(() => {
		if (run.exitCode === null && run.signalCode === null) {
			try {
				process.kill(-run.pid, 'SIGKILL');
			} catch {
				// The process group already exited.
			}
		}
	});
	await waitForPath(markerPath);
	const exitResult = new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`signal cleanup timed out: ${stderr}`)),
			5000,
		);
		run.once('exit', (code, signal) => {
			clearTimeout(timeout);
			resolve({ code, signal });
		});
	});
	process.kill(-run.pid, 'SIGTERM');
	const result = await exitResult;
	assert.deepEqual(result, { code: null, signal: 'SIGTERM' });
	assert.deepEqual(
		fs.readdirSync(temporaryRoot).filter((entry) => entry.includes('muesly-eval')),
		[],
	);
	assert.deepEqual(
		fs.readdirSync(modelsDirectory).filter((entry) => entry.includes('muesly-eval')),
		[],
	);
});

test('rejects a benchmark executable replaced by its metrics child', (t) => {
	const realRun = fileURLToPath(new URL('./real-run.ts', import.meta.url));
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-executable-test-'));
	t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
	const { modelsDirectory } = writeFakeBenchmarkToolchain(
		temporaryRoot,
		`fs.writeFileSync(process.argv[1], '#!${process.execPath}\\nprocess.exit(0);\\n', { mode: 0o700 });
process.exit(0);`,
	);
	const run = spawnSync(
		process.execPath,
		[realRun, '--fixture', 'und-synthetic-silence', '--models-dir', modelsDirectory],
		{
			encoding: 'utf8',
			env: isolatedToolEnvironment(temporaryRoot),
		},
	);
	assert.equal(run.status, 1);
	assert.match(run.stderr, /benchmark executable changed during transcription/);
});
