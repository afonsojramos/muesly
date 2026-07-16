import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
	process.stdout.write(JSON.stringify({ schema_version: 1, provider, model }) + '\\n');
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
		fs.readdirSync(temporaryRoot).filter((entry) => entry.startsWith('muesly-eval-')),
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
