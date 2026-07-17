import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { corpusFingerprint, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import {
	aggregateRunReports as aggregateRunReportsWithCorpus,
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

function assertApproximatelyEqual(actual, expected, epsilon = 1e-12) {
	assert.ok(
		Math.abs(actual - expected) <= epsilon,
		`expected ${actual} to be within ${epsilon} of ${expected}`,
	);
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
			schema_version: 7,
			provider: 'whisper',
			model: 'large-v3-turbo-q5_0',
			backend: 'metal',
			operating_system: 'macos',
			architecture: 'aarch64',
			hardware_profile: hardwareProfile('Apple M4 Pro', 14, 25_769_803_776),
			accelerator: 'Apple M4 Pro integrated GPU',
			benchmark_executable_sha256: BENCHMARK_EXECUTABLE_SHA256,
			audio_sha256: sha256('audio'),
			audio_duration_seconds: 20,
			decode_seconds: 0.1,
			vad_seconds: 0.2,
			model_download_seconds: 0,
			model_load_seconds: 1,
			inference_seconds: 2,
			inference_rtf: 0.1,
			inference_audio_seconds: 10,
			model_inference_rtf: 0.2,
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
		schema_version: 10,
		corpus_id: 'consented-meetings-v1',
		corpus_fingerprint: 'a'.repeat(64),
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
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

function campaignReport(runReport, repeatIndex, taskIdentity) {
	return {
		...runReport,
		schema_version: 11,
		benchmark_task_id: sha256(taskIdentity),
		repeat_index: repeatIndex,
	};
}

function resultForSample(sampleId, overrides = {}) {
	const { metrics: metricsOverrides = {}, ...resultOverrides } = overrides;
	return result({
		sample_id: sampleId,
		metrics: {
			audio_sha256: sha256(`audio-${sampleId}`),
			...metricsOverrides,
		},
		...resultOverrides,
	});
}

function variantReport(results, { provider = 'whisper', model, backend = 'metal' }) {
	const selectedModel = model ?? (provider === 'parakeet' ? 'parakeet-test' : 'whisper-test');
	const cargoFeatures = backend === 'metal' ? ['metal'] : [];
	const accelerator = backend === 'metal' ? 'Apple M4 Pro integrated GPU' : 'none';
	return report(
		results.map((entry) => ({
			...entry,
			metrics: {
				...entry.metrics,
				provider,
				model: selectedModel,
				backend,
				accelerator,
			},
		})),
		{
			provider,
			model: selectedModel,
			model_artifact_sha256: sha256(`${provider}/${selectedModel}`),
			evaluator_revision: evaluatorRevision(cargoFeatures),
		},
	);
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
		audio_sha256: sha256('audio'),
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
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		samples,
		...overrides,
	};
}

function authoritativeCorpusForReports(reports, sessionIds = {}) {
	const firstReport = reports[0];
	const samples = new Map();
	for (const runReport of reports) {
		if (!Array.isArray(runReport?.results)) continue;
		for (const entry of runReport.results) {
			if (typeof entry?.sample_id !== 'string' || samples.has(entry.sample_id)) continue;
			const sample = {
				id: entry.sample_id,
				dataset: entry.dataset,
				language: entry.language,
				noise_condition: entry.noise_condition,
				scenario: entry.scenario,
				speakers: entry.speakers,
				duration_seconds: entry.metrics?.audio_duration_seconds,
				audio_sha256: entry.metrics?.audio_sha256,
				provenance: { basis: entry.provenance_basis },
			};
			if (Object.hasOwn(sessionIds, entry.sample_id)) {
				sample.session_id = sessionIds[entry.sample_id];
			} else if (entry.scenario === 'meeting') {
				sample.session_id = `session-test-${sha256(entry.sample_id).slice(0, 12)}`;
			}
			samples.set(entry.sample_id, sample);
		}
	}
	const corpus = loadedCorpus(
		[...samples.values()].sort((left, right) => left.id.localeCompare(right.id)),
		{
			corpus_id: firstReport?.corpus_id ?? 'consented-meetings-v1',
			reference_protocol_id: firstReport?.reference_protocol_id ?? REFERENCE_PROTOCOL_ID,
		},
	);
	corpus.corpus_fingerprint = corpusFingerprint({
		corpus_id: corpus.corpus_id,
		reference_protocol_id: corpus.reference_protocol_id,
		samples: corpus.samples,
	});
	return corpus;
}

function aggregateRunReports(reports, { sessionIds = {} } = {}) {
	const corpus = authoritativeCorpusForReports(reports, sessionIds);
	const sourceFingerprint = reports[0]?.corpus_fingerprint;
	const boundReports = reports.map((entry) => ({
		...entry,
		corpus_fingerprint:
			entry?.corpus_fingerprint === sourceFingerprint
				? corpus.corpus_fingerprint
				: entry?.corpus_fingerprint,
	}));
	return aggregateRunReportsWithCorpus(boundReports, corpus);
}

test('compares exact provider/model/backend variants only on one identical sample cohort', () => {
	const baseSamples = [
		resultForSample('meeting-en-clean'),
		resultForSample('meeting-es-office', { language: 'es', noise_condition: 'office' }),
	];
	const cpuSamples = baseSamples.map((entry) =>
		resultForSample(entry.sample_id, {
			language: entry.language,
			noise_condition: entry.noise_condition,
			word_errors: 2,
			wer_percent: 20,
			passed: false,
			metrics: {
				inference_seconds: 4,
				inference_rtf: 0.2,
				model_inference_rtf: 0.4,
				measured_total_seconds: 5.5,
				peak_rss_mb: 2000,
				peak_rss_delta_mb: 1900,
			},
		}),
	);
	const parakeetSamples = baseSamples.map((entry) =>
		resultForSample(entry.sample_id, {
			language: entry.language,
			noise_condition: entry.noise_condition,
			word_errors: 0,
			wer_percent: 0,
		}),
	);
	const aggregate = aggregateRunReports([
		variantReport(baseSamples, {
			model: 'large-v3-turbo-q5_0',
			backend: 'metal',
		}),
		variantReport(cpuSamples, {
			model: 'large-v3-turbo-q5_0',
			backend: 'cpu',
		}),
		variantReport(parakeetSamples, {
			provider: 'parakeet',
			model: 'parakeet-tdt-0.6b-v3-int8',
			backend: 'onnx-cpu',
		}),
	]);

	assert.equal(aggregate.schema_version, 11);
	assert.equal(aggregate.aggregation_unit_policy, 'session-id-or-singleton-sample-v1');
	assert.equal(aggregate.reference_protocol_id, REFERENCE_PROTOCOL_ID);
	assert.equal(aggregate.measurement_result_count, 6);
	assert.deepEqual(aggregate.input_bindings, {
		standalone_schema_10: { report_count: 3, measurement_result_count: 6 },
		task_bound_schema_11: { report_count: 0, measurement_result_count: 0 },
	});
	assert.equal(aggregate.distinct_sample_count, 2);
	assert.equal(aggregate.groups, undefined);
	assert.equal(aggregate.comparison.status, 'comparable');
	assert.equal(aggregate.comparison.scope, 'supplied-variants');
	assert.equal(aggregate.comparison.target_completeness, 'not-assessed');
	assert.equal(aggregate.comparison.variant_count, 3);
	assert.equal(aggregate.comparison.common_sample_count, 2);
	assert.equal(aggregate.comparison.union_sample_count, 2);
	assert.equal(aggregate.comparison.common_measurement_count, 2);
	assert.equal(aggregate.comparison.union_measurement_count, 2);
	assert.equal(aggregate.comparison.groups.variant.length, 3);
	assert.equal(aggregate.comparison.groups.dataset_variant.length, 0);
	assert.equal(aggregate.comparison.groups.language_variant.length, 6);
	assert.equal(aggregate.comparison.groups.scenario_variant.length, 3);
	assert.equal(aggregate.comparison.groups.noise_condition_variant.length, 6);
	assert.equal(aggregate.comparison.groups.language_noise_variant.length, 6);
	assert.deepEqual(
		aggregate.comparison.groups.variant.map(({ provider, model, backend }) => ({
			provider,
			model,
			backend,
		})),
		[
			{ provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3-int8', backend: 'onnx-cpu' },
			{ provider: 'whisper', model: 'large-v3-turbo-q5_0', backend: 'cpu' },
			{ provider: 'whisper', model: 'large-v3-turbo-q5_0', backend: 'metal' },
		],
	);
	const cpu = aggregate.diagnostics.variants.find((entry) => entry.backend === 'cpu');
	const metal = aggregate.diagnostics.variants.find((entry) => entry.backend === 'metal');
	const parakeet = aggregate.diagnostics.variants.find((entry) => entry.provider === 'parakeet');
	assert.equal(cpu.groups.overall.wer_percent, 20);
	assert.equal(cpu.groups.overall.aggregate_inference_rtf, 0.2);
	assert.equal(cpu.groups.overall.mean_baseline_rss_mb, 100);
	assert.equal(cpu.groups.overall.max_baseline_rss_mb, 100);
	assert.equal(cpu.groups.overall.max_peak_rss_mb, 2000);
	assert.equal(cpu.groups.overall.mean_peak_rss_delta_mb, 1900);
	assert.equal(cpu.groups.overall.max_peak_rss_delta_mb, 1900);
	assert.equal(metal.groups.overall.wer_percent, 10);
	assert.equal(metal.groups.overall.macro_wer_percent, 10);
	assert.equal(metal.groups.overall.p95_inference_rtf, 0.1);
	assert.equal(metal.groups.overall.p95_model_inference_rtf, 0.2);
	assert.equal(parakeet.groups.overall.wer_percent, 0);
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
		'onnx-cpu': BENCHMARK_EXECUTABLE_SHA256,
	});
	assert.equal(aggregate.operating_system, 'macos');
	assert.equal(aggregate.architecture, 'aarch64');
	assert.equal(aggregate.hardware_profile, hardwareProfile('Apple M4 Pro', 14, 25_769_803_776));
	assert.deepEqual(aggregate.accelerators, {
		cpu: 'none',
		metal: 'Apple M4 Pro integrated GPU',
		'onnx-cpu': 'none',
	});
	assert.deepEqual(aggregate.model_artifacts, {
		'parakeet/parakeet-tdt-0.6b-v3-int8': sha256('parakeet/parakeet-tdt-0.6b-v3-int8'),
		'whisper/large-v3-turbo-q5_0': sha256('whisper/large-v3-turbo-q5_0'),
	});
});

test('tracks silence hallucinations separately from WER', () => {
	const silence = result({
		sample_id: 'silence',
		reference_words: null,
		word_errors: null,
		wer_percent: null,
		hallucinated_words: 2,
		metrics: {
			inference_seconds: 0,
			inference_rtf: 0,
			inference_audio_seconds: 0,
			model_inference_rtf: null,
		},
	});
	const aggregate = aggregateRunReports([report([result(), silence])]);
	const overall = aggregate.diagnostics.variants[0].groups.overall;
	assert.equal(overall.wer_percent, 10);
	assert.equal(overall.hallucination_samples, 1);
	assert.equal(overall.hallucinated_words_total, 2);
	assert.equal(overall.aggregate_model_inference_rtf, 0.2);
	assert.equal(aggregate.comparison.status, 'single-variant');
	assert.equal(aggregate.comparison.groups, null);
	const markdown = renderMarkdown(aggregate);
	assert.match(markdown, /Available-sample diagnostics/);
	assert.match(markdown, /No cross-variant comparison: only one exact variant was supplied/);
	assert.match(markdown, /Standalone schema 10: 1 report\(s\), 2 measurement result\(s\)/);
	assert.match(markdown, /Task-bound schema 11: 0 report\(s\), 0 measurement result\(s\)/);
	assert.match(markdown, /Corpus: `consented-meetings-v1`/);
	assert.match(markdown, /WER scorer: `muesly-wer-unicode-v1`/);
	assert.match(markdown, /Platform: `macos\/aarch64`/);
	assert.match(markdown, /Hardware profile: `cpu=Apple M4 Pro/);
	assert.match(markdown, /Accelerators: `metal` = `Apple M4 Pro integrated GPU`/);
	assert.match(markdown, /`whisper\/large-v3-turbo-q5_0`: `c{64}`/);
	assert.match(markdown, /WER ≤ 10\.00%; hallucinated words ≤ 2/);
	assert.match(markdown, /Pooled source RTF/);
	assert.match(markdown, /Unit-balanced WER/);
	assert.match(markdown, /Unit P95 source RTF/);
	assert.match(markdown, /Unit P95 model-input RTF/);
	assert.match(markdown, /nearest-rank/);
	assert.match(markdown, /model-input RTF/);
	assert.match(markdown, /exact post-VAD audio passed to ASR/);
	assert.match(markdown, /Unit max sampled evaluator-process host RSS/);
	assert.match(markdown, /pre-model-load baseline/);
	assert.match(markdown, /immediately before model load through the end of inference/);
	assert.match(markdown, /excludes accelerator VRAM/);
	assert.doesNotMatch(markdown, /model memory/i);
	assert.doesNotMatch(markdown, /—%/);
});

test('computes equal-measurement macro WER and nearest-rank p95 RTF deterministically', () => {
	const measurements = Array.from({ length: 20 }, (_, index) => {
		const inferenceRtf = (index + 1) / 100;
		const inferenceSeconds = inferenceRtf * 20;
		return resultForSample(`meeting-${String(index + 1).padStart(2, '0')}`, {
			reference_words: index === 0 ? 1 : 100,
			word_errors: index === 0 ? 1 : 0,
			wer_percent: index === 0 ? 100 : 0,
			passed: index !== 0,
			metrics: {
				inference_seconds: inferenceSeconds,
				inference_rtf: inferenceRtf,
				model_inference_rtf: inferenceSeconds / 10,
				measured_total_seconds: 20,
			},
		});
	});
	const aggregate = aggregateRunReports([report(measurements)]);
	const summary = aggregate.diagnostics.variants[0].groups.overall;

	assert.equal(summary.wer_percent, (1 / 1901) * 100);
	assert.equal(summary.macro_wer_percent, 5);
	assert.equal(summary.p95_inference_rtf, 0.19);
	assert.equal(summary.p95_model_inference_rtf, 0.38);
	const markdown = renderMarkdown(aggregate);
	assert.match(markdown, /\| 5\.00% \|/);
	assert.match(markdown, /\| 0\.190 \|/);
	assert.match(markdown, /\| 0\.380 \|/);
});

test('weights sessions equally after reducing their samples', () => {
	const measurement = (sampleId, { wordErrors, inferenceRtf, peakRssMb }) =>
		resultForSample(sampleId, {
			reference_words: 10,
			word_errors: wordErrors,
			wer_percent: wordErrors * 10,
			passed: wordErrors <= 1,
			metrics: {
				inference_seconds: inferenceRtf * 20,
				inference_rtf: inferenceRtf,
				model_inference_rtf: inferenceRtf * 2,
				measured_total_seconds: 20,
				peak_rss_mb: peakRssMb,
				peak_rss_delta_mb: peakRssMb - 100,
			},
		});
	const measurements = [
		measurement('busy-session-1', { wordErrors: 0, inferenceRtf: 0.1, peakRssMb: 1000 }),
		measurement('busy-session-2', { wordErrors: 0, inferenceRtf: 0.1, peakRssMb: 1100 }),
		measurement('busy-session-3', { wordErrors: 0, inferenceRtf: 0.1, peakRssMb: 1200 }),
		measurement('short-session-1', { wordErrors: 10, inferenceRtf: 0.9, peakRssMb: 2000 }),
	];
	const aggregate = aggregateRunReports([report(measurements)], {
		sessionIds: {
			'busy-session-1': 'session-busy',
			'busy-session-2': 'session-busy',
			'busy-session-3': 'session-busy',
			'short-session-1': 'session-short',
		},
	});
	const summary = aggregate.diagnostics.variants[0].groups.overall;

	assert.equal(summary.samples, 4);
	assert.equal(summary.macro_wer_percent, 25);
	assertApproximatelyEqual(summary.mean_inference_rtf, 0.3);
	const expectedUnits = {
		unit_count: 2,
		session_count: 2,
		singleton_sample_count: 0,
		passed_unit_count: 1,
		pass_rate_percent: 50,
		wer_unit_count: 2,
		wer_percent: 50,
		mean_inference_rtf: 0.5,
		median_inference_rtf: 0.5,
		p95_inference_rtf: 0.9,
		max_inference_rtf: 0.9,
		model_rtf_unit_count: 2,
		mean_model_inference_rtf: 1,
		median_model_inference_rtf: 1,
		p95_model_inference_rtf: 1.8,
		max_model_inference_rtf: 1.8,
		mean_peak_rss_mb: 1600,
		median_peak_rss_mb: 1600,
		p95_peak_rss_mb: 2000,
		max_peak_rss_mb: 2000,
		mean_peak_rss_delta_mb: 1500,
		median_peak_rss_delta_mb: 1500,
		p95_peak_rss_delta_mb: 1900,
		max_peak_rss_delta_mb: 1900,
	};
	assert.deepEqual(Object.keys(summary.unit_balanced).sort(), Object.keys(expectedUnits).sort());
	for (const [field, expected] of Object.entries(expectedUnits)) {
		assertApproximatelyEqual(summary.unit_balanced[field], expected);
	}
	assert.doesNotMatch(JSON.stringify(aggregate), /session-busy|session-short/);
	assert.doesNotMatch(renderMarkdown(aggregate), /session-busy|session-short/);
});

test('rebalances shared sessions independently inside language and noise slices', () => {
	const scoredSample = (sampleId, { language, noiseCondition, wordErrors }) =>
		resultForSample(sampleId, {
			language,
			noise_condition: noiseCondition,
			reference_words: 10,
			word_errors: wordErrors,
			wer_percent: wordErrors * 10,
			passed: wordErrors <= 1,
		});
	const aggregate = aggregateRunReports(
		[
			report([
				scoredSample('shared-en-clean', {
					language: 'en',
					noiseCondition: 'clean',
					wordErrors: 0,
				}),
				scoredSample('shared-es-office', {
					language: 'es',
					noiseCondition: 'office',
					wordErrors: 10,
				}),
				scoredSample('other-en-clean', {
					language: 'en',
					noiseCondition: 'clean',
					wordErrors: 10,
				}),
			]),
		],
		{
			sessionIds: {
				'shared-en-clean': 'session-shared',
				'shared-es-office': 'session-shared',
				'other-en-clean': 'session-other',
			},
		},
	);
	const groups = aggregate.diagnostics.variants[0].groups;
	const english = groups.language.find((row) => row.language === 'en').summary.unit_balanced;
	const spanish = groups.language.find((row) => row.language === 'es').summary.unit_balanced;
	const clean = groups.noise_condition.find((row) => row.noise_condition === 'clean').summary
		.unit_balanced;
	const office = groups.noise_condition.find((row) => row.noise_condition === 'office').summary
		.unit_balanced;
	const englishClean = groups.language_noise.find(
		(row) => row.language === 'en' && row.noise_condition === 'clean',
	).summary.unit_balanced;
	const spanishOffice = groups.language_noise.find(
		(row) => row.language === 'es' && row.noise_condition === 'office',
	).summary.unit_balanced;

	assert.equal(groups.overall.unit_balanced.wer_percent, 75);
	assert.deepEqual(
		[english, clean, englishClean].map(({ unit_count, session_count, wer_percent }) => ({
			unit_count,
			session_count,
			wer_percent,
		})),
		[
			{ unit_count: 2, session_count: 2, wer_percent: 50 },
			{ unit_count: 2, session_count: 2, wer_percent: 50 },
			{ unit_count: 2, session_count: 2, wer_percent: 50 },
		],
	);
	assert.deepEqual(
		[spanish, office, spanishOffice].map(({ unit_count, session_count, wer_percent }) => ({
			unit_count,
			session_count,
			wer_percent,
		})),
		[
			{ unit_count: 1, session_count: 1, wer_percent: 100 },
			{ unit_count: 1, session_count: 1, wer_percent: 100 },
			{ unit_count: 1, session_count: 1, wer_percent: 100 },
		],
	);
});

test('collapses repeats by sample before computing unit-balanced statistics', () => {
	const measurement = (sampleId, { wordErrors, inferenceRtf, peakRssMb }) =>
		resultForSample(sampleId, {
			reference_words: 10,
			word_errors: wordErrors,
			wer_percent: wordErrors * 10,
			passed: wordErrors <= 1,
			metrics: {
				inference_seconds: inferenceRtf * 20,
				inference_rtf: inferenceRtf,
				model_inference_rtf: inferenceRtf * 2,
				measured_total_seconds: 20,
				peak_rss_mb: peakRssMb,
				peak_rss_delta_mb: peakRssMb - 100,
			},
		});
	const reports = [
		campaignReport(
			report([
				measurement('repeated-sample', {
					wordErrors: 0,
					inferenceRtf: 0.1,
					peakRssMb: 1000,
				}),
			]),
			1,
			'repeated-sample-1',
		),
		campaignReport(
			report([
				measurement('repeated-sample', {
					wordErrors: 10,
					inferenceRtf: 0.3,
					peakRssMb: 3000,
				}),
			]),
			2,
			'repeated-sample-2',
		),
		campaignReport(
			report([
				measurement('single-repeat-sample', {
					wordErrors: 10,
					inferenceRtf: 0.8,
					peakRssMb: 2000,
				}),
			]),
			1,
			'single-repeat-sample-1',
		),
	];
	const aggregate = aggregateRunReports(reports, {
		sessionIds: {
			'repeated-sample': 'session-repeated',
			'single-repeat-sample': 'session-single',
		},
	});
	const summary = aggregate.diagnostics.variants[0].groups.overall;

	assert.equal(summary.macro_wer_percent, 200 / 3);
	assertApproximatelyEqual(summary.mean_inference_rtf, 0.4);
	assert.equal(summary.unit_balanced.unit_count, 2);
	assert.equal(summary.unit_balanced.passed_unit_count, 0);
	assert.equal(summary.unit_balanced.wer_percent, 75);
	assertApproximatelyEqual(summary.unit_balanced.mean_inference_rtf, 0.5);
	assertApproximatelyEqual(summary.unit_balanced.mean_model_inference_rtf, 1);
	assert.equal(summary.unit_balanced.mean_peak_rss_mb, 2500);
	assert.equal(summary.unit_balanced.max_peak_rss_mb, 3000);
	assert.equal(summary.unit_balanced.mean_peak_rss_delta_mb, 2400);
	assert.equal(summary.unit_balanced.max_peak_rss_delta_mb, 2900);
});

test('keeps unit-balanced WER and RTF invariant when one session is split into clips', () => {
	const whole = resultForSample('whole-session', {
		reference_words: 20,
		word_errors: 2,
		wer_percent: 10,
		metrics: {
			audio_duration_seconds: 40,
			inference_seconds: 4,
			inference_rtf: 0.1,
			inference_audio_seconds: 20,
			model_inference_rtf: 0.2,
			measured_total_seconds: 6,
		},
	});
	const split = ['split-session-1', 'split-session-2'].map((sampleId) =>
		resultForSample(sampleId, {
			reference_words: 10,
			word_errors: 1,
			wer_percent: 10,
			metrics: {
				inference_seconds: 2,
				inference_rtf: 0.1,
				model_inference_rtf: 0.2,
			},
		}),
	);
	const wholeSummary = aggregateRunReports([report([whole])], {
		sessionIds: { 'whole-session': 'session-stable' },
	}).diagnostics.variants[0].groups.overall.unit_balanced;
	const splitSummary = aggregateRunReports([report(split)], {
		sessionIds: {
			'split-session-1': 'session-stable',
			'split-session-2': 'session-stable',
		},
	}).diagnostics.variants[0].groups.overall.unit_balanced;

	assert.deepEqual(splitSummary, wholeSummary);
});

test('uses samples without session ids as independent singleton aggregation units', () => {
	const aggregate = aggregateRunReports([
		report([
			resultForSample('singleton-1', { scenario: 'dictation' }),
			resultForSample('singleton-2', {
				scenario: 'dictation',
				word_errors: 0,
				wer_percent: 0,
			}),
		]),
	]);
	const units = aggregate.diagnostics.variants[0].groups.overall.unit_balanced;

	assert.equal(aggregate.aggregation_unit_policy, 'session-id-or-singleton-sample-v1');
	assert.equal(units.unit_count, 2);
	assert.equal(units.session_count, 0);
	assert.equal(units.singleton_sample_count, 2);
	assert.equal(units.wer_percent, 5);
});

test('requires an authoritative corpus when aggregating through the public API', () => {
	assert.throws(
		() => aggregateRunReportsWithCorpus([report([result()])]),
		/loaded corpus manifest is required/,
	);
});

test('rejects stale corpus fingerprints after session membership changes', () => {
	const sourceReport = report([result()]);
	const corpus = authoritativeCorpusForReports([sourceReport], {
		'meeting-en-clean': 'session-original',
	});
	const boundReport = { ...sourceReport, corpus_fingerprint: corpus.corpus_fingerprint };
	corpus.samples[0].session_id = 'session-changed';

	assert.throws(
		() => aggregateRunReportsWithCorpus([boundReport], corpus),
		/corpus fingerprint does not match its manifest contents/,
	);
});

test('reports supported public datasets as separate diagnostic and comparison groups', () => {
	const samples = [
		['fleurs-sample', 'fleurs'],
		['ami-sample', 'ami'],
		['earnings21-sample', 'earnings21'],
	].map(([sampleId, dataset]) =>
		resultForSample(sampleId, {
			dataset,
			provenance_basis: 'public-license',
		}),
	);
	const aggregate = aggregateRunReports([
		variantReport(samples, { model: 'whisper-test', backend: 'metal' }),
		variantReport(samples, { model: 'whisper-test', backend: 'cpu' }),
	]);

	for (const diagnostic of aggregate.diagnostics.variants) {
		assert.deepEqual(
			diagnostic.groups.dataset.map((row) => row.dataset),
			['ami', 'earnings21', 'fleurs'],
		);
	}
	assert.equal(aggregate.comparison.groups.dataset_variant.length, 6);
	const markdown = renderMarkdown(aggregate);
	assert.match(markdown, /### By dataset and exact variant/);
	assert.match(markdown, /fleurs \/ whisper\/whisper-test\/metal/);
	assert.match(markdown, /ami \/ whisper\/whisper-test\/cpu/);
	assert.match(markdown, /earnings21 \/ whisper\/whisper-test\/metal/);
	assert.throws(
		() =>
			aggregateRunReports([
				variantReport(
					[
						resultForSample('same-public-sample', {
							dataset: 'fleurs',
							provenance_basis: 'public-license',
						}),
					],
					{ model: 'whisper-test', backend: 'metal' },
				),
				variantReport(
					[
						resultForSample('same-public-sample', {
							dataset: 'ami',
							provenance_basis: 'public-license',
						}),
					],
					{ model: 'whisper-test', backend: 'cpu' },
				),
			]),
		/dataset must match corpus sample/,
	);
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
		/duplicate provider\/model\/backend\/sample_id\/repeat_index measurement .*meeting-en-clean/,
	);

	const otherModel = report([result({ metrics: { model: 'another-model' } })], {
		model: 'another-model',
		model_artifact_sha256: 'd'.repeat(64),
	});
	assert.equal(aggregateRunReports([first, otherModel]).measurement_result_count, 2);
});

test('aggregates declared repetitions while preserving distinct sample cohorts', () => {
	const first = campaignReport(report([result()]), 1, 'whisper-metal-repeat-1');
	const second = campaignReport(report([result()]), 2, 'whisper-metal-repeat-2');
	const aggregate = aggregateRunReports([first, second]);
	assert.equal(aggregate.measurement_result_count, 2);
	assert.deepEqual(aggregate.input_bindings, {
		standalone_schema_10: { report_count: 0, measurement_result_count: 0 },
		task_bound_schema_11: { report_count: 2, measurement_result_count: 2 },
	});
	assert.equal(aggregate.distinct_sample_count, 1);
	assert.equal(aggregate.diagnostics.variants[0].observed_sample_count, 1);
	assert.equal(aggregate.diagnostics.variants[0].measurement_result_count, 2);
	assert.equal(aggregate.diagnostics.variants[0].groups.overall.samples, 2);
	assert.deepEqual(
		aggregate.diagnostics.variants[0].groups.scenario.map((row) => row.scenario),
		['meeting'],
	);
	assert.equal(aggregate.comparison.groups, null);
	const sample = resultForSample('meeting-en-clean');
	const metal = variantReport([sample], { model: 'whisper-test', backend: 'metal' });
	const cpu = variantReport([sample], { model: 'whisper-test', backend: 'cpu' });
	const asymmetric = aggregateRunReports([
		campaignReport(metal, 1, 'asymmetric-metal-repeat-1'),
		campaignReport(structuredClone(metal), 2, 'asymmetric-metal-repeat-2'),
		campaignReport(cpu, 1, 'asymmetric-cpu-repeat-1'),
	]);
	assert.equal(asymmetric.comparison.status, 'unequal-measurement-cohorts');
	assert.equal(asymmetric.comparison.common_sample_count, 1);
	assert.equal(asymmetric.comparison.common_measurement_count, 1);
	assert.equal(asymmetric.comparison.union_measurement_count, 2);
	assert.equal(asymmetric.comparison.groups, null);
	const markdown = renderMarkdown(aggregate);
	assert.match(markdown, /Standalone schema 10: 0 report\(s\), 0 measurement result\(s\)/);
	assert.match(markdown, /Task-bound schema 11: 2 report\(s\), 2 measurement result\(s\)/);

	assert.match(
		validateRunReport(report([result()], { repeat_index: 0 })).join('\n'),
		/repeat_index must be a safe integer from 1 through 10/,
	);
	assert.match(
		validateRunReport(report([result()], { repeat_index: 2 })).join('\n'),
		/repeat_index must be absent or 1 for schema-10 standalone reports/,
	);
	assert.throws(
		() => aggregateRunReports([first, { ...second, benchmark_task_id: first.benchmark_task_id }]),
		/duplicate benchmark_task_id/,
	);
});

test('keeps different models on the same backend as separate exact variants', () => {
	const sample = resultForSample('meeting-en-clean');
	const aggregate = aggregateRunReports([
		variantReport([sample], { model: 'model-a', backend: 'cpu' }),
		variantReport([sample], { model: 'model-b', backend: 'cpu' }),
	]);

	assert.equal(aggregate.comparison.status, 'comparable');
	assert.deepEqual(
		aggregate.comparison.groups.variant.map(({ provider, model, backend }) => ({
			provider,
			model,
			backend,
		})),
		[
			{ provider: 'whisper', model: 'model-a', backend: 'cpu' },
			{ provider: 'whisper', model: 'model-b', backend: 'cpu' },
		],
	);
});

test('suppresses comparisons for equal-size cohorts with different sample identities', () => {
	const shared = resultForSample('meeting-shared');
	const highMemory = resultForSample('meeting-metal-only', {
		metrics: { peak_rss_mb: 5000, peak_rss_delta_mb: 4900 },
	});
	const aggregate = aggregateRunReports([
		variantReport([shared, highMemory], { model: 'whisper-test', backend: 'metal' }),
		variantReport([shared, resultForSample('meeting-cpu-only')], {
			model: 'whisper-test',
			backend: 'cpu',
		}),
	]);

	assert.equal(aggregate.comparison.status, 'unequal-measurement-cohorts');
	assert.equal(aggregate.comparison.common_sample_count, 1);
	assert.equal(aggregate.comparison.union_sample_count, 3);
	assert.equal(aggregate.comparison.groups, null);
	assert.deepEqual(
		aggregate.comparison.cohorts.map(
			({
				backend,
				observed_sample_count,
				not_common_sample_count,
				missing_from_union_sample_count,
			}) => ({
				backend,
				observed_sample_count,
				not_common_sample_count,
				missing_from_union_sample_count,
			}),
		),
		[
			{
				backend: 'cpu',
				observed_sample_count: 2,
				not_common_sample_count: 1,
				missing_from_union_sample_count: 1,
			},
			{
				backend: 'metal',
				observed_sample_count: 2,
				not_common_sample_count: 1,
				missing_from_union_sample_count: 1,
			},
		],
	);
	assert.equal(
		aggregate.diagnostics.variants.find((entry) => entry.backend === 'metal').groups.overall
			.max_peak_rss_mb,
		5000,
	);
	const markdown = renderMarkdown(aggregate);
	assert.match(markdown, /Post-hoc intersection metrics are intentionally not reported/);
	assert.match(markdown, /Available-sample diagnostics/);
	assert.doesNotMatch(markdown, /## Cross-variant comparisons/);
});

test('suppresses zero-overlap and three-way comparisons when only a pair shares a cohort', () => {
	const disjoint = aggregateRunReports([
		variantReport([resultForSample('meeting-metal-only')], {
			model: 'whisper-test',
			backend: 'metal',
		}),
		variantReport([resultForSample('meeting-cpu-only')], {
			model: 'whisper-test',
			backend: 'cpu',
		}),
	]);
	assert.equal(disjoint.comparison.status, 'unequal-measurement-cohorts');
	assert.equal(disjoint.comparison.common_sample_count, 0);
	assert.equal(disjoint.comparison.groups, null);

	const shared = [resultForSample('meeting-first'), resultForSample('meeting-second')];
	const threeWay = aggregateRunReports([
		variantReport(shared, { model: 'model-a', backend: 'cpu' }),
		variantReport(shared, { model: 'model-b', backend: 'cpu' }),
		variantReport([shared[0]], { model: 'model-c', backend: 'cpu' }),
	]);
	assert.equal(threeWay.comparison.status, 'unequal-measurement-cohorts');
	assert.equal(threeWay.comparison.common_sample_count, 1);
	assert.equal(threeWay.comparison.union_sample_count, 2);
	assert.equal(threeWay.comparison.groups, null);
	assert.deepEqual(
		threeWay.diagnostics.variants.map(({ model, observed_sample_count }) => ({
			model,
			observed_sample_count,
		})),
		[
			{ model: 'model-a', observed_sample_count: 2 },
			{ model: 'model-b', observed_sample_count: 2 },
			{ model: 'model-c', observed_sample_count: 1 },
		],
	);
});

test('unions report shards and compares identical sample sets independent of input order', () => {
	const first = resultForSample('meeting-first', {
		metrics: { inference_seconds: 0.1, inference_rtf: 0.005, model_inference_rtf: 0.01 },
	});
	const second = resultForSample('meeting-second', {
		language: 'es',
		noise_condition: 'office',
		metrics: { inference_seconds: 0.2, inference_rtf: 0.01, model_inference_rtf: 0.02 },
	});
	const third = resultForSample('meeting-third', {
		language: 'pt',
		noise_condition: 'remote-call',
		metrics: { inference_seconds: 0.3, inference_rtf: 0.015, model_inference_rtf: 0.03 },
	});
	const inputs = [
		variantReport([first], { model: 'whisper-test', backend: 'cpu' }),
		variantReport([second], { model: 'whisper-test', backend: 'cpu' }),
		variantReport([third], { model: 'whisper-test', backend: 'cpu' }),
		variantReport([third, second, first], { model: 'whisper-test', backend: 'metal' }),
	];
	const sessionIds = {
		'meeting-first': 'session-first-and-second',
		'meeting-second': 'session-first-and-second',
		'meeting-third': 'session-third',
	};
	const aggregate = aggregateRunReports(inputs, { sessionIds });
	assert.equal(aggregate.comparison.status, 'comparable');
	assert.deepEqual(
		aggregate.diagnostics.variants.map(({ backend, observed_sample_count }) => ({
			backend,
			observed_sample_count,
		})),
		[
			{ backend: 'cpu', observed_sample_count: 3 },
			{ backend: 'metal', observed_sample_count: 3 },
		],
	);

	const reordered = aggregateRunReports([inputs[3], inputs[2], inputs[1], inputs[0]], {
		sessionIds,
	});
	aggregate.generated_at = '<generated>';
	reordered.generated_at = '<generated>';
	assert.deepEqual(reordered, aggregate);
});

test('rejects cross-variant identities that conflict with the authoritative corpus', () => {
	const canonical = resultForSample('meeting-en-clean');
	const conflicts = [
		[
			'audio_sha256',
			resultForSample('meeting-en-clean', { metrics: { audio_sha256: sha256('changed-audio') } }),
		],
		['language', resultForSample('meeting-en-clean', { language: 'es' })],
		['noise_condition', resultForSample('meeting-en-clean', { noise_condition: 'office' })],
		['scenario', resultForSample('meeting-en-clean', { scenario: 'dictation' })],
		['speakers', resultForSample('meeting-en-clean', { speakers: 2 })],
		[
			'provenance_basis',
			resultForSample('meeting-en-clean', { provenance_basis: 'public-domain' }),
		],
		[
			'reference_words',
			resultForSample('meeting-en-clean', {
				reference_words: 20,
				word_errors: 1,
				wer_percent: 5,
			}),
		],
		[
			'audio_duration_seconds',
			resultForSample('meeting-en-clean', {
				metrics: { audio_duration_seconds: 21, inference_rtf: 2 / 21 },
			}),
		],
	];

	for (const [field, conflicting] of conflicts) {
		const expectedError =
			field === 'reference_words'
				? new RegExp(`inconsistent identity.*${field}`)
				: new RegExp(`${field} must match corpus sample`);
		assert.throws(
			() =>
				aggregateRunReports([
					variantReport([canonical], { model: 'whisper-test', backend: 'metal' }),
					variantReport([conflicting], { model: 'whisper-test', backend: 'cpu' }),
				]),
			expectedError,
		);
	}
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
	const wrongProtocol = report([result()], {
		reference_protocol_id: 'another-reference-v1',
	});
	const protocolErrors = validateRunReportsAgainstCorpus([wrongProtocol], corpus).join('\n');
	assert.match(protocolErrors, /reference_protocol_id must match corpus\.reference_protocol_id/);

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

	const wrongAudio = report([result({ metrics: { audio_sha256: 'f'.repeat(64) } })]);
	assert.match(
		validateRunReportsAgainstCorpus([wrongAudio], corpus).join('\n'),
		/audio_sha256 must match corpus sample/,
	);

	const publicCorpus = loadedCorpus([
		corpusSample({
			dataset: 'fleurs',
			provenance: { basis: 'public-license' },
		}),
	]);
	const publicReport = report([result({ dataset: 'fleurs', provenance_basis: 'public-license' })]);
	assert.deepEqual(validateRunReportsAgainstCorpus([publicReport], publicCorpus), []);
	publicReport.results[0].dataset = 'ami';
	assert.match(
		validateRunReportsAgainstCorpus([publicReport], publicCorpus).join('\n'),
		/results\[0\]\.dataset must match corpus sample/,
	);
});

test('rejects mixed corpora and incompatible pass thresholds', () => {
	const first = report([result()]);
	const otherCorpus = { ...report([result()]), corpus_id: 'another-corpus' };
	assert.throws(() => aggregateRunReports([first, otherCorpus]), /corpus_id must match/);

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

test('requires task and repeat identity only for schema-11 campaign reports', () => {
	const campaign = report([result()], {
		schema_version: 11,
		benchmark_task_id: 'f'.repeat(64),
		repeat_index: 2,
	});
	assert.deepEqual(validateRunReport(campaign), []);

	const missingTask = { ...campaign };
	delete missingTask.benchmark_task_id;
	assert.match(
		validateRunReport(missingTask).join('\n'),
		/benchmark_task_id is required for schema-11 campaign reports/,
	);
	const missingRepeat = { ...campaign };
	delete missingRepeat.repeat_index;
	assert.match(
		validateRunReport(missingRepeat).join('\n'),
		/repeat_index is required for schema-11 campaign reports/,
	);
	assert.match(
		validateRunReport({
			...report([result()]),
			benchmark_task_id: 'f'.repeat(64),
		}).join('\n'),
		/benchmark_task_id is only allowed in schema-11 campaign reports/,
	);
	assert.match(
		validateRunReport({ ...campaign, results: [result(), result()] }).join('\n'),
		/results must contain exactly one result for a schema-11 campaign report/,
	);
});

test('requires a supported dataset only for public-license results in schemas 10 and 11', () => {
	for (const schemaVersion of [10, 11]) {
		const identity =
			schemaVersion === 11 ? { benchmark_task_id: 'f'.repeat(64), repeat_index: 1 } : {};
		const valid = report([result({ dataset: 'fleurs', provenance_basis: 'public-license' })], {
			schema_version: schemaVersion,
			...identity,
		});
		assert.deepEqual(validateRunReport(valid), []);

		const missing = report([result({ provenance_basis: 'public-license' })], {
			schema_version: schemaVersion,
			...identity,
		});
		assert.match(
			validateRunReport(missing).join('\n'),
			/dataset is required for public-license samples/,
		);
		const unsupported = report([result({ dataset: 'other', provenance_basis: 'public-license' })], {
			schema_version: schemaVersion,
			...identity,
		});
		assert.match(
			validateRunReport(unsupported).join('\n'),
			/dataset must be fleurs, ami, or earnings21/,
		);
		const nonPublic = report([result({ dataset: 'fleurs' })], {
			schema_version: schemaVersion,
			...identity,
		});
		assert.match(
			validateRunReport(nonPublic).join('\n'),
			/dataset is only allowed for public-license samples/,
		);
	}
});

test('rejects legacy reports and missing scorer provenance', () => {
	const legacy = { ...report([result()]), schema_version: 9 };
	assert.deepEqual(validateRunReport(legacy), ['report.schema_version must be 10 or 11']);
	assert.throws(
		() => aggregateRunReports([report([result()]), legacy]),
		/schema_version must be 10 or 11/,
	);

	const missingScorer = { ...report([result()]), wer_scorer: undefined };
	assert.deepEqual(validateRunReport(missingScorer), [
		'report.wer_scorer must be a lowercase versioned identifier ending in -v<number>',
	]);

	const missingProtocol = { ...report([result()]) };
	delete missingProtocol.reference_protocol_id;
	assert.deepEqual(validateRunReport(missingProtocol), [
		'report.reference_protocol_id is required',
		`report.reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`,
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
	assert.throws(() => aggregateRunReports([first, stale]), /corpus_fingerprint must match/);
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
	malformed.results[0].reference_protocol_id = REFERENCE_PROTOCOL_ID;
	delete malformed.results[0].scenario;

	const errors = validateRunReport(malformed).join('\n');
	assert.match(errors, /report\.debug is not allowed/);
	assert.match(errors, /report\.thresholds\.mode is not allowed/);
	assert.match(errors, /report\.results\[0\]\.metadata is not allowed/);
	assert.match(errors, /report\.results\[0\]\.metrics\.driver_notes is not allowed/);
	assert.match(errors, /report\.results\[0\]\.transcript_text is a forbidden sensitive report key/);
	assert.match(
		errors,
		/report\.results\[0\]\.reference_protocol_id is a forbidden sensitive report key/,
	);
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
				model_inference_rtf: 0.3,
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
	assert.match(errors, /metrics\.model_inference_rtf does not match model-input duration/);
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

	const paddedFinalVadBlock = result({
		metrics: {
			inference_audio_seconds: 20.03,
			model_inference_rtf: 2 / 20.03,
		},
	}).metrics;
	assert.deepEqual(validateBenchmarkMetrics(paddedFinalVadBlock), []);

	const materiallyLongerInput = result({
		metrics: {
			inference_audio_seconds: 21,
			model_inference_rtf: 2 / 21,
		},
	}).metrics;
	assert.match(
		validateBenchmarkMetrics(materiallyLongerInput).join('\n'),
		/inference_audio_seconds must not materially exceed source duration/,
	);

	const longSourceOverrun = result({
		metrics: {
			audio_duration_seconds: 100_000,
			inference_rtf: 2 / 100_000,
			inference_audio_seconds: 100_000.04,
			model_inference_rtf: 2 / 100_000.04,
		},
	}).metrics;
	assert.match(
		validateBenchmarkMetrics(longSourceOverrun).join('\n'),
		/inference_audio_seconds must not materially exceed source duration/,
	);

	const noModelInput = result({
		metrics: {
			inference_seconds: 0,
			inference_rtf: 0,
			inference_audio_seconds: 0,
			model_inference_rtf: null,
		},
	}).metrics;
	assert.deepEqual(validateBenchmarkMetrics(noModelInput), []);

	const timedWithoutModelInput = result({
		metrics: {
			inference_audio_seconds: 0,
			model_inference_rtf: null,
		},
	}).metrics;
	assert.match(
		validateBenchmarkMetrics(timedWithoutModelInput).join('\n'),
		/inference_seconds must be zero when no audio reached the ASR model/,
	);

	const missingModelRtf = result({ metrics: { model_inference_rtf: null } }).metrics;
	assert.match(
		validateBenchmarkMetrics(missingModelRtf).join('\n'),
		/model_inference_rtf must be present when audio reached the ASR model/,
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
		schema_version: 4,
		corpus_id: 'consented-meetings-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
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
	const missingManifestForStdout = spawnSync(process.execPath, [scriptPath, inputPath], {
		encoding: 'utf8',
	});
	assert.equal(missingManifestForStdout.status, 2);
	assert.match(missingManifestForStdout.stderr, /--manifest is required/);
	assert.equal(missingManifestForStdout.stdout, '');

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
