import assert from 'node:assert/strict';
import test from 'node:test';

import {
	evaluatePublicCorpusQualification,
	loadPublicQualificationTargets,
	parseQualificationArgs,
} from './public-corpus-qualification.ts';
import { PUBLIC_REFERENCE_PROTOCOL_ID, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const RUNTIME_SHA = 'c'.repeat(64);
const HARDWARE =
	`cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;` +
	`runtime_env_sha256=${RUNTIME_SHA}`;

function key(variant) {
	return `${variant.provider}/${variant.model}/${variant.backend}`;
}

function artifactKey(variant) {
	return `${variant.provider}/${variant.model}`;
}

function measurementKeys(target) {
	const repetitions = target.repetitions ?? 1;
	return target.sample_ids.flatMap((sampleId) =>
		target.benchmark_variants.flatMap((variant) =>
			Array.from({ length: repetitions }, (_, index) => {
				const repeat = repetitions === 1 ? '' : ` / repeat ${index + 1}`;
				return `${sampleId} / ${variant.provider} / ${variant.model} / ${variant.backend}${repeat}`;
			}),
		),
	);
}

function summary(samples, overrides = {}, unitCount = samples) {
	const macro = overrides.macro_wer_percent ?? 10;
	const p95 = overrides.p95_inference_rtf ?? 0.5;
	const peak = overrides.max_peak_rss_mb ?? 500;
	const unitOverrides = overrides.unit_balanced ?? {};
	const unitWer = Object.hasOwn(unitOverrides, 'wer_percent') ? unitOverrides.wer_percent : macro;
	const unitP95 = unitOverrides.p95_inference_rtf ?? p95;
	const unitPeak = unitOverrides.max_peak_rss_mb ?? peak;
	const modelUnitCount = unitOverrides.model_rtf_unit_count ?? unitCount;
	const summaryOverrides = { ...overrides };
	delete summaryOverrides.worst_wer_percent;
	delete summaryOverrides.worst_unit_wer_percent;
	delete summaryOverrides.synthetic_overlap_wer_percent;
	delete summaryOverrides.synthetic_overlap_unit_wer_percent;
	delete summaryOverrides.unit_balanced;
	return {
		samples,
		passed_samples: samples,
		pass_rate_percent: 100,
		audio_duration_seconds: samples * 10,
		inference_seconds: samples * p95 * 10,
		inference_audio_seconds: samples * 8,
		wer_samples: samples,
		reference_words: samples * 10,
		word_errors: Math.round((samples * macro) / 10),
		wer_percent: macro,
		macro_wer_percent: macro,
		hallucination_samples: 0,
		hallucinated_words_total: 0,
		hallucinated_words_max: null,
		aggregate_inference_rtf: p95,
		mean_inference_rtf: p95,
		median_inference_rtf: p95,
		p95_inference_rtf: p95,
		max_inference_rtf: p95,
		aggregate_model_inference_rtf: p95,
		mean_model_inference_rtf: p95,
		median_model_inference_rtf: p95,
		p95_model_inference_rtf: p95,
		max_model_inference_rtf: p95,
		mean_baseline_rss_mb: 100,
		max_baseline_rss_mb: 100,
		mean_peak_rss_mb: peak,
		max_peak_rss_mb: peak,
		mean_peak_rss_delta_mb: peak - 100,
		max_peak_rss_delta_mb: peak - 100,
		unit_balanced: {
			unit_count: unitCount,
			session_count: 0,
			singleton_sample_count: unitCount,
			passed_unit_count: unitCount,
			pass_rate_percent: 100,
			wer_unit_count: unitCount,
			wer_percent: unitWer,
			mean_inference_rtf: unitP95,
			median_inference_rtf: unitP95,
			p95_inference_rtf: unitP95,
			max_inference_rtf: unitP95,
			model_rtf_unit_count: modelUnitCount,
			mean_model_inference_rtf: modelUnitCount === 0 ? null : unitP95,
			median_model_inference_rtf: modelUnitCount === 0 ? null : unitP95,
			p95_model_inference_rtf: modelUnitCount === 0 ? null : unitP95,
			max_model_inference_rtf: modelUnitCount === 0 ? null : unitP95,
			mean_peak_rss_mb: unitPeak,
			median_peak_rss_mb: unitPeak,
			p95_peak_rss_mb: unitPeak,
			max_peak_rss_mb: unitPeak,
			mean_peak_rss_delta_mb: unitPeak - 100,
			median_peak_rss_delta_mb: unitPeak - 100,
			p95_peak_rss_delta_mb: unitPeak - 100,
			max_peak_rss_delta_mb: unitPeak - 100,
			...unitOverrides,
		},
		...summaryOverrides,
	};
}

function diagnostic(variant, target, metrics = {}) {
	const samples = target.sample_ids.length;
	const repetitions = target.repetitions ?? 1;
	const measurements = samples * repetitions;
	const overallUnitCount = target.target_id === 'public-asr-automatic-policy-v1' ? 21 : 6;
	const overall = summary(measurements, metrics, overallUnitCount);
	const grouped = (
		dimension,
		value,
		macro = overall.macro_wer_percent,
		unitWer = overall.unit_balanced.wer_percent,
		groupMeasurements = measurements,
		groupUnitCount = overallUnitCount,
	) => ({
		[dimension]: value,
		summary: summary(
			groupMeasurements,
			{
				...metrics,
				macro_wer_percent: macro,
				unit_balanced: { ...metrics.unit_balanced, wer_percent: unitWer },
			},
			groupUnitCount,
		),
	});
	const worstMacro = metrics.worst_wer_percent ?? overall.macro_wer_percent;
	const worstUnitWer =
		metrics.worst_unit_wer_percent ??
		metrics.unit_balanced?.wer_percent ??
		metrics.worst_wer_percent ??
		overall.unit_balanced.wer_percent;
	const overlapSamples = target.sample_ids.filter((sampleId) =>
		sampleId.endsWith('synthetic-overlap'),
	).length;
	const overlapMeasurements = overlapSamples * repetitions;
	const nonOverlapMeasurements = measurements - overlapMeasurements;
	const overlapMacro = metrics.synthetic_overlap_wer_percent ?? overall.macro_wer_percent;
	const overlapUnitWer =
		metrics.synthetic_overlap_unit_wer_percent ?? overall.unit_balanced.wer_percent;
	const noiseRows = [
		grouped(
			'noise_condition',
			'clean',
			overall.macro_wer_percent,
			overall.unit_balanced.wer_percent,
			nonOverlapMeasurements,
			samples - overlapSamples,
		),
	];
	const languageNoiseRows = [
		{
			language: 'en',
			noise_condition: 'clean',
			summary: grouped(
				'language',
				'en',
				worstMacro,
				worstUnitWer,
				nonOverlapMeasurements,
				samples - overlapSamples,
			).summary,
		},
	];
	if (overlapSamples > 0) {
		noiseRows.push(
			grouped(
				'noise_condition',
				'synthetic-overlap',
				overlapMacro,
				overlapUnitWer,
				overlapMeasurements,
				overlapSamples,
			),
		);
		languageNoiseRows.push({
			language: 'en',
			noise_condition: 'synthetic-overlap',
			summary: grouped(
				'language',
				'en',
				overlapMacro,
				overlapUnitWer,
				overlapMeasurements,
				overlapSamples,
			).summary,
		});
	}
	const hardWerUnitCount =
		target.target_id === 'public-asr-automatic-policy-v1'
			? 21
			: target.sample_ids.length - overlapSamples;
	return {
		...variant,
		observed_sample_count: samples,
		measurement_result_count: measurements,
		groups: {
			overall,
			hard_wer_overall: summary(nonOverlapMeasurements, metrics, hardWerUnitCount),
			dataset: [grouped('dataset', 'fleurs')],
			language: [grouped('language', 'en')],
			scenario: [grouped('scenario', 'read-speech')],
			noise_condition: noiseRows,
			language_noise: languageNoiseRows,
		},
	};
}

function revision(cargoFeatures) {
	return {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: 'd'.repeat(40),
		cargo_lock_sha256: 'e'.repeat(64),
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
		...(cargoFeatures === undefined ? {} : { cargo_features: cargoFeatures }),
		build_env_sha256: 'f'.repeat(64),
	};
}

function accelerator(backend) {
	return backend === 'metal' ? 'Apple M4 Pro integrated GPU' : 'none';
}

function aggregate(target, overrides = {}) {
	const repetitions = target.repetitions ?? 1;
	const perVariant = target.sample_ids.length * repetitions;
	const total = perVariant * target.benchmark_variants.length;
	const metricOverrides = overrides.metrics ?? {};
	const diagnostics = target.benchmark_variants
		.map((variant) =>
				diagnostic(variant, target, metricOverrides[key(variant)] ?? {}),
		)
		.sort((left, right) => key(left).localeCompare(key(right)));
	const backends = [...new Set(target.benchmark_variants.map((variant) => variant.backend))].sort();
	const artifacts = [...new Set(target.benchmark_variants.map(artifactKey))].sort();
	const revisions = Object.fromEntries(
		backends.map((backend) => {
			const evaluatorRevision = revision(backend === 'metal' ? ['metal'] : []);
			return [
				backend,
				{
					evaluator_revision: evaluatorRevision,
					evaluator_revision_sha256: evaluatorRevisionSha256(evaluatorRevision),
				},
			];
		}),
	);
	const comparisonRows = (group, dimensions) =>
		diagnostics.flatMap((entry) =>
			entry.groups[group].map((row) => ({
				provider: entry.provider,
				model: entry.model,
				backend: entry.backend,
				...Object.fromEntries(dimensions.map((dimension) => [dimension, row[dimension]])),
				summary: row.summary,
			})),
		);
	return {
		schema_version: 12,
		generated_at: '2026-07-17T00:00:00.000Z',
		corpus_id: target.corpus_id,
		corpus_fingerprint: target.corpus_fingerprint,
		reference_protocol_id: target.reference_protocol_id,
		aggregation_unit_policy: 'session-id-or-singleton-sample-v1',
		wer_scorer: 'muesly-wer-v1',
		evaluator_revision_common: revision(),
		evaluator_revisions: revisions,
		benchmark_executables: Object.fromEntries(
			backends.map((backend) => [backend, backend === 'metal' ? OTHER_SHA : SHA]),
		),
		operating_system: 'macos',
		architecture: 'aarch64',
		hardware_profile: overrides.hardware_profile ?? HARDWARE,
		accelerators: Object.fromEntries(backends.map((backend) => [backend, accelerator(backend)])),
		model_artifacts: Object.fromEntries(artifacts.map((artifact) => [artifact, SHA])),
		thresholds: { max_wer_percent: 100, max_hallucinated_words: 0 },
		source_report_count: total,
		measurement_result_count: total,
		input_bindings: {
			standalone_schema_10: { report_count: 0, measurement_result_count: 0 },
			task_bound_schema_11: { report_count: total, measurement_result_count: total },
		},
		distinct_sample_count: target.sample_ids.length,
		diagnostics: { variants: diagnostics },
		comparison: {
			status: 'comparable',
			scope: 'supplied-variants',
			target_completeness: 'not-assessed',
			variant_count: target.benchmark_variants.length,
			union_sample_count: target.sample_ids.length,
			common_sample_count: target.sample_ids.length,
			union_measurement_count: perVariant,
			common_measurement_count: perVariant,
			cohorts: diagnostics.map((entry) => ({
				provider: entry.provider,
				model: entry.model,
				backend: entry.backend,
				observed_sample_count: target.sample_ids.length,
				observed_measurement_count: perVariant,
				not_common_sample_count: 0,
				missing_from_union_sample_count: 0,
				not_common_measurement_count: 0,
				missing_from_union_measurement_count: 0,
			})),
			groups: {
				variant: diagnostics.map((entry) => ({
					provider: entry.provider,
					model: entry.model,
					backend: entry.backend,
					summary: entry.groups.overall,
				})),
				dataset_variant: comparisonRows('dataset', ['dataset']),
				language_variant: comparisonRows('language', ['language']),
				scenario_variant: comparisonRows('scenario', ['scenario']),
				noise_condition_variant: comparisonRows('noise_condition', ['noise_condition']),
				language_noise_variant: comparisonRows('language_noise', ['language', 'noise_condition']),
			},
		},
	};
}

function coverage(target, report) {
	const keys = measurementKeys(target);
	const countMap = Object.fromEntries(keys.map((item) => [item, 1]));
	const variantsByFragment = [...target.benchmark_variants].sort(
		(left, right) => key(right).length - key(left).length,
	);
	const cohorts = Object.fromEntries(
		keys.map((item) => {
			const variant = variantsByFragment.find((candidate) =>
				item.includes(` / ${candidate.provider} / ${candidate.model} / ${candidate.backend}`),
			);
			return [
				item,
				[
					{
						operating_system: report.operating_system,
						architecture: report.architecture,
						hardware_profile: report.hardware_profile,
						accelerator: report.accelerators[variant.backend],
						distinct_units: 1,
					},
				],
			];
		}),
	);
	return {
		schema_version: 12,
		target_id: target.target_id,
		coverage_mode: 'explicit-samples',
		repetitions: target.repetitions ?? 1,
		corpus_id: report.corpus_id,
		corpus_fingerprint: report.corpus_fingerprint,
		source_catalog_sha256: target.source_catalog_sha256,
		selection_sha256: target.selection_sha256,
		reference_protocol_id: report.reference_protocol_id,
		wer_scorer: report.wer_scorer,
		model_artifacts: report.model_artifacts,
		evaluator_revision_sha256_by_backend: Object.fromEntries(
			Object.entries(report.evaluator_revisions).map(([backend, value]) => [
				backend,
				value.evaluator_revision_sha256,
			]),
		),
		benchmark_executable_sha256_by_backend: report.benchmark_executables,
		minimum_distinct_sessions_per_cell: null,
		eligible_samples: target.sample_ids.length,
		participant_meeting_samples: 0,
		participant_meeting_sessions: 0,
		corpus: {
			unit_kind: 'sample',
			covered_cells: target.sample_ids.length,
			required_cells: target.sample_ids.length,
			counts: Object.fromEntries(target.sample_ids.map((sample) => [sample, 1])),
			missing_cells: [],
		},
		measurements: {
			unit_kind: 'sample',
			reports: keys.length,
			covered_cells: keys.length,
			required_cells: keys.length,
			counts: countMap,
			compatible_counts: countMap,
			hardware_cohorts: cohorts,
			hardware_split_cells: [],
			missing_cells: [],
			matrix_hardware_cohorts: [
				{
					operating_system: report.operating_system,
					architecture: report.architecture,
					hardware_profile: report.hardware_profile,
					accelerators: report.accelerators,
					covered_cells: keys.length,
					required_cells: keys.length,
					counts: countMap,
					missing_cells: [],
				},
			],
			complete_matrix_hardware_cohorts: 1,
		},
		complete: true,
	};
}

function evidence(target, options = {}) {
	const report = aggregate(target, options);
	return { aggregate: report, coverage: coverage(target, report) };
}

function fixture(options = {}) {
	const targets = loadPublicQualificationTargets();
	return {
		automatic_policy: evidence(targets.automatic_policy, {
			metrics: options.automaticMetrics,
			hardware_profile: options.automaticHardware,
		}),
		performance: evidence(targets.performance, {
			metrics: options.performanceMetrics,
			hardware_profile: options.performanceHardware,
		}),
		...(options.catalog === false
			? {}
			: {
					catalog_audit: evidence(targets.catalog_audit, {
						metrics: options.catalogMetrics,
						hardware_profile: options.catalogHardware,
					}),
				}),
	};
}

test('qualifies the smallest artifact inside the complete quality and speed envelope', () => {
	const automaticMetrics = {
		'whisper/base-q5_1/cpu': { macro_wer_percent: 10, worst_wer_percent: 15 },
		'whisper/small-q5_1/cpu': { macro_wer_percent: 10.5, worst_wer_percent: 14 },
		'whisper/medium-q5_0/cpu': { macro_wer_percent: 13, worst_wer_percent: 17 },
		'whisper/large-v3-turbo-q5_0/cpu': { macro_wer_percent: 10, worst_wer_percent: 12 },
		'whisper/large-v3-turbo-q5_0/metal': { macro_wer_percent: 10, worst_wer_percent: 12 },
		'whisper/large-v3-q5_0/metal': { macro_wer_percent: 9, worst_wer_percent: 10 },
		'parakeet/parakeet-tdt-0.6b-v3-int8/onnx-cpu': {
			macro_wer_percent: 11,
			worst_wer_percent: 14,
		},
	};
	const result = evaluatePublicCorpusQualification(fixture({ automaticMetrics, catalog: false }));
	assert.equal(result.schema_version, 3);
	assert.equal(result.policy_id, 'muesly-public-asr-qualification-v3');
	assert.equal(result.decision.status, 'provisional-exploratory-ranking');
	assert.deepEqual(result.decision.exploratory_candidate, {
		provider: 'whisper',
		model: 'base-q5_1',
		backend: 'cpu',
		model_artifact_sha256: SHA,
	});
	assert.equal(result.decision.production_tier_change_authorized, false);
	assert.deepEqual(result.phase_boundary.may_update_tiers, []);
	assert.deepEqual(result.phase_boundary.unchanged_tiers, ['low', 'medium', 'high', 'ultra']);
	assert.equal(result.phase_boundary.translation_policy, 'unchanged');
	assert.deepEqual(result.phase_boundary.catalog_audit_only_models, ['tiny-q5_1']);
	assert.equal(result.phase_boundary.may_update_catalog_visibility, false);
	assert.equal(result.phase_boundary.production_configuration_mutated, false);
	assert.equal(result.phase_boundary.evidence_status, 'provisional');
	assert.equal(result.phase_boundary.public_bootstrap_unit_count, 21);
	assert.equal(result.phase_boundary.candidate_ranking_use, 'exploratory-only');
	assert.equal(result.phase_boundary.required_corroboration.status, 'missing');
	assert.equal(result.phase_boundary.required_corroboration.minimum_independent_sessions, 60);
	assert.equal(result.catalog_retention.status, 'not-evaluated');
	assert.equal(result.catalog_retention.production_catalog_change_authorized, false);
});

test('bases qualification decisions on unit-balanced metrics when flat diagnostics disagree', () => {
	const result = evaluatePublicCorpusQualification(
		fixture({
			catalog: false,
			automaticMetrics: {
				'whisper/base-q5_1/cpu': {
					macro_wer_percent: 99,
					worst_wer_percent: 99,
					worst_unit_wer_percent: 12,
					unit_balanced: { wer_percent: 10 },
				},
				'whisper/medium-q5_0/cpu': {
					macro_wer_percent: 0,
					worst_wer_percent: 0,
					worst_unit_wer_percent: 40,
					unit_balanced: { wer_percent: 30 },
				},
			},
			performanceMetrics: {
				'whisper/base-q5_1/cpu': {
					p95_inference_rtf: 0.1,
					max_peak_rss_mb: 999,
					unit_balanced: { p95_inference_rtf: 1.1, max_peak_rss_mb: 123 },
				},
			},
		}),
	);
	const base = result.candidates.find((candidate) => candidate.model === 'base-q5_1');
	assert.equal(base.macro_wer_percent, 10);
	assert.equal(base.worst_language_noise_slice.macro_wer_percent, 12);
	assert.equal(base.p95_inference_rtf, 1.1);
	assert.equal(base.peak_rss_mb, 123);
	assert(base.exploratory_ineligibility_reasons.includes('p95-inference-rtf-not-below-1'));

	const medium = result.candidates.find((candidate) => candidate.model === 'medium-q5_0');
	assert(
		medium.exploratory_ineligibility_reasons.includes(
			'macro-wer-more-than-2-points-from-best',
		),
	);
	assert(
		medium.exploratory_ineligibility_reasons.includes(
			'worst-language-noise-slice-more-than-5-points-from-best',
		),
	);
	assert.equal(result.decision.exploratory_candidate.model, 'small-q5_1');
});

test('requires p95 inference RTF to be strictly below one', () => {
	const result = evaluatePublicCorpusQualification(
		fixture({
			catalog: false,
			performanceMetrics: {
				'whisper/base-q5_1/cpu': { p95_inference_rtf: 1 },
			},
		}),
	);
	const base = result.candidates.find((candidate) => candidate.model === 'base-q5_1');
	assert.equal(base.exploratory_eligible, false);
	assert(
		base.exploratory_ineligibility_reasons.includes('p95-inference-rtf-not-below-1'),
	);
	assert.equal(result.decision.exploratory_candidate.model, 'small-q5_1');
});

test('uses lower RSS for equal-size backends whose speed differs by less than ten percent', () => {
	const poorSmallModels = {
		'whisper/base-q5_1/cpu': { macro_wer_percent: 20, worst_wer_percent: 30 },
		'whisper/small-q5_1/cpu': { macro_wer_percent: 20, worst_wer_percent: 30 },
		'whisper/medium-q5_0/cpu': { macro_wer_percent: 20, worst_wer_percent: 30 },
		'parakeet/parakeet-tdt-0.6b-v3-int8/onnx-cpu': {
			macro_wer_percent: 20,
			worst_wer_percent: 30,
		},
	};
	const result = evaluatePublicCorpusQualification(
		fixture({
			catalog: false,
			automaticMetrics: poorSmallModels,
			performanceMetrics: {
				'whisper/large-v3-turbo-q5_0/cpu': {
					p95_inference_rtf: 0.5,
					max_peak_rss_mb: 500,
				},
				'whisper/large-v3-turbo-q5_0/metal': {
					p95_inference_rtf: 0.54,
					max_peak_rss_mb: 400,
				},
			},
		}),
	);
	assert.equal(result.decision.exploratory_candidate.model, 'large-v3-turbo-q5_0');
	assert.equal(result.decision.exploratory_candidate.backend, 'metal');
	assert.deepEqual(result.decision.tie_break.resource_preference_candidates, [
		'whisper/large-v3-turbo-q5_0/cpu',
		'whisper/large-v3-turbo-q5_0/metal',
	]);
});

test('does not treat an exact ten-percent speed difference as a resource tie', () => {
	const poorSmallModels = {
		'whisper/base-q5_1/cpu': { macro_wer_percent: 20, worst_wer_percent: 30 },
		'whisper/small-q5_1/cpu': { macro_wer_percent: 20, worst_wer_percent: 30 },
		'whisper/medium-q5_0/cpu': { macro_wer_percent: 20, worst_wer_percent: 30 },
		'parakeet/parakeet-tdt-0.6b-v3-int8/onnx-cpu': {
			macro_wer_percent: 20,
			worst_wer_percent: 30,
		},
	};
	const result = evaluatePublicCorpusQualification(
		fixture({
			catalog: false,
			automaticMetrics: poorSmallModels,
			performanceMetrics: {
				'whisper/large-v3-turbo-q5_0/cpu': {
					p95_inference_rtf: 0.5,
					max_peak_rss_mb: 500,
				},
				'whisper/large-v3-turbo-q5_0/metal': {
					p95_inference_rtf: 0.55,
					max_peak_rss_mb: 300,
				},
			},
		}),
	);
	assert.equal(result.decision.exploratory_candidate.backend, 'cpu');
});

test('applies the exact catalog retention improvement thresholds', () => {
	const result = evaluatePublicCorpusQualification(
		fixture({
			performanceMetrics: {
				'whisper/base-q5_1/cpu': { macro_wer_percent: 11, worst_wer_percent: 15 },
				'whisper/small-q5_1/cpu': { macro_wer_percent: 10, worst_wer_percent: 18 },
				'whisper/medium-q5_0/cpu': { macro_wer_percent: 10.9, worst_wer_percent: 17.9 },
			},
			catalogMetrics: {
				'whisper/tiny-q5_1/cpu': { macro_wer_percent: 11, worst_wer_percent: 15 },
				'whisper/tiny/cpu': { macro_wer_percent: 10, worst_wer_percent: 15 },
				'whisper/base/cpu': { macro_wer_percent: 10, worst_wer_percent: 15 },
				'whisper/small/cpu': { macro_wer_percent: 10, worst_wer_percent: 15 },
				'whisper/medium/cpu': { macro_wer_percent: 10, worst_wer_percent: 15 },
			},
		}),
	);
	const byModel = new Map(
		result.catalog_retention.decisions.map((decision) => [
			decision.full_precision_variant.model,
			decision,
		]),
	);
	assert.equal(byModel.get('base').macro_wer_improvement_points, 1);
	assert.equal(byModel.get('base').exploratory_retention_signal, true);
	assert.equal(byModel.get('base').retain_new_download_visibility, false);
	assert.equal(byModel.get('small').critical_slice_improvement_points, 3);
	assert.equal(byModel.get('small').exploratory_retention_signal, true);
	assert.equal(byModel.get('small').retain_new_download_visibility, false);
	assert.equal(byModel.get('medium').exploratory_retention_signal, false);
	assert.equal(byModel.get('medium').retain_new_download_visibility, false);
	assert.equal(result.catalog_retention.status, 'provisional-exploratory');
	assert.equal(result.catalog_retention.production_catalog_change_authorized, false);
});

test('bases catalog retention on unit-balanced WER when flat diagnostics disagree', () => {
	const result = evaluatePublicCorpusQualification(
		fixture({
			performanceMetrics: {
				'whisper/base-q5_1/cpu': {
					macro_wer_percent: 20,
					worst_wer_percent: 30,
					worst_unit_wer_percent: 17,
					unit_balanced: { wer_percent: 10.5 },
				},
			},
			catalogMetrics: {
				'whisper/base/cpu': {
					macro_wer_percent: 10,
					worst_wer_percent: 15,
					worst_unit_wer_percent: 15,
					unit_balanced: { wer_percent: 10 },
				},
			},
		}),
	);
	const base = result.catalog_retention.decisions.find(
		(decision) => decision.full_precision_variant.model === 'base',
	);
	assert.equal(base.macro_wer_improvement_points, 0.5);
	assert.equal(base.critical_slice_improvement_points, 2);
	assert.equal(base.exploratory_retention_signal, false);
	assert.equal(base.retain_new_download_visibility, false);
});

test('rejects standalone reports even when aggregate counts look complete', () => {
	const input = fixture({ catalog: false });
	input.automatic_policy.aggregate.input_bindings.standalone_schema_10.report_count = 1;
	assert.throws(
		() => evaluatePublicCorpusQualification(input),
		/only schema-11 task-bound reports/,
	);
});

test('rejects incomplete and wrong-target coverage', () => {
	const incomplete = fixture({ catalog: false });
	incomplete.performance.coverage.complete = false;
	assert.throws(() => evaluatePublicCorpusQualification(incomplete), /one complete compatible/);

	const wrongTarget = fixture({ catalog: false });
	wrongTarget.automatic_policy.coverage.target_id = 'public-asr-performance-v1';
	assert.throws(() => evaluatePublicCorpusQualification(wrongTarget), /target_id does not match/);
});

test('requires public evidence to match the committed reference protocol', () => {
	const input = fixture({ catalog: false });
	assert.equal(
		input.automatic_policy.aggregate.reference_protocol_id,
		PUBLIC_REFERENCE_PROTOCOL_ID,
	);
	input.automatic_policy.aggregate.reference_protocol_id = REFERENCE_PROTOCOL_ID;
	assert.throws(
		() => evaluatePublicCorpusQualification(input),
		/reference_protocol_id must match the committed target/,
	);
});

test('rejects self-consistent evidence for any corpus or source revision outside the fixed target', () => {
	const corpusDrift = fixture({ catalog: false });
	for (const suite of ['automatic_policy', 'performance']) {
		corpusDrift[suite].aggregate.corpus_fingerprint = OTHER_SHA;
		corpusDrift[suite].coverage.corpus_fingerprint = OTHER_SHA;
	}
	assert.throws(
		() => evaluatePublicCorpusQualification(corpusDrift),
		/corpus_fingerprint must match the committed target/,
	);

	const sourceDrift = fixture({ catalog: false });
	for (const suite of ['automatic_policy', 'performance']) {
		sourceDrift[suite].coverage.source_catalog_sha256 = OTHER_SHA;
		sourceDrift[suite].coverage.selection_sha256 = OTHER_SHA;
	}
	assert.throws(
		() => evaluatePublicCorpusQualification(sourceDrift),
		/source_catalog_sha256 must match the committed target/,
	);
});

test('keeps synthetic-overlap WER diagnostic while excluding it from candidate decisions', () => {
	const result = evaluatePublicCorpusQualification(
		fixture({
			catalog: false,
			automaticMetrics: {
				'whisper/base-q5_1/cpu': {
					macro_wer_percent: 10,
					worst_unit_wer_percent: 12,
					synthetic_overlap_wer_percent: 100,
					synthetic_overlap_unit_wer_percent: 100,
				},
				'whisper/small-q5_1/cpu': {
					macro_wer_percent: 20,
					worst_unit_wer_percent: 20,
					synthetic_overlap_wer_percent: 0,
					synthetic_overlap_unit_wer_percent: 0,
				},
			},
		}),
	);
	const base = result.candidates.find((candidate) => candidate.model === 'base-q5_1');
	const small = result.candidates.find((candidate) => candidate.model === 'small-q5_1');
	assert.equal(base.macro_wer_percent, 10);
	assert.equal(base.worst_language_noise_slice.macro_wer_percent, 12);
	assert.equal(base.synthetic_overlap_diagnostic.macro_wer_percent, 100);
	assert.equal(base.synthetic_overlap_diagnostic.decision_use, 'diagnostic-only');
	assert.equal(small.macro_wer_percent, 20);
	assert.equal(small.synthetic_overlap_diagnostic.macro_wer_percent, 0);
	assert.equal(result.decision.exploratory_candidate.model, 'base-q5_1');
	assert.deepEqual(result.quality_policy.excluded_noise_conditions, ['synthetic-overlap']);
	assert.equal(result.quality_policy.synthetic_overlap_use, 'diagnostic-and-performance-only');
});

test('excludes synthetic-overlap disagreement from catalog-retention signals', () => {
	const result = evaluatePublicCorpusQualification(
		fixture({
			performanceMetrics: {
				'whisper/base-q5_1/cpu': {
					macro_wer_percent: 10,
					worst_unit_wer_percent: 10,
					synthetic_overlap_wer_percent: 0,
					synthetic_overlap_unit_wer_percent: 0,
				},
			},
			catalogMetrics: {
				'whisper/base/cpu': {
					macro_wer_percent: 10,
					worst_unit_wer_percent: 10,
					synthetic_overlap_wer_percent: 100,
					synthetic_overlap_unit_wer_percent: 100,
				},
			},
		}),
	);
	const base = result.catalog_retention.decisions.find(
		(decision) => decision.full_precision_variant.model === 'base',
	);
	assert.equal(base.macro_wer_improvement_points, 0);
	assert.equal(base.critical_slice_improvement_points, 0);
	assert.equal(base.exploratory_retention_signal, false);
	assert.equal(base.retain_new_download_visibility, false);
});

test('rejects unknown nested fields under the closed aggregate schema', () => {
	const input = fixture({ catalog: false });
	input.performance.aggregate.diagnostics.variants[0].groups.overall.unreviewed_metric = 1;
	assert.throws(() => evaluatePublicCorpusQualification(input), /unreviewed_metric is not allowed/);

	const nested = fixture({ catalog: false });
	nested.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced.unreviewed_metric = 1;
	assert.throws(
		() => evaluatePublicCorpusQualification(nested),
		/unreviewed_metric is not allowed/,
	);
});

test('requires the pinned aggregation policy and coherent nullable model RTF metrics', () => {
	const wrongPolicy = fixture({ catalog: false });
	wrongPolicy.performance.aggregate.aggregation_unit_policy = 'measurement-v1';
	assert.throws(() => evaluatePublicCorpusQualification(wrongPolicy), /aggregation_unit_policy/);

	const incoherent = fixture({ catalog: false });
	const unitBalanced =
		incoherent.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced;
	unitBalanced.model_rtf_unit_count = 0;
	assert.throws(() => evaluatePublicCorpusQualification(incoherent), /without model RTF units/);

	const coherent = fixture({ catalog: false });
	const modelFree =
		coherent.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced;
	modelFree.model_rtf_unit_count = 0;
	modelFree.mean_model_inference_rtf = null;
	modelFree.median_model_inference_rtf = null;
	modelFree.p95_model_inference_rtf = null;
	modelFree.max_model_inference_rtf = null;
	assert.doesNotThrow(() => evaluatePublicCorpusQualification(coherent));
});

test('requires unit pass rates to match their counts within numeric tolerance', () => {
	const inconsistent = fixture({ catalog: false });
	const invalid =
		inconsistent.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced;
	invalid.passed_unit_count -= 1;
	assert.throws(
		() => evaluatePublicCorpusQualification(inconsistent),
		/pass_rate_percent must match passed_unit_count \/ unit_count/,
	);

	const rounded = fixture({ catalog: false });
	const tolerated =
		rounded.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced;
	tolerated.passed_unit_count -= 1;
	tolerated.pass_rate_percent = (tolerated.passed_unit_count / tolerated.unit_count) * 100 + 5e-8;
	assert.doesNotThrow(() => evaluatePublicCorpusQualification(rounded));
});

test('rejects more overall aggregation units than observed samples', () => {
	const input = fixture({ catalog: false });
	const diagnostic = input.performance.aggregate.diagnostics.variants[0];
	const unitBalanced = diagnostic.groups.overall.unit_balanced;
	const excessiveUnits = diagnostic.observed_sample_count + 1;
	Object.assign(unitBalanced, {
		unit_count: excessiveUnits,
		session_count: 0,
		singleton_sample_count: excessiveUnits,
		passed_unit_count: excessiveUnits,
		wer_unit_count: excessiveUnits,
		model_rtf_unit_count: excessiveUnits,
	});
	assert.throws(
		() => evaluatePublicCorpusQualification(input),
		/unit_count cannot exceed observed_sample_count/,
	);

	const groupedInput = fixture({ catalog: false });
	const groupedSummary =
		groupedInput.performance.aggregate.diagnostics.variants[0].groups.language[0].summary;
	const groupedUnits = groupedSummary.samples + 1;
	Object.assign(groupedSummary.unit_balanced, {
		unit_count: groupedUnits,
		session_count: 0,
		singleton_sample_count: groupedUnits,
		passed_unit_count: groupedUnits,
		wer_unit_count: groupedUnits,
		model_rtf_unit_count: groupedUnits,
	});
	assert.throws(
		() => evaluatePublicCorpusQualification(groupedInput),
		/unit_count cannot exceed .*\.samples/,
	);
});

test('requires nearest-rank p95 to equal max below twenty eligible units', () => {
	const cases = [
		{
			name: 'source RTF',
			values: { median_inference_rtf: 0.4, p95_inference_rtf: 0.4 },
			error: /p95_inference_rtf must equal .*max_inference_rtf.*fewer than 20/,
		},
		{
			name: 'model RTF',
			values: { median_model_inference_rtf: 0.4, p95_model_inference_rtf: 0.4 },
			error: /p95_model_inference_rtf must equal .*max_model_inference_rtf.*fewer than 20/,
		},
		{
			name: 'peak RSS',
			values: { median_peak_rss_mb: 499, p95_peak_rss_mb: 499 },
			error: /p95_peak_rss_mb must equal .*max_peak_rss_mb.*fewer than 20/,
		},
		{
			name: 'peak RSS delta',
			values: { median_peak_rss_delta_mb: 399, p95_peak_rss_delta_mb: 399 },
			error: /p95_peak_rss_delta_mb must equal .*max_peak_rss_delta_mb.*fewer than 20/,
		},
	];
	for (const { name, values, error } of cases) {
		const input = fixture({ catalog: false });
		const unitBalanced =
			input.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced;
		Object.assign(unitBalanced, values);
		assert.throws(() => evaluatePublicCorpusQualification(input), error, name);
	}
});

test('rejects impossible unit-balanced distribution statistics', () => {
	const cases = [
		{
			name: 'source RTF order',
			values: { median_inference_rtf: 0.6, p95_inference_rtf: 0.5 },
			error: /median_inference_rtf must not exceed .*p95_inference_rtf/,
		},
		{
			name: 'source RTF mean',
			values: { mean_inference_rtf: 0.6, max_inference_rtf: 0.5 },
			error: /mean_inference_rtf must not exceed .*max_inference_rtf/,
		},
		{
			name: 'model RTF order',
			values: { p95_model_inference_rtf: 0.6, max_model_inference_rtf: 0.5 },
			error: /p95_model_inference_rtf must not exceed .*max_model_inference_rtf/,
		},
		{
			name: 'model RTF mean',
			values: { mean_model_inference_rtf: 0.6, max_model_inference_rtf: 0.5 },
			error: /mean_model_inference_rtf must not exceed .*max_model_inference_rtf/,
		},
		{
			name: 'peak RSS order',
			values: { median_peak_rss_mb: 501, p95_peak_rss_mb: 500 },
			error: /median_peak_rss_mb must not exceed .*p95_peak_rss_mb/,
		},
		{
			name: 'peak RSS mean',
			values: { mean_peak_rss_mb: 501, max_peak_rss_mb: 500 },
			error: /mean_peak_rss_mb must not exceed .*max_peak_rss_mb/,
		},
		{
			name: 'peak RSS delta order',
			values: { p95_peak_rss_delta_mb: 401, max_peak_rss_delta_mb: 400 },
			error: /p95_peak_rss_delta_mb must not exceed .*max_peak_rss_delta_mb/,
		},
		{
			name: 'peak RSS delta mean',
			values: { mean_peak_rss_delta_mb: 401, max_peak_rss_delta_mb: 400 },
			error: /mean_peak_rss_delta_mb must not exceed .*max_peak_rss_delta_mb/,
		},
	];
	for (const { name, values, error } of cases) {
		const input = fixture({ catalog: false });
		const unitBalanced =
			input.performance.aggregate.diagnostics.variants[0].groups.overall.unit_balanced;
		Object.assign(unitBalanced, values);
		assert.throws(() => evaluatePublicCorpusQualification(input), error, name);
	}
});

test('rejects a second or non-Apple hardware cohort', () => {
	const split = fixture({ catalog: false });
	split.performance.coverage.measurements.matrix_hardware_cohorts.push(
		structuredClone(split.performance.coverage.measurements.matrix_hardware_cohorts[0]),
	);
	assert.throws(() => evaluatePublicCorpusQualification(split), /exactly one cohort/);

	const nonApple = fixture({
		catalog: false,
		automaticHardware: `cpu=AMD Ryzen;logical_cpus=16;memory_bytes=25769803776;runtime_env_sha256=${RUNTIME_SHA}`,
	});
	assert.throws(() => evaluatePublicCorpusQualification(nonApple), /identify Apple hardware/);
});

test('rejects cross-suite hardware and artifact drift', () => {
	const hardwareDrift = fixture({
		catalog: false,
		performanceHardware: `cpu=Apple M3;logical_cpus=8;memory_bytes=17179869184;runtime_env_sha256=${RUNTIME_SHA}`,
	});
	assert.throws(
		() => evaluatePublicCorpusQualification(hardwareDrift),
		/hardware_profile must match/,
	);

	const artifactDrift = fixture({ catalog: false });
	artifactDrift.performance.aggregate.model_artifacts['whisper/base-q5_1'] = OTHER_SHA;
	artifactDrift.performance.coverage.model_artifacts['whisper/base-q5_1'] = OTHER_SHA;
	assert.throws(
		() => evaluatePublicCorpusQualification(artifactDrift),
		/must match automatic-policy/,
	);
});

test('binds accelerator, evaluator, executable, and threshold provenance across suites', () => {
	const acceleratorDrift = fixture({ catalog: false });
	acceleratorDrift.performance.aggregate.accelerators.metal = 'Different Apple integrated GPU';
	acceleratorDrift.performance.coverage.measurements.matrix_hardware_cohorts[0].accelerators.metal =
		'Different Apple integrated GPU';
	for (const [cell, cohorts] of Object.entries(
		acceleratorDrift.performance.coverage.measurements.hardware_cohorts,
	)) {
		if (cell.includes(' / metal')) cohorts[0].accelerator = 'Different Apple integrated GPU';
	}
	assert.throws(
		() => evaluatePublicCorpusQualification(acceleratorDrift),
		/accelerators\.metal must match/,
	);

	const evaluatorDrift = fixture({ catalog: false });
	evaluatorDrift.performance.aggregate.evaluator_revisions.metal.evaluator_revision_sha256 = SHA;
	evaluatorDrift.performance.coverage.evaluator_revision_sha256_by_backend.metal = SHA;
	assert.throws(
		() => evaluatePublicCorpusQualification(evaluatorDrift),
		/does not match its embedded evaluator revision/,
	);

	const featureDrift = fixture({ catalog: false });
	const metalRevision = featureDrift.performance.aggregate.evaluator_revisions.metal;
	metalRevision.evaluator_revision.cargo_features = ['metal', 'vulkan'];
	metalRevision.evaluator_revision_sha256 = evaluatorRevisionSha256(
		metalRevision.evaluator_revision,
	);
	featureDrift.performance.coverage.evaluator_revision_sha256_by_backend.metal =
		metalRevision.evaluator_revision_sha256;
	assert.throws(
		() => evaluatePublicCorpusQualification(featureDrift),
		/evaluator revision for 'metal' does not match/,
	);

	const commonFieldDrift = fixture({ catalog: false });
	const cpuRevision = commonFieldDrift.performance.aggregate.evaluator_revisions.cpu;
	cpuRevision.evaluator_revision.build_env_sha256 = OTHER_SHA;
	cpuRevision.evaluator_revision_sha256 = evaluatorRevisionSha256(cpuRevision.evaluator_revision);
	commonFieldDrift.performance.coverage.evaluator_revision_sha256_by_backend.cpu =
		cpuRevision.evaluator_revision_sha256;
	assert.throws(
		() => evaluatePublicCorpusQualification(commonFieldDrift),
		/evaluator_revision common fields does not match/,
	);

	const executableDrift = fixture({ catalog: false });
	executableDrift.performance.aggregate.benchmark_executables.metal = SHA;
	executableDrift.performance.coverage.benchmark_executable_sha256_by_backend.metal = SHA;
	assert.throws(
		() => evaluatePublicCorpusQualification(executableDrift),
		/benchmark executable for 'metal' must match/,
	);

	const thresholdDrift = fixture({ catalog: false });
	thresholdDrift.performance.aggregate.thresholds.max_wer_percent = 99;
	assert.throws(
		() => evaluatePublicCorpusQualification(thresholdDrift),
		/performance\.aggregate\.thresholds does not match/,
	);
});

test('catalog retention compares the same language/noise slice instead of independent maxima', () => {
	const input = fixture({
		performanceMetrics: {
			'whisper/medium-q5_0/cpu': { macro_wer_percent: 10, worst_wer_percent: 10 },
		},
		catalogMetrics: {
			'whisper/medium/cpu': { macro_wer_percent: 10, worst_wer_percent: 10 },
		},
	});
	const full = input.catalog_audit.aggregate.diagnostics.variants.find(
		(variant) => variant.model === 'medium',
	);
	const quantized = input.performance.aggregate.diagnostics.variants.find(
		(variant) => variant.model === 'medium-q5_0',
	);
	full.groups.language_noise = [
		{
			language: 'en',
			noise_condition: 'clean',
			summary: summary(5, { macro_wer_percent: 20 }),
		},
		{
			language: 'en',
			noise_condition: 'office',
			summary: summary(5, { macro_wer_percent: 10 }),
		},
	];
	quantized.groups.language_noise = [
		{
			language: 'en',
			noise_condition: 'clean',
			summary: summary(15, { macro_wer_percent: 21 }),
		},
		{
			language: 'en',
			noise_condition: 'office',
			summary: summary(15, { macro_wer_percent: 15 }),
		},
	];
	const result = evaluatePublicCorpusQualification(input);
	const medium = result.catalog_retention.decisions.find(
		(decision) => decision.full_precision_variant.model === 'medium',
	);
	assert.deepEqual(medium.critical_slice, {
		language: 'en',
		noise_condition: 'office',
		full_precision_macro_wer_percent: 10,
		quantized_macro_wer_percent: 15,
		improvement_points: 5,
	});
	assert.equal(medium.exploratory_retention_signal, true);
	assert.equal(medium.retain_new_download_visibility, false);
});

test('strictly parses the qualification CLI evidence pairs', () => {
	const parsed = parseQualificationArgs([
		'--automatic-aggregate',
		'a.json',
		'--automatic-coverage',
		'ac.json',
		'--performance-aggregate',
		'p.json',
		'--performance-coverage',
		'pc.json',
	]);
	assert.equal(parsed['--automatic-aggregate'], 'a.json');
	assert.throws(
		() => parseQualificationArgs(['--automatic-aggregate', 'a.json']),
		/--automatic-coverage is required/,
	);
	assert.throws(
		() =>
			parseQualificationArgs([
				'--automatic-aggregate',
				'a',
				'--automatic-coverage',
				'ac',
				'--performance-aggregate',
				'p',
				'--performance-coverage',
				'pc',
				'--catalog-aggregate',
				'c',
			]),
		/provided together/,
	);
});
