import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { corpusFingerprint } from './corpus.ts';
import { evaluateCoverage, formatCoverage, validateCoverageTargets } from './coverage.ts';

const targets = {
	schema_version: 1,
	target_id: 'test-targets',
	languages: ['en', 'es'],
	noise_conditions: ['clean', 'office'],
	benchmark_variants: [
		{ provider: 'whisper', model: 'test-model', backend: 'metal' },
		{ provider: 'parakeet', model: 'test-model', backend: 'onnx-cpu' },
	],
	min_sessions_per_language_noise_cell: 2,
};

test('accepts the committed multilingual benchmark target', () => {
	const committed = JSON.parse(
		fs.readFileSync(new URL('./corpus-targets.json', import.meta.url), 'utf8'),
	);
	assert.deepEqual(validateCoverageTargets(committed), []);
	assert.equal(committed.languages.length * committed.noise_conditions.length, 20);
	assert.equal(committed.benchmark_variants.length, 3);
});

function sample(language, noise, session) {
	return {
		id: `${language}-${noise}-${session}`,
		session_id: `session-${session}`,
		audio_sha256: `${session.padEnd(64, '0').slice(0, 64)}`,
		language,
		noise_condition: noise,
		scenario: 'meeting',
		provenance: { basis: 'participant-consent' },
	};
}

function runReport(corpus, backend, options = {}) {
	const reportSamples = options.samples ?? corpus.samples;
	return {
		schema_version: 7,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		provider: backend === 'onnx-cpu' ? 'parakeet' : 'whisper',
		model: 'test-model',
		model_artifact_sha256: backend === 'onnx-cpu' ? 'd'.repeat(64) : 'c'.repeat(64),
		thresholds: { max_wer_percent: 10, max_hallucinated_words: 2 },
		results: reportSamples.map((corpusSample) => ({
			sample_id: corpusSample.id,
			language: corpusSample.language,
			noise_condition: corpusSample.noise_condition,
			passed: true,
			reference_words: 10,
			word_errors: 1,
			hallucinated_words: null,
			metrics: {
				schema_version: 4,
				backend,
				operating_system: options.operatingSystem ?? 'macos',
				architecture: options.architecture ?? 'aarch64',
				hardware_profile:
					options.hardwareProfile ?? 'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776',
				accelerator:
					options.accelerator ?? (backend === 'onnx-cpu' ? 'none' : 'Apple M4 Pro integrated GPU'),
				inference_seconds: 1,
				inference_rtf: 0.1,
				peak_rss_mb: 100,
				audio_duration_seconds: 10,
			},
		})),
	};
}

function completeCorpus() {
	const samples = [];
	for (const language of targets.languages) {
		for (const noise of targets.noise_conditions) {
			for (let session = 1; session <= 2; session += 1) {
				samples.push(sample(language, noise, `${language}-${noise}-${session}`));
			}
		}
	}
	return { corpus_id: 'test-corpus', corpus_fingerprint: 'a'.repeat(64), samples };
}

test('requires distinct sessions for every language and noise cell', () => {
	const corpus = completeCorpus();
	corpus.samples[1].session_id = corpus.samples[0].session_id;
	const coverage = evaluateCoverage(corpus, targets);
	assert.equal(coverage.corpus.covered_cells, 3);
	assert.deepEqual(coverage.corpus.missing_cells, ['en / clean']);
	assert.equal(coverage.complete, false);
	assert.match(formatCoverage(coverage), /Missing measurement cells: en \/ clean/);
});

test('rejects copied audio assigned to different sessions', () => {
	const corpus = completeCorpus();
	corpus.samples[1].audio_sha256 = corpus.samples[0].audio_sha256;
	assert.throws(() => evaluateCoverage(corpus, targets), /reuse identical audio/);
});

test('rejects copied audio relabeled within the same session', () => {
	const corpus = completeCorpus();
	corpus.samples[1].session_id = corpus.samples[0].session_id;
	corpus.samples[1].audio_sha256 = corpus.samples[0].audio_sha256;
	assert.throws(() => evaluateCoverage(corpus, targets), /reuse identical audio/);
});

test('requires measurements for every language, noise, and backend cell', () => {
	const corpus = completeCorpus();
	const partial = evaluateCoverage(corpus, targets, [runReport(corpus, 'metal')]);
	assert.equal(partial.corpus.covered_cells, 4);
	assert.equal(partial.measurements.covered_cells, 4);
	assert.equal(partial.complete, false);

	const complete = evaluateCoverage(corpus, targets, [
		runReport(corpus, 'metal'),
		runReport(corpus, 'onnx-cpu'),
	]);
	assert.equal(complete.measurements.covered_cells, 8);
	assert.equal(complete.complete, true);
	assert.equal(complete.schema_version, 4);
	assert.equal(complete.corpus_fingerprint, corpus.corpus_fingerprint);
	assert.deepEqual(complete.measurements.compatible_counts, complete.measurements.counts);
	assert.deepEqual(complete.measurements.hardware_split_cells, []);
	assert.deepEqual(complete.model_artifacts, {
		'parakeet/test-model': 'd'.repeat(64),
		'whisper/test-model': 'c'.repeat(64),
	});
});

test('does not combine sessions from incompatible hardware profiles', () => {
	const corpus = completeCorpus();
	const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
	const secondSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-2'));
	const coverage = evaluateCoverage(corpus, targets, [
		runReport(corpus, 'metal', {
			samples: firstSessions,
			hardwareProfile: 'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776',
			accelerator: 'Shared Metal GPU',
		}),
		runReport(corpus, 'metal', {
			samples: secondSessions,
			hardwareProfile: 'cpu=Apple M3 Max;logical_cpus=16;memory_bytes=68719476736',
			accelerator: 'Shared Metal GPU',
		}),
		runReport(corpus, 'onnx-cpu'),
	]);

	const cell = 'en / clean / whisper / test-model / metal';
	assert.equal(coverage.measurements.counts[cell], 2);
	assert.equal(coverage.measurements.compatible_counts[cell], 1);
	assert.deepEqual(
		coverage.measurements.hardware_cohorts[cell].map((cohort) => ({
			hardware_profile: cohort.hardware_profile,
			accelerator: cohort.accelerator,
			distinct_sessions: cohort.distinct_sessions,
		})),
		[
			{
				hardware_profile: 'cpu=Apple M3 Max;logical_cpus=16;memory_bytes=68719476736',
				accelerator: 'Shared Metal GPU',
				distinct_sessions: 1,
			},
			{
				hardware_profile: 'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776',
				accelerator: 'Shared Metal GPU',
				distinct_sessions: 1,
			},
		],
	);
	assert.equal(coverage.measurements.covered_cells, 4);
	assert(coverage.measurements.missing_cells.includes(cell));
	assert(coverage.measurements.hardware_split_cells.includes(cell));
	assert.equal(coverage.complete, false);
	assert.match(formatCoverage(coverage), /Hardware-split measurement cells: en \/ clean/);
});

test('combines separate reports only when their complete hardware cohort matches', () => {
	const corpus = completeCorpus();
	const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
	const secondSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-2'));
	const coverage = evaluateCoverage(corpus, targets, [
		runReport(corpus, 'metal', { samples: firstSessions }),
		runReport(corpus, 'metal', { samples: secondSessions }),
		runReport(corpus, 'onnx-cpu'),
	]);

	const cell = 'en / clean / whisper / test-model / metal';
	assert.equal(coverage.measurements.counts[cell], 2);
	assert.equal(coverage.measurements.compatible_counts[cell], 2);
	assert.equal(coverage.measurements.hardware_cohorts[cell].length, 1);
	assert.equal(coverage.measurements.hardware_cohorts[cell][0].distinct_sessions, 2);
	assert.equal(coverage.complete, true);
});

test('treats different accelerators as incompatible hardware cohorts', () => {
	const corpus = completeCorpus();
	const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
	const secondSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-2'));
	const coverage = evaluateCoverage(corpus, targets, [
		runReport(corpus, 'metal', { samples: firstSessions }),
		runReport(corpus, 'metal', {
			samples: secondSessions,
			accelerator: 'External Metal GPU',
		}),
		runReport(corpus, 'onnx-cpu'),
	]);

	const cell = 'en / clean / whisper / test-model / metal';
	assert.equal(coverage.measurements.counts[cell], 2);
	assert.equal(coverage.measurements.compatible_counts[cell], 1);
	assert.equal(coverage.measurements.hardware_cohorts[cell].length, 2);
	assert(coverage.measurements.hardware_split_cells.includes(cell));
	assert.equal(coverage.complete, false);
});

test('treats operating system and architecture changes as incompatible hardware cohorts', async (t) => {
	for (const [dimension, options] of [
		['operating system', { operatingSystem: 'linux' }],
		['architecture', { architecture: 'x86_64' }],
	]) {
		await t.test(dimension, () => {
			const corpus = completeCorpus();
			const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
			const secondSessions = corpus.samples.filter((corpusSample) =>
				corpusSample.id.endsWith('-2'),
			);
			const coverage = evaluateCoverage(corpus, targets, [
				runReport(corpus, 'metal', { samples: firstSessions }),
				runReport(corpus, 'metal', { samples: secondSessions, ...options }),
				runReport(corpus, 'onnx-cpu'),
			]);

			const cell = 'en / clean / whisper / test-model / metal';
			assert.equal(coverage.measurements.counts[cell], 2);
			assert.equal(coverage.measurements.compatible_counts[cell], 1);
			assert.equal(coverage.measurements.hardware_cohorts[cell].length, 2);
			assert(coverage.measurements.hardware_split_cells.includes(cell));
			assert.equal(coverage.complete, false);
		});
	}
});

test('rejects malformed targets and reports for another corpus', () => {
	assert(validateCoverageTargets({}).length > 0);
	const corpus = completeCorpus();
	const report = { ...runReport(corpus, 'metal'), corpus_id: 'wrong-corpus' };
	assert.throws(() => evaluateCoverage(corpus, targets, [report]), /does not match/);
});

test('rejects stale reports after a corpus revision changes', () => {
	const corpus = completeCorpus();
	const stale = { ...runReport(corpus, 'metal'), corpus_fingerprint: 'b'.repeat(64) };
	assert.throws(() => evaluateCoverage(corpus, targets, [stale]), /fingerprint does not match/);
});

test('rejects coverage assembled from different bytes for the same model', () => {
	const corpus = completeCorpus();
	const first = runReport(corpus, 'metal');
	const changed = { ...runReport(corpus, 'metal'), model_artifact_sha256: 'e'.repeat(64) };
	assert.throws(
		() => evaluateCoverage(corpus, targets, [first, changed]),
		/different artifacts for model 'whisper\/test-model'/,
	);
});

test('writes coverage through the managed local corpus results path', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-coverage-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	fs.mkdirSync(path.join(directory, 'local-corpus'));
	const document = {
		schema_version: 2,
		corpus_id: 'local-consented-meetings',
		description: 'Local consented corpus.',
		distribution: 'local',
		samples: [],
	};
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	const targetsPath = path.join(directory, 'targets.json');
	fs.writeFileSync(targetsPath, JSON.stringify(targets));
	const outputPath = path.join(directory, 'results', 'coverage.json');
	const scriptPath = fileURLToPath(new URL('./coverage.ts', import.meta.url));
	const run = spawnSync(
		process.execPath,
		[scriptPath, '--manifest', manifestPath, '--targets', targetsPath, '--json', outputPath],
		{ encoding: 'utf8' },
	);
	assert.equal(run.status, 0, run.stderr);
	const coverage = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
	assert.equal(coverage.corpus_fingerprint, corpusFingerprint(document));
	assert.equal(coverage.complete, false);

	const outside = spawnSync(
		process.execPath,
		[
			scriptPath,
			'--manifest',
			manifestPath,
			'--targets',
			targetsPath,
			'--json',
			path.join(directory, 'outside.json'),
		],
		{ encoding: 'utf8' },
	);
	assert.equal(outside.status, 2);
	assert.match(outside.stderr, /managed results directory/);
});
