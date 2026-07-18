import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { corpusFingerprint, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import {
	evaluateCoverage,
	formatCoverage,
	normalizeCoverageTargets,
	validateCoverageTargets,
} from './coverage.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import { WER_SCORER_ID } from './wer.ts';

const RUNTIME_ENV_SHA256 = 'f'.repeat(64);

function hardwareProfile(cpu, logicalCpus, memoryBytes) {
	return (
		`cpu=${cpu};logical_cpus=${logicalCpus};memory_bytes=${memoryBytes};` +
		`runtime_env_sha256=${RUNTIME_ENV_SHA256}`
	);
}

const targets = {
	schema_version: 3,
	target_id: 'test-targets',
	reference_protocol_id: REFERENCE_PROTOCOL_ID,
	coverage_mode: 'language-noise-matrix',
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

test('normalizes legacy matrix targets before strict schema-4 validation', () => {
	const legacy = { ...targets, schema_version: 2 };
	delete legacy.coverage_mode;
	assert.deepEqual(validateCoverageTargets(legacy), []);
	assert.deepEqual(normalizeCoverageTargets(legacy), {
		...legacy,
		schema_version: 4,
		coverage_mode: 'language-noise-matrix',
	});
	assert.deepEqual(normalizeCoverageTargets(targets), { ...targets, schema_version: 4 });
	assert.match(
		validateCoverageTargets({ ...legacy, repetitions: 2 }).join('\n'),
		/targets\.repetitions is not an allowed field in schema 2/,
	);
});

test('requires bounded portable model names in coverage targets', () => {
	for (const model of ['a'.repeat(129), 'model.', 'con', 'nul.model', 'com1.onnx', 'lpt9.extra']) {
		const invalidTargets = {
			...targets,
			benchmark_variants: [{ provider: 'whisper', model, backend: 'metal' }],
		};
		assert.match(
			validateCoverageTargets(invalidTargets).join('\n'),
			/bounded portable lowercase model slug/,
		);
	}
});

test('rejects impossible provider and backend target variants', () => {
	for (const [provider, backend] of [
		['parakeet', 'cpu'],
		['whisper', 'onnx-cpu'],
		['unknown', 'cpu'],
	]) {
		const invalidTargets = {
			...targets,
			benchmark_variants: [{ provider, model: 'test-model', backend }],
		};
		assert.match(
			validateCoverageTargets(invalidTargets).join('\n'),
			new RegExp(`unsupported reported benchmark backend '${provider}/${backend}'`),
		);
	}
});

test('accepts the canonical Core ML target backend', () => {
	assert.deepEqual(
		validateCoverageTargets({
			...targets,
			benchmark_variants: [{ provider: 'whisper', model: 'test-model', backend: 'coreml-metal' }],
		}),
		[],
	);
});

test('validates discriminated explicit-sample targets and bounded repetitions', () => {
	const explicit = {
		schema_version: 3,
		target_id: 'public-performance-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		coverage_mode: 'explicit-samples',
		sample_ids: ['en-clean-session-1'],
		benchmark_variants: [{ provider: 'whisper', model: 'test-model', backend: 'metal' }],
		repetitions: 3,
	};
	assert.deepEqual(validateCoverageTargets(explicit), []);
	for (const repetitions of [0, 11, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.match(
			validateCoverageTargets({ ...explicit, repetitions }).join('\n'),
			/safe integer from 1 through 10/,
		);
	}
	assert.match(
		validateCoverageTargets({ ...explicit, languages: ['en'] }).join('\n'),
		/targets\.languages is not an allowed field/,
	);
	assert.match(
		validateCoverageTargets({ ...targets, sample_ids: ['en-clean-session-1'] }).join('\n'),
		/targets\.sample_ids is not an allowed field/,
	);
});

function sample(language, noise, session) {
	return {
		id: `${language}-${noise}-${session}`,
		session_id: `session-${session}`,
		audio_sha256: createHash('sha256').update(session).digest('hex'),
		language,
		noise_condition: noise,
		scenario: 'meeting',
		speakers: 2,
		duration_seconds: 10,
		provenance: { basis: 'participant-consent' },
	};
}

function makeEvaluatorRevision(backend, overrides = {}) {
	const cargoFeatures = {
		cpu: [],
		metal: ['metal'],
		'coreml-metal': ['coreml'],
		cuda: ['cuda'],
		vulkan: ['vulkan'],
		'openblas-cpu': ['openblas'],
		hipblas: ['hipblas'],
		'onnx-cpu': [],
	}[backend];
	if (!cargoFeatures) throw new Error(`unsupported test backend '${backend}'`);
	return {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: 'a'.repeat(40),
		cargo_lock_sha256: 'b'.repeat(64),
		rustc_vv: [
			'rustc 1.88.0 (6b00bc388 2025-06-23)',
			'binary: rustc',
			'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc',
			'commit-date: 2025-06-23',
			'host: aarch64-apple-darwin',
			'release: 1.88.0',
			'LLVM version: 20.1.5',
		].join('\n'),
		build_profile: 'release',
		target_triple: 'aarch64-apple-darwin',
		cargo_features: cargoFeatures,
		build_env_sha256: 'e'.repeat(64),
		...overrides,
	};
}

function runReport(corpus, backend, options = {}) {
	const reportSamples = options.samples ?? corpus.samples;
	const evaluatorRevision = options.evaluatorRevision ?? makeEvaluatorRevision(backend);
	const evaluatorRevisionDigest =
		options.evaluatorRevisionSha256 ?? evaluatorRevisionSha256(evaluatorRevision);
	const benchmarkExecutableSha256 =
		options.benchmarkExecutableSha256 ?? (backend === 'onnx-cpu' ? '2'.repeat(64) : '1'.repeat(64));
	return {
		schema_version: 10,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		reference_protocol_id: corpus.reference_protocol_id,
		started_at: '2026-07-16T00:00:00.000Z',
		completed_at: '2026-07-16T00:00:01.000Z',
		wer_scorer: options.werScorer ?? WER_SCORER_ID,
		provider: backend === 'onnx-cpu' ? 'parakeet' : 'whisper',
		model: 'test-model',
		model_artifact_sha256:
			options.modelArtifactSha256 ?? (backend === 'onnx-cpu' ? 'd'.repeat(64) : 'c'.repeat(64)),
		...(options.repeatIndex === undefined ? {} : { repeat_index: options.repeatIndex }),
		evaluator_revision: evaluatorRevision,
		evaluator_revision_sha256: evaluatorRevisionDigest,
		benchmark_executable_sha256: benchmarkExecutableSha256,
		thresholds: { max_wer_percent: 10, max_hallucinated_words: 2 },
		passed: true,
		results: reportSamples.map((corpusSample) => ({
			sample_id: corpusSample.id,
			language: corpusSample.language,
			noise_condition: corpusSample.noise_condition,
			scenario: corpusSample.scenario,
			speakers: corpusSample.speakers,
			provenance_basis: corpusSample.provenance.basis,
			passed: true,
			reference_words: 10,
			word_errors: 1,
			wer_percent: 10,
			hallucinated_words: null,
			metrics: {
				schema_version: 7,
				provider: backend === 'onnx-cpu' ? 'parakeet' : 'whisper',
				model: 'test-model',
				backend,
				benchmark_executable_sha256: benchmarkExecutableSha256,
				operating_system: options.operatingSystem ?? 'macos',
				architecture: options.architecture ?? 'aarch64',
				hardware_profile:
					options.hardwareProfile ?? hardwareProfile('Apple M4 Pro', 14, 25_769_803_776),
				accelerator:
					options.accelerator ?? (backend === 'onnx-cpu' ? 'none' : 'Apple M4 Pro integrated GPU'),
				audio_sha256: corpusSample.audio_sha256,
				audio_duration_seconds: 10,
				decode_seconds: 0.75,
				vad_seconds: 0.25,
				model_download_seconds: 0,
				model_load_seconds: 2,
				inference_seconds: 1,
				inference_rtf: 0.1,
				inference_audio_seconds: 5,
				model_inference_rtf: 0.2,
				measured_total_seconds: 4,
				baseline_rss_mb: 20,
				peak_rss_mb: 100,
				peak_rss_delta_mb: 80,
			},
		})),
	};
}

function campaignRunReport(corpus, backend, options = {}) {
	const repeatIndex = options.repeatIndex ?? 1;
	const standalone = runReport(corpus, backend, { ...options, repeatIndex });
	const sampleId = standalone.results[0]?.sample_id ?? 'missing-sample';
	const taskIdentity = JSON.stringify([
		options.targetId ?? 'test-targets',
		corpus.corpus_fingerprint,
		standalone.provider,
		standalone.model,
		backend,
		sampleId,
		repeatIndex,
	]);
	return {
		...standalone,
		schema_version: 11,
		benchmark_task_id:
			options.benchmarkTaskId ?? createHash('sha256').update(taskIdentity).digest('hex'),
		repeat_index: repeatIndex,
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
	return {
		corpus_id: 'test-corpus',
		corpus_fingerprint: 'a'.repeat(64),
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		samples,
	};
}

test('evaluates a schema-2 matrix target through the compatibility boundary', () => {
	const legacy = { ...targets, schema_version: 2 };
	delete legacy.coverage_mode;
	const coverage = evaluateCoverage(completeCorpus(), legacy);

	assert.equal(coverage.coverage_mode, 'language-noise-matrix');
	assert.equal(coverage.corpus.unit_kind, 'session');
	assert.equal(coverage.corpus.covered_cells, 4);
});

test('binds schema-4 targets to one exact corpus, catalog, and selection revision', () => {
	const corpus = {
		...completeCorpus(),
		source_catalog_sha256: 'b'.repeat(64),
		preparation: { selection_sha256: 'c'.repeat(64) },
	};
	const boundTargets = {
		...targets,
		schema_version: 4,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		source_catalog_sha256: corpus.source_catalog_sha256,
		selection_sha256: corpus.preparation.selection_sha256,
	};
	assert.deepEqual(validateCoverageTargets(boundTargets), []);
	const coverage = evaluateCoverage(corpus, boundTargets);
	assert.equal(coverage.source_catalog_sha256, corpus.source_catalog_sha256);
	assert.equal(coverage.selection_sha256, corpus.preparation.selection_sha256);

	for (const field of [
		'corpus_id',
		'corpus_fingerprint',
		'source_catalog_sha256',
		'selection_sha256',
	]) {
		const drifted = { ...boundTargets, [field]: field === 'corpus_id' ? 'other-corpus' : 'd'.repeat(64) };
		assert.throws(
			() => evaluateCoverage(corpus, drifted),
			new RegExp(`coverage targets ${field} does not match`),
			field,
		);
	}

	const partial = { ...boundTargets };
	delete partial.selection_sha256;
	assert.match(
		validateCoverageTargets(partial).join('\n'),
		/selection_sha256 is required when the target binds a corpus revision/,
	);
	assert.match(
		validateCoverageTargets({ ...targets, source_catalog_sha256: 'b'.repeat(64) }).join('\n'),
		/source_catalog_sha256 is not an allowed field in schema 3/,
	);
});

test('requires every explicit sample, variant, and repeat on one compatible hardware cohort', () => {
	const corpus = completeCorpus();
	const selectedSample = corpus.samples[0];
	const explicitTargets = {
		schema_version: 3,
		target_id: 'public-performance-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		coverage_mode: 'explicit-samples',
		sample_ids: [selectedSample.id],
		benchmark_variants: [{ provider: 'whisper', model: 'test-model', backend: 'metal' }],
		repetitions: 3,
	};
	const reports = [1, 2, 3].map((repeatIndex) =>
		campaignRunReport(corpus, 'metal', {
			samples: [selectedSample],
			repeatIndex,
			targetId: explicitTargets.target_id,
		}),
	);
	const partial = evaluateCoverage(corpus, explicitTargets, reports.slice(0, 2));
	assert.equal(partial.coverage_mode, 'explicit-samples');
	assert.equal(partial.corpus.unit_kind, 'sample');
	assert.equal(partial.corpus.covered_cells, 1);
	assert.equal(partial.measurements.covered_cells, 2);
	assert.deepEqual(partial.measurements.missing_cells, [
		`${selectedSample.id} / whisper / test-model / metal / repeat 3`,
	]);
	assert.equal(partial.complete, false);

	const complete = evaluateCoverage(corpus, explicitTargets, reports);
	assert.equal(complete.repetitions, 3);
	assert.equal(complete.eligible_samples, 1);
	assert.equal(complete.measurements.required_cells, 3);
	const firstCell = complete.measurements.hardware_cohorts[Object.keys(complete.measurements.hardware_cohorts)[0]];
	assert.equal(firstCell[0].distinct_units, 1);
	assert.equal(Object.hasOwn(firstCell[0], 'distinct_sessions'), false);
	assert.equal(complete.measurements.complete_matrix_hardware_cohorts, 1);
	assert.equal(complete.complete, true);
	assert.throws(
		() => evaluateCoverage(corpus, explicitTargets, [...reports, structuredClone(reports[2])]),
		/duplicate benchmark_task_id/,
	);
	assert.throws(
		() =>
			evaluateCoverage(corpus, explicitTargets, [
				reports[0],
				{ ...reports[1], benchmark_task_id: reports[0].benchmark_task_id },
				reports[2],
			]),
		/duplicate benchmark_task_id/,
	);
	assert.throws(
		() =>
			evaluateCoverage(corpus, explicitTargets, [
				runReport(corpus, 'metal', { samples: [selectedSample] }),
			]),
		/repeated coverage requires schema-11 campaign reports/,
	);
	const copiedStandalone = runReport(corpus, 'metal', { samples: [selectedSample] });
	assert.throws(
		() =>
			evaluateCoverage(
				corpus,
				explicitTargets,
				[1, 2, 3].map((repeatIndex) => ({
					...structuredClone(copiedStandalone),
					repeat_index: repeatIndex,
				})),
			),
		/repeated coverage requires schema-11 campaign reports/,
	);
	assert.throws(
		() =>
			evaluateCoverage(corpus, {
				...explicitTargets,
				sample_ids: ['missing-public-sample'],
			}),
		/target sample 'missing-public-sample' is absent/,
	);
});

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

test('requires every measurement cell and accepts a same-machine multi-backend matrix', () => {
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
	assert.equal(complete.schema_version, 12);
	assert.equal(complete.corpus_fingerprint, corpus.corpus_fingerprint);
	assert.equal(complete.reference_protocol_id, REFERENCE_PROTOCOL_ID);
	assert.equal(complete.wer_scorer, WER_SCORER_ID);
	assert.deepEqual(complete.evaluator_revision_sha256_by_backend, {
		metal: evaluatorRevisionSha256(runReport(corpus, 'metal').evaluator_revision),
		'onnx-cpu': evaluatorRevisionSha256(runReport(corpus, 'onnx-cpu').evaluator_revision),
	});
	assert.deepEqual(complete.benchmark_executable_sha256_by_backend, {
		metal: '1'.repeat(64),
		'onnx-cpu': '2'.repeat(64),
	});
	assert.deepEqual(complete.measurements.compatible_counts, complete.measurements.counts);
	assert.deepEqual(complete.measurements.hardware_split_cells, []);
	assert.equal(complete.measurements.complete_matrix_hardware_cohorts, 1);
	assert.equal(complete.measurements.matrix_hardware_cohorts.length, 1);
	assert.deepEqual(complete.measurements.matrix_hardware_cohorts[0].accelerators, {
		metal: 'Apple M4 Pro integrated GPU',
		'onnx-cpu': 'none',
	});
	assert.equal(complete.measurements.matrix_hardware_cohorts[0].covered_cells, 8);
	assert.deepEqual(complete.measurements.matrix_hardware_cohorts[0].missing_cells, []);
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
			hardwareProfile: hardwareProfile('Apple M4 Pro', 14, 25_769_803_776),
			accelerator: 'Shared Metal GPU',
		}),
		runReport(corpus, 'metal', {
			samples: secondSessions,
			hardwareProfile: hardwareProfile('Apple M3 Max', 16, 68_719_476_736),
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
			distinct_units: cohort.distinct_units,
		})),
		[
			{
				hardware_profile: hardwareProfile('Apple M3 Max', 16, 68_719_476_736),
				accelerator: 'Shared Metal GPU',
				distinct_units: 1,
			},
			{
				hardware_profile: hardwareProfile('Apple M4 Pro', 14, 25_769_803_776),
				accelerator: 'Shared Metal GPU',
				distinct_units: 1,
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
	assert.equal(coverage.measurements.hardware_cohorts[cell][0].distinct_units, 2);
	assert.equal(coverage.complete, true);
});

test('does not accept a full matrix assembled from different machines by cell', () => {
	const corpus = completeCorpus();
	const englishSamples = corpus.samples.filter((corpusSample) =>
		corpusSample.language.startsWith('en'),
	);
	const spanishSamples = corpus.samples.filter((corpusSample) =>
		corpusSample.language.startsWith('es'),
	);
	const m3 = {
		hardwareProfile: hardwareProfile('Apple M3 Max', 16, 68_719_476_736),
	};
	const coverage = evaluateCoverage(corpus, targets, [
		runReport(corpus, 'metal', { samples: englishSamples }),
		runReport(corpus, 'onnx-cpu', { samples: englishSamples }),
		runReport(corpus, 'metal', { samples: spanishSamples, ...m3 }),
		runReport(corpus, 'onnx-cpu', { samples: spanishSamples, ...m3 }),
	]);

	assert.equal(coverage.measurements.covered_cells, 8);
	assert.deepEqual(coverage.measurements.missing_cells, []);
	assert.deepEqual(coverage.measurements.hardware_split_cells, []);
	assert.equal(coverage.measurements.complete_matrix_hardware_cohorts, 0);
	assert.equal(coverage.measurements.matrix_hardware_cohorts.length, 2);
	assert.deepEqual(
		coverage.measurements.matrix_hardware_cohorts.map((cohort) => ({
			hardware_profile: cohort.hardware_profile,
			covered_cells: cohort.covered_cells,
			missing_cells: cohort.missing_cells,
		})),
		[
			{
				hardware_profile: hardwareProfile('Apple M3 Max', 16, 68_719_476_736),
				covered_cells: 4,
				missing_cells: [
					'en / clean / whisper / test-model / metal',
					'en / clean / parakeet / test-model / onnx-cpu',
					'en / office / whisper / test-model / metal',
					'en / office / parakeet / test-model / onnx-cpu',
				],
			},
			{
				hardware_profile: hardwareProfile('Apple M4 Pro', 14, 25_769_803_776),
				covered_cells: 4,
				missing_cells: [
					'es / clean / whisper / test-model / metal',
					'es / clean / parakeet / test-model / onnx-cpu',
					'es / office / whisper / test-model / metal',
					'es / office / parakeet / test-model / onnx-cpu',
				],
			},
		],
	);
	assert.equal(coverage.complete, false);
	assert.match(formatCoverage(coverage), /Full-matrix hardware cohorts: 0\/2/);
});

test('requires one accelerator identity per backend across the full matrix', () => {
	const corpus = completeCorpus();
	const englishSamples = corpus.samples.filter((corpusSample) =>
		corpusSample.language.startsWith('en'),
	);
	const spanishSamples = corpus.samples.filter((corpusSample) =>
		corpusSample.language.startsWith('es'),
	);
	const coverage = evaluateCoverage(corpus, targets, [
		runReport(corpus, 'metal', {
			samples: englishSamples,
			accelerator: 'Integrated Metal GPU',
		}),
		runReport(corpus, 'metal', {
			samples: spanishSamples,
			accelerator: 'External Metal GPU',
		}),
		runReport(corpus, 'onnx-cpu'),
	]);

	assert.equal(coverage.measurements.covered_cells, 8);
	assert.deepEqual(coverage.measurements.missing_cells, []);
	assert.equal(coverage.measurements.complete_matrix_hardware_cohorts, 0);
	assert.deepEqual(
		coverage.measurements.matrix_hardware_cohorts.map((cohort) => ({
			accelerators: cohort.accelerators,
			covered_cells: cohort.covered_cells,
			missing_cells: cohort.missing_cells,
		})),
		[
			{
				accelerators: {
					metal: 'External Metal GPU',
					'onnx-cpu': 'none',
				},
				covered_cells: 6,
				missing_cells: [
					'en / clean / whisper / test-model / metal',
					'en / office / whisper / test-model / metal',
				],
			},
			{
				accelerators: {
					metal: 'Integrated Metal GPU',
					'onnx-cpu': 'none',
				},
				covered_cells: 6,
				missing_cells: [
					'es / clean / whisper / test-model / metal',
					'es / office / whisper / test-model / metal',
				],
			},
		],
	);
	assert.equal(coverage.complete, false);
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

test('rejects mixed evaluator target platforms before assembling hardware cohorts', async (t) => {
	for (const [dimension, backend, options] of [
		[
			'operating system',
			'onnx-cpu',
			{
				operatingSystem: 'linux',
				architecture: 'x86_64',
				evaluatorRevision: makeEvaluatorRevision('onnx-cpu', {
					target_triple: 'x86_64-unknown-linux-gnu',
				}),
			},
		],
		[
			'architecture',
			'metal',
			{
				architecture: 'x86_64',
				evaluatorRevision: makeEvaluatorRevision('metal', {
					target_triple: 'x86_64-apple-darwin',
				}),
			},
		],
	]) {
		await t.test(dimension, () => {
			const corpus = completeCorpus();
			const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
			const secondSessions = corpus.samples.filter((corpusSample) =>
				corpusSample.id.endsWith('-2'),
			);
			assert.throws(
				() =>
					evaluateCoverage(corpus, targets, [
						runReport(corpus, backend, { samples: firstSessions }),
						runReport(corpus, backend, { samples: secondSessions, ...options }),
					]),
				/reports use different evaluator revision field 'target_triple'/,
			);
		});
	}
});

test('rejects malformed targets and reports for another corpus', () => {
	assert(validateCoverageTargets({}).length > 0);
	const corpus = completeCorpus();
	const report = { ...runReport(corpus, 'metal'), corpus_id: 'wrong-corpus' };
	assert.throws(() => evaluateCoverage(corpus, targets, [report]), /corpus_id must match/);
});

test('rejects stale reports after a corpus revision changes', () => {
	const corpus = completeCorpus();
	const stale = { ...runReport(corpus, 'metal'), corpus_fingerprint: 'b'.repeat(64) };
	assert.throws(() => evaluateCoverage(corpus, targets, [stale]), /corpus_fingerprint must match/);
});

test('rejects report sample metadata that differs from the corpus manifest', async (t) => {
	for (const [field, value] of [
		['language', 'fr'],
		['noise_condition', 'remote-call'],
		['scenario', 'dictation'],
		['speakers', 3],
		['provenance_basis', 'synthetic'],
	]) {
		await t.test(field, () => {
			const corpus = completeCorpus();
			const report = runReport(corpus, 'metal');
			report.results[0][field] = value;

			assert.throws(
				() => evaluateCoverage(corpus, targets, [report]),
				new RegExp(`reports\\[0\\]\\.results\\[0\\]\\.${field} must match corpus sample`),
			);
		});
	}
});

test('binds measured audio duration to the corpus manifest before counting coverage', () => {
	const corpus = completeCorpus();
	const report = runReport(corpus, 'metal');
	report.results[0].metrics.audio_duration_seconds = 9;
	report.results[0].metrics.inference_rtf =
		report.results[0].metrics.inference_seconds / report.results[0].metrics.audio_duration_seconds;

	assert.throws(
		() => evaluateCoverage(corpus, targets, [report]),
		/audio_duration_seconds must match corpus sample/,
	);
});

test('rejects duplicate measurements across reports', () => {
	const corpus = completeCorpus();
	const first = runReport(corpus, 'metal', { samples: [corpus.samples[0]] });
	const duplicate = runReport(corpus, 'metal', { samples: [corpus.samples[0]] });

	assert.throws(
		() => evaluateCoverage(corpus, targets, [first, duplicate]),
		/duplicate measurement for whisper\/test-model\/metal sample/,
	);
});

test('rejects legacy reports without versioned scoring provenance', () => {
	const corpus = completeCorpus();
	const legacy = { ...runReport(corpus, 'metal'), schema_version: 9 };
	assert.throws(() => evaluateCoverage(corpus, targets, [legacy]), /schema_version must be 10 or 11/);
});

test('allows backend-specific Cargo features while enforcing a common evaluator revision', () => {
	const corpus = completeCorpus();
	const metal = runReport(corpus, 'metal');
	const onnxCpu = runReport(corpus, 'onnx-cpu');

	assert.notDeepEqual(
		metal.evaluator_revision.cargo_features,
		onnxCpu.evaluator_revision.cargo_features,
	);
	assert.notEqual(metal.evaluator_revision_sha256, onnxCpu.evaluator_revision_sha256);
	assert.equal(evaluateCoverage(corpus, targets, [metal, onnxCpu]).complete, true);
});

test('rejects evaluator source or toolchain changes across backends', () => {
	const corpus = completeCorpus();
	const metal = runReport(corpus, 'metal');
	const changedRevision = {
		...runReport(corpus, 'onnx-cpu').evaluator_revision,
		git_commit: 'f'.repeat(40),
	};
	const changed = runReport(corpus, 'onnx-cpu', { evaluatorRevision: changedRevision });

	assert.throws(
		() => evaluateCoverage(corpus, targets, [metal, changed]),
		/reports use different evaluator revision field 'git_commit'/,
	);
});

test('rejects mixed evaluator revisions for the same backend', () => {
	const corpus = completeCorpus();
	const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
	const secondSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-2'));
	const first = runReport(corpus, 'metal', { samples: firstSessions });
	const changedRevision = {
		...first.evaluator_revision,
		build_env_sha256: 'f'.repeat(64),
	};
	const changed = runReport(corpus, 'metal', {
		samples: secondSessions,
		evaluatorRevision: changedRevision,
	});

	assert.throws(
		() => evaluateCoverage(corpus, targets, [first, changed]),
		/reports use different evaluator revision field 'build_env_sha256'/,
	);
});

test('rejects mixed benchmark executables for the same backend', () => {
	const corpus = completeCorpus();
	const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
	const secondSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-2'));
	const first = runReport(corpus, 'metal', { samples: firstSessions });
	const changed = runReport(corpus, 'metal', {
		samples: secondSessions,
		benchmarkExecutableSha256: '3'.repeat(64),
	});

	assert.throws(
		() => evaluateCoverage(corpus, targets, [first, changed]),
		/reports use different benchmark executables for backend 'metal'/,
	);
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

test('binds Core ML artifacts by reported backend while preserving other model keys', () => {
	const corpus = completeCorpus();
	const metal = runReport(corpus, 'metal');
	const coreMl = runReport(corpus, 'coreml-metal', {
		modelArtifactSha256: 'e'.repeat(64),
		accelerator: 'Apple M4 Pro Neural Engine',
	});
	const coverage = evaluateCoverage(corpus, targets, [metal, coreMl]);
	assert.deepEqual(coverage.model_artifacts, {
		'whisper/test-model': 'c'.repeat(64),
		'whisper/test-model/coreml-metal': 'e'.repeat(64),
	});

	const firstSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-1'));
	const secondSessions = corpus.samples.filter((corpusSample) => corpusSample.id.endsWith('-2'));
	assert.throws(
		() =>
			evaluateCoverage(corpus, targets, [
				runReport(corpus, 'coreml-metal', {
					samples: firstSessions,
					modelArtifactSha256: 'e'.repeat(64),
					accelerator: 'Apple M4 Pro Neural Engine',
				}),
				runReport(corpus, 'coreml-metal', {
					samples: secondSessions,
					modelArtifactSha256: 'f'.repeat(64),
					accelerator: 'Apple M4 Pro Neural Engine',
				}),
			]),
		/different artifacts for model 'whisper\/test-model\/coreml-metal'/,
	);
});

test('rejects coverage assembled with different WER scorers', () => {
	const corpus = completeCorpus();
	const first = runReport(corpus, 'metal');
	const changed = runReport(corpus, 'onnx-cpu', {
		werScorer: 'muesly-wer-unicode-v2',
	});
	assert.throws(
		() => evaluateCoverage(corpus, targets, [first, changed]),
		/reports use different WER scorers/,
	);
});

test('fails clearly when accelerator mapping combinations are pathological', () => {
	const corpus = {
		corpus_id: 'pathological-corpus',
		corpus_fingerprint: 'a'.repeat(64),
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		samples: Array.from({ length: 17 }, (_, index) => ({
			...sample('en', 'clean', `pathological-${index}`),
			audio_sha256: index.toString(16).padStart(64, '0'),
		})),
	};
	const backends = ['cuda', 'vulkan', 'hipblas'];
	const pathologicalTargets = {
		...targets,
		benchmark_variants: backends.map((backend) => ({
			provider: 'whisper',
			model: 'test-model',
			backend,
		})),
	};
	const reports = backends.flatMap((backend) =>
		corpus.samples.map((corpusSample, index) =>
			runReport(corpus, backend, {
				samples: [corpusSample],
				accelerator: `${backend}-accelerator-${index}`,
				operatingSystem: 'linux',
				architecture: 'x86_64',
				evaluatorRevision: makeEvaluatorRevision(backend, {
					target_triple: 'x86_64-unknown-linux-gnu',
				}),
			}),
		),
	);

	assert.throws(
		() => evaluateCoverage(corpus, pathologicalTargets, reports),
		/hardware matrix exceeds 4096 candidate accelerator mappings/,
	);
});

test('writes coverage through the managed local corpus results path', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-coverage-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	fs.mkdirSync(path.join(directory, 'local-corpus'));
	const document = {
		schema_version: 4,
		corpus_id: 'local-consented-meetings',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
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
	assert.equal(coverage.wer_scorer, null);
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
