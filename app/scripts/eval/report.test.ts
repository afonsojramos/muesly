import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { corpusFingerprint } from './corpus.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import {
	aggregateRunReports,
	renderMarkdown,
	validateBenchmarkMetrics,
	validateRunReport,
	validateRunReportsAgainstCorpus,
} from './report.ts';
import { WER_SCORER_ID } from './wer.ts';

const BENCHMARK_EXECUTABLE_SHA256 = 'b'.repeat(64);
const RUNTIME_ENV_SHA256 = '5'.repeat(64);

function hardwareProfile(cpu, logicalCpus, memoryBytes) {
	return (
		`cpu=${cpu};logical_cpus=${logicalCpus};memory_bytes=${memoryBytes};` +
		`runtime_env_sha256=${RUNTIME_ENV_SHA256}`
	);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function evaluatorRevision(cargoFeatures = ['metal'], overrides = {}) {
	return {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: '1'.repeat(40),
		cargo_lock_sha256: '2'.repeat(64),
		rustc_vv: [
			'rustc 1.88.0 (6b00bc388 2025-06-23)',
			'binary: rustc',
			`commit-hash: ${'3'.repeat(40)}`,
			'commit-date: 2025-06-23',
			'host: aarch64-apple-darwin',
			'release: 1.88.0',
			'LLVM version: 20.1.5',
		].join('\n'),
		build_profile: 'release',
		target_triple: 'aarch64-apple-darwin',
		cargo_features: cargoFeatures,
		build_env_sha256: '4'.repeat(64),
		...overrides,
	};
}

function result(overrides = {}) {
	const { metrics: metricsOverrides = {}, ...resultOverrides } = overrides;
	return {
		sample_id: 'meeting-en-clean',
		language: 'en',
		noise_condition: 'clean',
		scenario: 'meeting',
		speakers: 3,
		provenance_basis: 'participant-consent',
		passed: true,
		reference_words: 10,
		word_errors: 1,
		wer_percent: 10,
		hallucinated_words: null,
		metrics: {
			schema_version: 5,
			provider: 'whisper',
			model: 'large-v3-turbo-q5_0',
			backend: 'metal',
			operating_system: 'macos',
			architecture: 'aarch64',
			hardware_profile: hardwareProfile('Apple M4 Pro', 14, 25_769_803_776),
			accelerator: 'Apple M4 Pro integrated GPU',
			benchmark_executable_sha256: BENCHMARK_EXECUTABLE_SHA256,
			audio_duration_seconds: 20,
			decode_seconds: 0.1,
			vad_seconds: 0.2,
			model_download_seconds: 0,
			model_load_seconds: 1,
			inference_seconds: 2,
			inference_rtf: 0.1,
			measured_total_seconds: 3.5,
			baseline_rss_mb: 100,
			peak_rss_mb: 1000,
			peak_rss_delta_mb: 900,
			...metricsOverrides,
		},
		...resultOverrides,
	};
}

function report(results, overrides = {}) {
	const revision = overrides.evaluator_revision ?? evaluatorRevision();
	return {
		schema_version: 9,
		corpus_id: 'consented-meetings-v1',
		corpus_fingerprint: 'a'.repeat(64),
		started_at: '2026-07-16T10:00:00.000Z',
		completed_at: '2026-07-16T10:01:00.000Z',
		wer_scorer: WER_SCORER_ID,
		evaluator_revision: revision,
		evaluator_revision_sha256:
			overrides.evaluator_revision_sha256 ?? evaluatorRevisionSha256(revision),
		benchmark_executable_sha256: BENCHMARK_EXECUTABLE_SHA256,
		provider: 'whisper',
		model: 'large-v3-turbo-q5_0',
		model_artifact_sha256: 'c'.repeat(64),
		thresholds: { max_wer_percent: 10, max_hallucinated_words: 2 },
		passed: results.every((entry) => entry.passed),
		results,
		...overrides,
	};
}

function boundReport({
	provider = 'whisper',
	backend,
	cargoFeatures,
	targetTriple,
	operatingSystem,
	architecture,
}) {
	const model = provider === 'parakeet' ? 'parakeet-test' : 'whisper-test';
	const accelerator = ['cpu', 'openblas-cpu', 'onnx-cpu'].includes(backend)
		? 'none'
		: 'stable-accelerator-id';
	return report(
		[
			result({
				metrics: {
					provider,
					model,
					backend,
					operating_system: operatingSystem,
					architecture,
					hardware_profile: hardwareProfile(
						`test ${operatingSystem}/${architecture}`,
						8,
						17_179_869_184,
					),
					accelerator,
				},
			}),
		],
		{
			provider,
			model,
			evaluator_revision: evaluatorRevision(cargoFeatures, {
				target_triple: targetTriple,
			}),
		},
	);
}

function corpusSample(overrides = {}) {
	const { provenance: provenanceOverrides = {}, ...sampleOverrides } = overrides;
	return {
		id: 'meeting-en-clean',
		language: 'en',
		noise_condition: 'clean',
		scenario: 'meeting',
		speakers: 3,
		duration_seconds: 20,
		provenance: {
			basis: 'participant-consent',
			...provenanceOverrides,
		},
		...sampleOverrides,
	};
}

function loadedCorpus(samples = [corpusSample()], overrides = {}) {
	return {
		corpus_id: 'consented-meetings-v1',
		corpus_fingerprint: 'a'.repeat(64),
		samples,
		...overrides,
	};
}

test('micro-averages WER and groups quality, speed, and memory across requested dimensions', () => {
	const aggregate = aggregateRunReports([
		report([result()]),
		report(
			[
				result({
					sample_id: 'meeting-es-office',
					language: 'es',
					noise_condition: 'office',
					reference_words: 90,
					word_errors: 18,
					wer_percent: 20,
					passed: false,
					metrics: {
						backend: 'cpu',
						accelerator: 'none',
						inference_seconds: 12,
						inference_rtf: 0.3,
						measured_total_seconds: 13.5,
						peak_rss_mb: 2000,
						audio_duration_seconds: 40,
						peak_rss_delta_mb: 1900,
					},
				}),
			],
			{ evaluator_revision: evaluatorRevision([]) },
		),
	]);

	assert.equal(aggregate.groups.overall.all.wer_percent, 19);
	assert.equal(aggregate.groups.overall.all.aggregate_inference_rtf, 14 / 60);
	assert.equal(aggregate.groups.overall.all.max_peak_rss_mb, 2000);
	assert.equal(aggregate.groups.language.en.wer_percent, 10);
	assert.equal(aggregate.groups.noise_condition.office.samples, 1);
	assert.equal(aggregate.groups.backend.cpu.samples, 1);
	assert.equal(aggregate.groups.language_noise_backend['es / office / cpu'].samples, 1);
	assert.equal(aggregate.schema_version, 5);
	assert.equal(aggregate.wer_scorer, WER_SCORER_ID);
	assert.equal(
		aggregate.evaluator_revisions.metal.evaluator_revision_sha256,
		evaluatorRevisionSha256(evaluatorRevision()),
	);
	assert.equal(
		aggregate.evaluator_revisions.cpu.evaluator_revision_sha256,
		evaluatorRevisionSha256(evaluatorRevision([])),
	);
	assert.deepEqual(aggregate.benchmark_executables, {
		cpu: BENCHMARK_EXECUTABLE_SHA256,
		metal: BENCHMARK_EXECUTABLE_SHA256,
	});
	assert.equal(aggregate.operating_system, 'macos');
	assert.equal(aggregate.architecture, 'aarch64');
	assert.equal(aggregate.hardware_profile, hardwareProfile('Apple M4 Pro', 14, 25_769_803_776));
	assert.deepEqual(aggregate.accelerators, {
		cpu: 'none',
		metal: 'Apple M4 Pro integrated GPU',
	});
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
	assert.match(markdown, /WER scorer: `muesly-wer-unicode-v1`/);
	assert.match(markdown, /Platform: `macos\/aarch64`/);
	assert.match(markdown, /Hardware profile: `cpu=Apple M4 Pro/);
	assert.match(markdown, /Accelerators: `metal` = `Apple M4 Pro integrated GPU`/);
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

test('rejects duplicate sample measurements within one run report', () => {
	const duplicate = report([result(), result()]);
	assert.match(
		validateRunReport(duplicate).join('\n'),
		/report\.results\[1\]\.sample_id duplicates report\.results\[0\]\.sample_id 'meeting-en-clean'/,
	);
	assert.throws(() => aggregateRunReports([duplicate]), /duplicates reports\[0\]\.results\[0\]/);
});

test('rejects duplicate provider/model/backend/sample measurements across aggregate inputs', () => {
	const first = report([result()]);
	const duplicate = structuredClone(first);
	assert.throws(
		() => aggregateRunReports([first, duplicate]),
		/duplicate provider\/model\/backend\/sample_id measurement .*meeting-en-clean/,
	);

	const otherModel = report([result({ metrics: { model: 'another-model' } })], {
		model: 'another-model',
		model_artifact_sha256: 'd'.repeat(64),
	});
	assert.equal(aggregateRunReports([first, otherModel]).sample_result_count, 2);
});

test('validates reports against canonical loaded corpus identity and sample metadata', () => {
	const corpus = loadedCorpus();
	assert.deepEqual(validateRunReportsAgainstCorpus([report([result()])], corpus), []);

	const wrongCorpus = report([result()], {
		corpus_id: 'another-corpus',
		corpus_fingerprint: 'f'.repeat(64),
	});
	const corpusErrors = validateRunReportsAgainstCorpus([wrongCorpus], corpus).join('\n');
	assert.match(corpusErrors, /reports\[0\]\.corpus_id must match corpus\.corpus_id/);
	assert.match(
		corpusErrors,
		/reports\[0\]\.corpus_fingerprint must match corpus\.corpus_fingerprint/,
	);

	const mismatchedMetadata = report([
		result({
			language: 'es',
			noise_condition: 'office',
			scenario: 'dictation',
			speakers: 1,
			provenance_basis: 'synthetic',
		}),
	]);
	const metadataErrors = validateRunReportsAgainstCorpus([mismatchedMetadata], corpus).join('\n');
	for (const field of ['language', 'noise_condition', 'scenario', 'speakers', 'provenance_basis']) {
		assert.match(
			metadataErrors,
			new RegExp(`reports\\[0\\]\\.results\\[0\\]\\.${field} must match corpus sample`),
		);
	}

	const unknownSample = report([result({ sample_id: 'meeting-unknown' })]);
	assert.match(
		validateRunReportsAgainstCorpus([unknownSample], corpus).join('\n'),
		/sample_id 'meeting-unknown' is not present in the corpus/,
	);

	const wrongDuration = report([result({ metrics: { audio_duration_seconds: 19 } })]);
	assert.match(
		validateRunReportsAgainstCorpus([wrongDuration], corpus).join('\n'),
		/audio_duration_seconds must match corpus sample/,
	);
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

test('rejects metrics platforms that disagree with evaluator targets and hardware profiles', () => {
	const first = report([result()]);
	const otherPlatform = report([
		result({
			metrics: { ...result().metrics, operating_system: 'linux', architecture: 'x86_64' },
		}),
	]);
	const platformErrors = validateRunReport(otherPlatform).join('\n');
	assert.match(platformErrors, /operating_system must match report\.evaluator_revision/);
	assert.match(platformErrors, /architecture must match report\.evaluator_revision/);

	const otherMachine = report([
		result({
			metrics: {
				...result().metrics,
				hardware_profile: hardwareProfile('Apple M1', 8, 17_179_869_184),
			},
		}),
	]);
	assert.throws(() => aggregateRunReports([first, otherMachine]), /different hardware profiles/);
});

test('allows cross-backend reports on one machine but rejects mixed accelerators per backend', () => {
	const metal = report([result()]);
	const cpu = report(
		[
			result({
				metrics: {
					...result().metrics,
					backend: 'cpu',
					accelerator: 'none',
				},
			}),
		],
		{ evaluator_revision: evaluatorRevision([]) },
	);
	assert.deepEqual(aggregateRunReports([metal, cpu]).accelerators, {
		cpu: 'none',
		metal: 'Apple M4 Pro integrated GPU',
	});

	const otherMetal = report([
		result({
			metrics: { ...result().metrics, accelerator: 'External GPU' },
		}),
	]);
	assert.throws(
		() => aggregateRunReports([metal, otherMetal]),
		/different accelerators for backend 'metal'/,
	);
});

test('rejects legacy reports and missing scorer provenance', () => {
	const legacy = { ...report([result()]), schema_version: 8 };
	assert.deepEqual(validateRunReport(legacy), ['report.schema_version must be 9']);
	assert.throws(
		() => aggregateRunReports([report([result()]), legacy]),
		/schema_version must be 9/,
	);

	const missingScorer = { ...report([result()]), wer_scorer: undefined };
	assert.deepEqual(validateRunReport(missingScorer), [
		'report.wer_scorer must be a lowercase versioned identifier ending in -v<number>',
	]);
});

test('rejects aggregation across WER scoring semantics', () => {
	const first = report([result()]);
	const differentScorer = { ...report([result()]), wer_scorer: 'muesly-wer-unicode-v2' };
	assert.throws(() => aggregateRunReports([first, differentScorer]), /different WER scorers/);
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

test('binds Core ML artifacts by reported backend while preserving other model keys', () => {
	const metal = report([result()]);
	const coreMl = report(
		[
			result({
				sample_id: 'meeting-en-office',
				noise_condition: 'office',
				metrics: {
					backend: 'coreml-metal',
					accelerator: 'Apple M4 Pro Neural Engine',
				},
			}),
		],
		{
			evaluator_revision: evaluatorRevision(['coreml']),
			model_artifact_sha256: 'd'.repeat(64),
		},
	);
	const aggregate = aggregateRunReports([metal, coreMl]);
	assert.deepEqual(aggregate.model_artifacts, {
		'whisper/large-v3-turbo-q5_0': 'c'.repeat(64),
		'whisper/large-v3-turbo-q5_0/coreml-metal': 'd'.repeat(64),
	});

	const changedCoreMl = structuredClone(coreMl);
	changedCoreMl.results[0].sample_id = 'meeting-en-remote';
	changedCoreMl.results[0].noise_condition = 'remote-call';
	changedCoreMl.model_artifact_sha256 = 'e'.repeat(64);
	assert.throws(
		() => aggregateRunReports([coreMl, changedCoreMl]),
		/different artifacts for model 'whisper\/large-v3-turbo-q5_0\/coreml-metal'/,
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

test('requires closed report, threshold, result, and metrics schemas without sensitive fields', () => {
	const malformed = report([result()]);
	malformed.debug = { text: 'not safe to persist' };
	malformed.thresholds.mode = 'custom';
	malformed.results[0].metadata = { text: 'not safe to persist' };
	malformed.results[0].metrics.driver_notes = 'not safe to persist';
	malformed.results[0].transcript_text = 'private words';
	delete malformed.results[0].scenario;

	const errors = validateRunReport(malformed).join('\n');
	assert.match(errors, /report\.debug is not allowed/);
	assert.match(errors, /report\.thresholds\.mode is not allowed/);
	assert.match(errors, /report\.results\[0\]\.metadata is not allowed/);
	assert.match(errors, /report\.results\[0\]\.metrics\.driver_notes is not allowed/);
	assert.match(errors, /report\.results\[0\]\.transcript_text is a forbidden sensitive report key/);
	assert.match(errors, /report\.results\[0\]\.scenario is required/);
});

test('requires ordered canonical timestamps and matching evaluator provenance digests', () => {
	const malformed = report([result()], {
		started_at: '2026-07-16T10:01:00Z',
		completed_at: '2026-07-16T10:00:00.000Z',
		evaluator_revision_sha256: 'f'.repeat(64),
	});
	const errors = validateRunReport(malformed).join('\n');
	assert.match(errors, /started_at must be a canonical ISO-8601 timestamp/);
	assert.match(errors, /evaluator_revision_sha256 must match/);

	const reversed = report([result()], {
		started_at: '2026-07-16T10:02:00.000Z',
		completed_at: '2026-07-16T10:01:00.000Z',
	});
	assert.match(validateRunReport(reversed).join('\n'), /completed_at must not precede/);

	const invalidRevision = report([result()]);
	invalidRevision.evaluator_revision.private_transcript = 'private';
	assert.match(
		validateRunReport(invalidRevision).join('\n'),
		/report\.evaluator_revision\.private_transcript is not allowed/,
	);
});

test('validates complete metrics identity, timing arithmetic, and RSS arithmetic', () => {
	const malformed = report([
		result({
			metrics: {
				provider: 'parakeet',
				model: 'another-model',
				benchmark_executable_sha256: 'd'.repeat(64),
				inference_rtf: 0.2,
				measured_total_seconds: 2,
				peak_rss_mb: 99,
				peak_rss_delta_mb: 1,
			},
		}),
	]);
	const errors = validateRunReport(malformed).join('\n');
	assert.match(errors, /metrics\.provider must match report\.provider/);
	assert.match(errors, /metrics\.model must match report\.model/);
	assert.match(errors, /metrics\.benchmark_executable_sha256 must match/);
	assert.match(errors, /metrics\.inference_rtf does not match inference duration/);
	assert.match(errors, /measured_total_seconds must cover all measured phases/);
	assert.match(errors, /metrics\.peak_rss_mb must not be below baseline RSS/);
	assert.match(errors, /metrics\.peak_rss_delta_mb does not match peak minus baseline/);

	const missingMetric = report([result()]);
	delete missingMetric.results[0].metrics.decode_seconds;
	assert.match(
		validateRunReport(missingMetric).join('\n'),
		/report\.results\[0\]\.metrics\.decode_seconds is required/,
	);

	const nonFinite = report([result({ metrics: { measured_total_seconds: Number.NaN } })]);
	assert.match(
		validateRunReport(nonFinite).join('\n'),
		/measured_total_seconds must be a non-negative finite number/,
	);

	const zeroMemory = result({
		metrics: { baseline_rss_mb: 0, peak_rss_mb: 0, peak_rss_delta_mb: 0 },
	}).metrics;
	assert.match(validateBenchmarkMetrics(zeroMemory).join('\n'), /baseline_rss_mb must be positive/);
	assert.match(validateBenchmarkMetrics(zeroMemory).join('\n'), /peak_rss_mb must be positive/);

	const unboundRuntimeEnvironment = result({
		metrics: {
			hardware_profile: 'cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776',
		},
	}).metrics;
	assert.match(
		validateBenchmarkMetrics(unboundRuntimeEnvironment).join('\n'),
		/hardware_profile must contain cpu, positive logical_cpus\/memory_bytes, and runtime_env_sha256/,
	);
});

test('requires one backend and hardware identity per run report', () => {
	const mixed = report([
		result(),
		result({
			sample_id: 'meeting-es-office',
			language: 'es',
			noise_condition: 'office',
			metrics: {
				backend: 'cpu',
				operating_system: 'linux',
				architecture: 'x86_64',
				hardware_profile: hardwareProfile('Different', 8, 17_179_869_184),
				accelerator: 'none',
			},
		}),
	]);
	const errors = validateRunReport(mixed).join('\n');
	for (const field of [
		'backend',
		'operating_system',
		'architecture',
		'hardware_profile',
		'accelerator',
	]) {
		assert.match(errors, new RegExp(`metrics\\.${field} must match the first result`));
	}
});

test('binds providers, canonical backends, exact Cargo features, and target platforms', () => {
	for (const valid of [
		{
			backend: 'cpu',
			cargoFeatures: [],
			targetTriple: 'aarch64-apple-darwin',
			operatingSystem: 'macos',
			architecture: 'aarch64',
		},
		{
			backend: 'metal',
			cargoFeatures: ['metal'],
			targetTriple: 'x86_64-apple-darwin',
			operatingSystem: 'macos',
			architecture: 'x86_64',
		},
		{
			backend: 'coreml-metal',
			cargoFeatures: ['coreml'],
			targetTriple: 'aarch64-apple-darwin',
			operatingSystem: 'macos',
			architecture: 'aarch64',
		},
		{
			backend: 'openblas-cpu',
			cargoFeatures: ['openblas'],
			targetTriple: 'aarch64-apple-darwin',
			operatingSystem: 'macos',
			architecture: 'aarch64',
		},
		{
			backend: 'cpu',
			cargoFeatures: [],
			targetTriple: 'x86_64-unknown-linux-gnu',
			operatingSystem: 'linux',
			architecture: 'x86_64',
		},
		{
			backend: 'cuda',
			cargoFeatures: ['cuda'],
			targetTriple: 'x86_64-unknown-linux-gnu',
			operatingSystem: 'linux',
			architecture: 'x86_64',
		},
		{
			backend: 'vulkan',
			cargoFeatures: ['vulkan'],
			targetTriple: 'x86_64-pc-windows-msvc',
			operatingSystem: 'windows',
			architecture: 'x86_64',
		},
		{
			backend: 'openblas-cpu',
			cargoFeatures: ['openblas'],
			targetTriple: 'x86_64-pc-windows-msvc',
			operatingSystem: 'windows',
			architecture: 'x86_64',
		},
		{
			backend: 'hipblas',
			cargoFeatures: ['hipblas'],
			targetTriple: 'x86_64-unknown-linux-gnu',
			operatingSystem: 'linux',
			architecture: 'x86_64',
		},
		{
			provider: 'parakeet',
			backend: 'onnx-cpu',
			cargoFeatures: [],
			targetTriple: 'x86_64-pc-windows-msvc',
			operatingSystem: 'windows',
			architecture: 'x86_64',
		},
	]) {
		assert.deepEqual(validateRunReport(boundReport(valid)), []);
	}

	const invalidCombination = boundReport({
		provider: 'parakeet',
		backend: 'metal',
		cargoFeatures: ['metal'],
		targetTriple: 'aarch64-apple-darwin',
		operatingSystem: 'macos',
		architecture: 'aarch64',
	});
	assert.match(
		validateRunReport(invalidCombination).join('\n'),
		/unsupported reported benchmark backend 'parakeet\/metal'/,
	);

	const wrongFeatures = boundReport({
		backend: 'metal',
		cargoFeatures: [],
		targetTriple: 'aarch64-apple-darwin',
		operatingSystem: 'macos',
		architecture: 'aarch64',
	});
	assert.match(
		validateRunReport(wrongFeatures).join('\n'),
		/evaluator_revision\.cargo_features must exactly match whisper\/metal/,
	);

	const wrongMetricsPlatform = boundReport({
		backend: 'cpu',
		cargoFeatures: [],
		targetTriple: 'aarch64-apple-darwin',
		operatingSystem: 'linux',
		architecture: 'x86_64',
	});
	assert.match(
		validateRunReport(wrongMetricsPlatform).join('\n'),
		/operating_system must match report\.evaluator_revision\.target_triple/,
	);

	const unsupportedBackendPlatform = boundReport({
		backend: 'cuda',
		cargoFeatures: ['cuda'],
		targetTriple: 'aarch64-apple-darwin',
		operatingSystem: 'macos',
		architecture: 'aarch64',
	});
	assert.match(
		validateRunReport(unsupportedBackendPlatform).join('\n'),
		/evaluator_revision\.target_triple is incompatible with whisper\/cuda/,
	);

	const gpuWithoutIdentity = boundReport({
		backend: 'cuda',
		cargoFeatures: ['cuda'],
		targetTriple: 'x86_64-unknown-linux-gnu',
		operatingSystem: 'linux',
		architecture: 'x86_64',
	});
	gpuWithoutIdentity.results[0].metrics.accelerator = 'none';
	assert.match(
		validateRunReport(gpuWithoutIdentity).join('\n'),
		/accelerator must identify the measured GPU/,
	);

	const cpuWithGpuIdentity = boundReport({
		backend: 'cpu',
		cargoFeatures: [],
		targetTriple: 'x86_64-unknown-linux-gnu',
		operatingSystem: 'linux',
		architecture: 'x86_64',
	});
	cpuWithGpuIdentity.results[0].metrics.accelerator = 'GPU 0';
	assert.match(
		validateRunReport(cpuWithGpuIdentity).join('\n'),
		/accelerator must be 'none' for cpu/,
	);
});

test('rejects contradictory WER shapes, threshold outcomes, and report pass state', () => {
	const contradictory = report([
		result({
			word_errors: 2,
			wer_percent: 10,
			hallucinated_words: 1,
			passed: true,
		}),
	]);
	const errors = validateRunReport(contradictory).join('\n');
	assert.match(errors, /wer_percent does not match word error counts/);
	assert.match(errors, /hallucinated_words must be null for WER samples/);

	const aboveThreshold = report([result({ word_errors: 2, wer_percent: 20, passed: true })]);
	assert.match(
		validateRunReport(aboveThreshold).join('\n'),
		/passed cannot be true above the WER threshold/,
	);

	const silence = report([
		result({
			reference_words: null,
			word_errors: null,
			wer_percent: null,
			hallucinated_words: 3,
			passed: true,
		}),
	]);
	assert.match(
		validateRunReport(silence).join('\n'),
		/passed cannot be true above the hallucination threshold/,
	);

	const inconsistentReport = report([result()], { passed: false });
	assert.match(
		validateRunReport(inconsistentReport).join('\n'),
		/report\.passed must equal whether every result passed/,
	);
});

test('tracks compatible evaluator and executable provenance independently by backend', () => {
	const metalRevision = evaluatorRevision(['metal']);
	const cpuRevision = evaluatorRevision([]);
	const cpuExecutable = 'd'.repeat(64);
	const metal = report([result()], { evaluator_revision: metalRevision });
	const cpu = report(
		[
			result({
				metrics: {
					backend: 'cpu',
					accelerator: 'none',
					benchmark_executable_sha256: cpuExecutable,
				},
			}),
		],
		{
			evaluator_revision: cpuRevision,
			benchmark_executable_sha256: cpuExecutable,
		},
	);
	const aggregate = aggregateRunReports([metal, cpu]);
	assert.deepEqual(aggregate.evaluator_revisions, {
		cpu: {
			evaluator_revision: cpuRevision,
			evaluator_revision_sha256: evaluatorRevisionSha256(cpuRevision),
		},
		metal: {
			evaluator_revision: metalRevision,
			evaluator_revision_sha256: evaluatorRevisionSha256(metalRevision),
		},
	});
	assert.deepEqual(aggregate.benchmark_executables, {
		cpu: cpuExecutable,
		metal: BENCHMARK_EXECUTABLE_SHA256,
	});
	assert.deepEqual(aggregate.evaluator_revision_common, {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: '1'.repeat(40),
		cargo_lock_sha256: '2'.repeat(64),
		rustc_vv: metalRevision.rustc_vv,
		build_profile: 'release',
		target_triple: 'aarch64-apple-darwin',
		build_env_sha256: '4'.repeat(64),
	});
});

test('rejects incompatible common revisions, backend features, and executables', () => {
	const first = report([result()]);
	const incompatibleRevision = evaluatorRevision(['metal'], {
		cargo_lock_sha256: 'e'.repeat(64),
	});
	const incompatible = report([result()], { evaluator_revision: incompatibleRevision });
	assert.throws(
		() => aggregateRunReports([first, incompatible]),
		/different common build provenance/,
	);

	const otherFeatureRevision = evaluatorRevision(['metal', 'vulkan']);
	const otherRevision = report([result()], { evaluator_revision: otherFeatureRevision });
	assert.match(
		validateRunReport(otherRevision).join('\n'),
		/evaluator_revision\.cargo_features must exactly match whisper\/metal/,
	);

	const otherExecutableDigest = 'e'.repeat(64);
	const otherExecutable = report(
		[
			result({
				metrics: { benchmark_executable_sha256: otherExecutableDigest },
			}),
		],
		{ benchmark_executable_sha256: otherExecutableDigest },
	);
	assert.throws(
		() => aggregateRunReports([first, otherExecutable]),
		/different benchmark executables for backend 'metal'/,
	);
});

test('requires a manifest and coordinates aggregate output files with the local corpus', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-report-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const sessionDirectory = path.join(directory, 'local-corpus', 'session-report-001');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	const audioContents = 'audio';
	const referenceContents = 'hello from the meeting';
	fs.writeFileSync(path.join(sessionDirectory, 'meeting-en-clean.wav'), audioContents);
	fs.writeFileSync(path.join(sessionDirectory, 'meeting-en-clean.txt'), referenceContents);
	const document = {
		schema_version: 2,
		corpus_id: 'consented-meetings-v1',
		description: 'Local consented corpus.',
		distribution: 'local',
		samples: [
			{
				id: 'meeting-en-clean',
				session_id: 'session-report-001',
				audio_path: 'local-corpus/session-report-001/meeting-en-clean.wav',
				audio_sha256: sha256(audioContents),
				reference_path: 'local-corpus/session-report-001/meeting-en-clean.txt',
				reference_sha256: sha256(referenceContents),
				language: 'en',
				scenario: 'meeting',
				noise_condition: 'clean',
				speakers: 3,
				duration_seconds: 20,
				provenance: {
					basis: 'participant-consent',
					redistribution: 'local-only',
					consent_record_id: 'consent-report-001',
					consent_date: '2025-01-01',
					consented_uses: ['asr-benchmarking'],
				},
			},
		],
	};
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	const inputPath = path.join(directory, 'run.json');
	fs.writeFileSync(
		inputPath,
		JSON.stringify({
			...report([result()]),
			corpus_fingerprint: corpusFingerprint(document),
		}),
	);
	const jsonPath = path.join(directory, 'results', 'aggregate.json');
	const markdownPath = path.join(directory, 'results', 'aggregate.md');
	const scriptPath = fileURLToPath(new URL('./report.ts', import.meta.url));

	const missingManifest = spawnSync(process.execPath, [scriptPath, inputPath, '--json', jsonPath], {
		encoding: 'utf8',
	});
	assert.equal(missingManifest.status, 2);
	assert.match(missingManifest.stderr, /--manifest is required/);

	const run = spawnSync(
		process.execPath,
		[
			scriptPath,
			inputPath,
			'--manifest',
			manifestPath,
			'--json',
			jsonPath,
			'--markdown',
			markdownPath,
		],
		{ encoding: 'utf8' },
	);
	assert.equal(run.status, 0, run.stderr);
	const aggregate = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
	assert.equal(aggregate.corpus_id, document.corpus_id);
	assert.equal(aggregate.wer_scorer, WER_SCORER_ID);
	assert.match(fs.readFileSync(markdownPath, 'utf8'), /# ASR corpus benchmark/);

	const mismatchedInputPath = path.join(directory, 'mismatched-run.json');
	const mismatchedOutputPath = path.join(directory, 'results', 'mismatched.json');
	fs.writeFileSync(
		mismatchedInputPath,
		JSON.stringify({
			...report([result({ language: 'es' })]),
			corpus_fingerprint: corpusFingerprint(document),
		}),
	);
	const mismatched = spawnSync(
		process.execPath,
		[scriptPath, mismatchedInputPath, '--manifest', manifestPath, '--json', mismatchedOutputPath],
		{ encoding: 'utf8' },
	);
	assert.equal(mismatched.status, 2);
	assert.match(mismatched.stderr, /language must match corpus sample/);
	assert.equal(fs.existsSync(mismatchedOutputPath), false);

	const mismatchedStdout = spawnSync(
		process.execPath,
		[scriptPath, mismatchedInputPath, '--manifest', manifestPath],
		{ encoding: 'utf8' },
	);
	assert.equal(mismatchedStdout.status, 2);
	assert.match(mismatchedStdout.stderr, /language must match corpus sample/);
	assert.equal(mismatchedStdout.stdout, '');
});
