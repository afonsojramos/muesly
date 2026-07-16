import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateRunReports, renderMarkdown, validateRunReport } from './report.mjs';

function result(overrides = {}) {
	return {
		sample_id: 'meeting-en-clean',
		language: 'en',
		noise_condition: 'clean',
		passed: true,
		reference_words: 10,
		word_errors: 1,
		wer_percent: 10,
		hallucinated_words: null,
		metrics: {
			schema_version: 3,
			backend: 'metal',
			operating_system: 'macos',
			architecture: 'aarch64',
			hardware_profile:
				'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;accelerator=Apple M4 Pro integrated GPU',
			inference_seconds: 2,
			inference_rtf: 0.1,
			peak_rss_mb: 1000,
			audio_duration_seconds: 20,
		},
		...overrides,
	};
}

function report(results) {
	return {
		schema_version: 6,
		corpus_id: 'consented-meetings-v1',
		corpus_fingerprint: 'a'.repeat(64),
		provider: 'whisper',
		model: 'large-v3-turbo-q5_0',
		model_artifact_sha256: 'c'.repeat(64),
		thresholds: { max_wer_percent: 10, max_hallucinated_words: 2 },
		results,
	};
}

test('micro-averages WER and groups quality, speed, and memory across requested dimensions', () => {
	const aggregate = aggregateRunReports([
		report([
			result(),
			result({
				sample_id: 'meeting-es-office',
				language: 'es',
				noise_condition: 'office',
				reference_words: 90,
				word_errors: 18,
				wer_percent: 20,
				metrics: {
					schema_version: 3,
					backend: 'cuda',
					operating_system: 'macos',
					architecture: 'aarch64',
					hardware_profile:
						'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;accelerator=Apple M4 Pro integrated GPU',
					inference_seconds: 12,
					inference_rtf: 0.3,
					peak_rss_mb: 2000,
					audio_duration_seconds: 40,
				},
			}),
		]),
	]);

	assert.equal(aggregate.groups.overall.all.wer_percent, 19);
	assert.equal(aggregate.groups.overall.all.aggregate_inference_rtf, 14 / 60);
	assert.equal(aggregate.groups.overall.all.max_peak_rss_mb, 2000);
	assert.equal(aggregate.groups.language.en.wer_percent, 10);
	assert.equal(aggregate.groups.noise_condition.office.samples, 1);
	assert.equal(aggregate.groups.backend.cuda.samples, 1);
	assert.equal(aggregate.groups.language_noise_backend['es / office / cuda'].samples, 1);
	assert.equal(aggregate.operating_system, 'macos');
	assert.equal(aggregate.architecture, 'aarch64');
	assert.equal(
		aggregate.hardware_profile,
		'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;accelerator=Apple M4 Pro integrated GPU',
	);
	assert.deepEqual(aggregate.model_artifacts, {
		'whisper/large-v3-turbo-q5_0': 'c'.repeat(64),
	});
});

test('tracks silence hallucinations separately from WER', () => {
	const silence = result({
		sample_id: 'silence',
		reference_words: null,
		word_errors: null,
		wer_percent: null,
		hallucinated_words: 2,
	});
	const aggregate = aggregateRunReports([report([result(), silence])]);
	assert.equal(aggregate.groups.overall.all.wer_percent, 10);
	assert.equal(aggregate.groups.overall.all.hallucination_samples, 1);
	assert.equal(aggregate.groups.overall.all.hallucinated_words_total, 2);
	const markdown = renderMarkdown(aggregate);
	assert.match(markdown, /language noise backend/);
	assert.match(markdown, /Corpus: `consented-meetings-v1`/);
	assert.match(markdown, /Platform: `macos\/aarch64`/);
	assert.match(markdown, /Hardware profile: `cpu=Apple M4 Pro/);
	assert.match(markdown, /`whisper\/large-v3-turbo-q5_0`: `c{64}`/);
	assert.match(markdown, /WER ≤ 10\.00%; hallucinated words ≤ 2/);
	assert.doesNotMatch(markdown, /—%/);
});

test('rejects reports that cannot produce trustworthy weighted metrics', () => {
	const malformed = report([result({ reference_words: undefined, word_errors: undefined })]);
	assert.deepEqual(validateRunReport(malformed), [
		'report.results[0].reference_words must be a positive integer for WER samples',
		'report.results[0].word_errors must be a non-negative integer for WER samples',
	]);
	assert.throws(() => aggregateRunReports([malformed]), /invalid benchmark report/);
});

test('rejects mixed corpora and incompatible pass thresholds', () => {
	const first = report([result()]);
	const otherCorpus = { ...report([result()]), corpus_id: 'another-corpus' };
	assert.throws(() => aggregateRunReports([first, otherCorpus]), /different corpora/);

	const otherThreshold = {
		...report([result()]),
		thresholds: { max_wer_percent: 20, max_hallucinated_words: 2 },
	};
	assert.throws(() => aggregateRunReports([first, otherThreshold]), /different pass thresholds/);
});

test('rejects aggregation across hardware profiles', () => {
	const first = report([result()]);
	const otherPlatform = report([
		result({
			metrics: { ...result().metrics, operating_system: 'linux', architecture: 'x86_64' },
		}),
	]);
	assert.throws(() => aggregateRunReports([first, otherPlatform]), /different hardware profiles/);

	const otherMachine = report([
		result({
			metrics: {
				...result().metrics,
				hardware_profile:
					'cpu=Apple M1;logical_cpus=8;memory_bytes=17179869184;accelerator=Apple M1 integrated GPU',
			},
		}),
	]);
	assert.throws(() => aggregateRunReports([first, otherMachine]), /different hardware profiles/);
});

test('rejects legacy reports after corpus revision binding', () => {
	const legacy = { ...report([result()]), schema_version: 4 };
	assert.deepEqual(validateRunReport(legacy), ['report.schema_version must be 6']);
});

test('rejects aggregation across corpus revisions', () => {
	const first = report([result()]);
	const stale = { ...report([result()]), corpus_fingerprint: 'b'.repeat(64) };
	assert.throws(() => aggregateRunReports([first, stale]), /different corpus revisions/);
});

test('rejects aggregation across different bytes for the same model', () => {
	const first = report([result()]);
	const differentArtifact = { ...report([result()]), model_artifact_sha256: 'd'.repeat(64) };
	assert.throws(
		() => aggregateRunReports([first, differentArtifact]),
		/different artifacts for model 'whisper\/large-v3-turbo-q5_0'/,
	);
});

test('rejects fractional hallucination thresholds', () => {
	const fractional = {
		...report([result()]),
		thresholds: { max_wer_percent: 10, max_hallucinated_words: 0.5 },
	};
	assert.deepEqual(validateRunReport(fractional), [
		'report.thresholds.max_hallucinated_words must be an integer',
	]);
});
