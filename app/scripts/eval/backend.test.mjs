import assert from 'node:assert/strict';
import test from 'node:test';

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
