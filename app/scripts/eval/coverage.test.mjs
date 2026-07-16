import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { evaluateCoverage, formatCoverage, validateCoverageTargets } from './coverage.mjs';

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
		language,
		noise_condition: noise,
		scenario: 'meeting',
		provenance: { basis: 'participant-consent' },
	};
}

function runReport(corpus, backend) {
	return {
		schema_version: 3,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		provider: backend === 'onnx-cpu' ? 'parakeet' : 'whisper',
		model: 'test-model',
		thresholds: { max_wer_percent: 10, max_hallucinated_words: 2 },
		results: corpus.samples.map((corpusSample) => ({
			sample_id: corpusSample.id,
			language: corpusSample.language,
			noise_condition: corpusSample.noise_condition,
			passed: true,
			reference_words: 10,
			word_errors: 1,
			hallucinated_words: null,
			metrics: {
				backend,
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
