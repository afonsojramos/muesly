import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { forcesWhisperCpu, requiresWhisperGpu, supportedBackends } from './backend.mjs';

test('requires strict acceleration only for Whisper GPU backends', () => {
	for (const backend of ['metal', 'cuda', 'vulkan', 'hipblas']) {
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

test('rejects missing output paths before starting a benchmark', () => {
	const realRun = fileURLToPath(new URL('./real-run.mjs', import.meta.url));
	for (const args of [['--output'], ['--output', '--fixture', 'en-gettysburg-clean']]) {
		const run = spawnSync(process.execPath, [realRun, ...args], { encoding: 'utf8' });
		assert.equal(run.status, 2);
		assert.match(run.stderr, /--output requires a value/);
		assert.doesNotMatch(run.stderr, /running real/);
	}
});

test('selects fixtures only by unique manifest sample ID', () => {
	const realRun = fileURLToPath(new URL('./real-run.mjs', import.meta.url));
	const run = spawnSync(process.execPath, [realRun, '--fixture', 'real-speech'], {
		encoding: 'utf8',
	});
	assert.equal(run.status, 2);
	assert.match(run.stderr, /no corpus sample named 'real-speech'/);
	assert.doesNotMatch(run.stderr, /running real/);
});

test('removes temporary metrics after a failed transcription process', () => {
	const realRun = fileURLToPath(new URL('./real-run.mjs', import.meta.url));
	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-eval-cleanup-test-'));
	const binDirectory = path.join(temporaryRoot, 'bin');
	fs.mkdirSync(binDirectory);
	fs.writeFileSync(path.join(binDirectory, 'cargo'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
	const run = spawnSync(
		process.execPath,
		[realRun, '--fixture', 'und-synthetic-silence'],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
				TMPDIR: temporaryRoot,
			},
		},
	);
	assert.equal(run.status, 7);
	assert.deepEqual(
		fs.readdirSync(temporaryRoot).filter((entry) => entry.startsWith('muesly-eval-')),
		[],
	);
	fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
