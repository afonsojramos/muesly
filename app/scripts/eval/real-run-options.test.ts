import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRealRunArgs } from './real-run-options.ts';

const defaults = {
	defaultManifest: '/private/corpus.json',
	platform: 'darwin',
	architecture: 'arm64',
};

test('parses every real-run option exactly once', () => {
	assert.deepEqual(
		parseRealRunArgs(
			[
				'--max-wer',
				'12.5',
				'--max-hallucinated-words',
				'3',
				'--provider',
				'whisper',
				'--model',
				'large-v3-turbo-q5_0',
				'--models-dir',
				'/private/models',
				'--manifest',
				'/private/local.json',
				'--backend',
				'metal',
				'--accelerator',
				'Apple M4 Pro integrated GPU',
				'--output',
				'/private/results/run.json',
				'--fixture',
				'en-clean-session',
			],
			defaults,
		),
		{
			maxWerPct: 12.5,
			maxHallucinatedWords: 3,
			provider: 'whisper',
			backend: 'metal',
			accelerator: 'Apple M4 Pro integrated GPU',
			model: 'large-v3-turbo-q5_0',
			modelsDir: '/private/models',
			onlyFixture: 'en-clean-session',
			manifestPath: '/private/local.json',
			outputPath: '/private/results/run.json',
		},
	);
});

test('uses provider-aware defaults', () => {
	assert.equal(parseRealRunArgs([], defaults).model, 'tiny');
	assert.equal(
		parseRealRunArgs(['--provider', 'parakeet'], defaults).model,
		'parakeet-tdt-0.6b-v3-int8',
	);
});

test('rejects unknown, duplicate, and positional options', () => {
	for (const args of [
		['--backnd', 'metal'],
		['--backend', 'cpu', '--backend', 'metal'],
		['unexpected-positional'],
	]) {
		assert.throws(() => parseRealRunArgs(args, defaults), /unknown option|provided once/);
	}
});

test('validates numeric and backend-specific values', () => {
	assert.throws(
		() => parseRealRunArgs(['--max-wer', '-1'], defaults),
		/non-negative number/,
	);
	assert.throws(
		() => parseRealRunArgs(['--max-hallucinated-words', '1.5'], defaults),
		/non-negative integer/,
	);
	assert.throws(
		() =>
			parseRealRunArgs(['--provider', 'parakeet', '--backend', 'metal'], defaults),
		/Parakeet currently supports only/,
	);
	assert.throws(
		() =>
			parseRealRunArgs(['--backend', 'cuda'], {
				...defaults,
				platform: 'linux',
				architecture: 'x64',
			}),
		/requires --accelerator/,
	);
});
