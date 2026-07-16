import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCorpusBenchmarkArgs } from './corpus-benchmark-options.ts';

const defaults = {
	defaultManifest: '/private/corpus-local.json',
	defaultTargets: '/repo/corpus-targets.json',
};

test('uses safe planning defaults', () => {
	assert.deepEqual(parseCorpusBenchmarkArgs([], defaults), {
		manifestPath: defaults.defaultManifest,
		targetsPath: defaults.defaultTargets,
		modelsDir: null,
		maxWerPct: 10,
		maxHallucinatedWords: 2,
		selectedVariants: [],
		accelerators: {},
		run: false,
		requireComplete: false,
	});
});

test('parses execution, thresholds, repeated variants, and accelerator identities', () => {
	assert.deepEqual(
		parseCorpusBenchmarkArgs(
			[
				'--manifest',
				'/private/manifest.json',
				'--targets',
				'/repo/targets.json',
				'--models-dir',
				'/models',
				'--max-wer',
				'12.5',
				'--max-hallucinated-words',
				'1',
				'--variant',
				'whisper/large-v3-turbo-q5_0/metal',
				'--variant',
				'parakeet/parakeet-tdt-0.6b-v3-int8/onnx-cpu',
				'--accelerator',
				'metal=Apple M4 Pro integrated GPU',
				'--run',
				'--require-complete',
			],
			defaults,
		),
		{
			manifestPath: '/private/manifest.json',
			targetsPath: '/repo/targets.json',
			modelsDir: '/models',
			maxWerPct: 12.5,
			maxHallucinatedWords: 1,
			selectedVariants: [
				'whisper/large-v3-turbo-q5_0/metal',
				'parakeet/parakeet-tdt-0.6b-v3-int8/onnx-cpu',
			],
			accelerators: { metal: 'Apple M4 Pro integrated GPU' },
			run: true,
			requireComplete: true,
		},
	);
});

test('rejects unknown, duplicated, incomplete, and malformed options', () => {
	for (const [args, message] of [
		[['--wat'], /unknown option/],
		[['--manifest'], /requires a value/],
		[['--run', '--run'], /may only be provided once/],
		[['--variant', 'whisper/model/cpu', '--variant', 'whisper/model/cpu'], /duplicates/],
		[['--variant', 'whisper/model'], /provider\/model\/backend/],
		[['--variant', 'Whisper/model/cpu'], /lowercase slug/],
		[['--accelerator', 'cuda'], /backend=stable-device-id/],
		[['--accelerator', 'cuda=GPU;other'], /backend=stable-device-id/],
		[['--accelerator', 'cuda=GPU 1', '--accelerator', 'cuda=GPU 2'], /duplicates backend/],
		[['--max-wer', '-1'], /non-negative number/],
		[['--max-hallucinated-words', '0.5'], /non-negative integer/],
	]) {
		assert.throws(() => parseCorpusBenchmarkArgs(args, defaults), message);
	}
});

test('requires explicit default paths from callers', () => {
	assert.throws(
		() => parseCorpusBenchmarkArgs([], { defaultTargets: defaults.defaultTargets }),
		/defaultManifest is required/,
	);
	assert.throws(
		() => parseCorpusBenchmarkArgs([], { defaultManifest: defaults.defaultManifest }),
		/defaultTargets is required/,
	);
});
