#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateHardwareProfile } from './benchmark-executable.ts';
import { validateCoverageTargets } from './corpus-targets.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import { CATALOG_AUDIT_MODELS, POLICY_MODELS } from './model-prepare.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REFERENCE_PROTOCOL_ID = 'muesly-meeting-reference-v1';
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export const PUBLIC_QUALIFICATION_POLICY_ID = 'muesly-public-asr-qualification-v1';
export const PUBLIC_QUALIFICATION_SCHEMA_VERSION = 1;

const SUITES = Object.freeze({
	automatic_policy: {
		targetId: 'public-asr-automatic-policy-v1',
		file: 'public-corpus-targets-automatic-policy.json',
		required: true,
		sampleCount: 66,
		variantCount: 7,
		repetitions: 1,
		taskCount: 462,
	},
	performance: {
		targetId: 'public-asr-performance-v1',
		file: 'public-corpus-targets-performance.json',
		required: true,
		sampleCount: 10,
		variantCount: 7,
		repetitions: 3,
		taskCount: 210,
	},
	catalog_audit: {
		targetId: 'public-asr-catalog-audit-v1',
		file: 'public-corpus-targets-catalog-audit.json',
		required: false,
		sampleCount: 10,
		variantCount: 7,
		repetitions: 1,
		taskCount: 70,
	},
});

const AGGREGATE_FIELDS = new Set([
	'schema_version',
	'generated_at',
	'corpus_id',
	'corpus_fingerprint',
	'reference_protocol_id',
	'wer_scorer',
	'evaluator_revision_common',
	'evaluator_revisions',
	'benchmark_executables',
	'operating_system',
	'architecture',
	'hardware_profile',
	'accelerators',
	'model_artifacts',
	'thresholds',
	'source_report_count',
	'measurement_result_count',
	'input_bindings',
	'distinct_sample_count',
	'diagnostics',
	'comparison',
]);
const COVERAGE_FIELDS = new Set([
	'schema_version',
	'target_id',
	'coverage_mode',
	'repetitions',
	'corpus_id',
	'corpus_fingerprint',
	'reference_protocol_id',
	'wer_scorer',
	'model_artifacts',
	'evaluator_revision_sha256_by_backend',
	'benchmark_executable_sha256_by_backend',
	'minimum_distinct_sessions_per_cell',
	'eligible_samples',
	'participant_meeting_samples',
	'participant_meeting_sessions',
	'corpus',
	'measurements',
	'complete',
]);
const SUMMARY_FIELDS = new Set([
	'samples',
	'passed_samples',
	'pass_rate_percent',
	'audio_duration_seconds',
	'inference_seconds',
	'inference_audio_seconds',
	'wer_samples',
	'reference_words',
	'word_errors',
	'wer_percent',
	'macro_wer_percent',
	'hallucination_samples',
	'hallucinated_words_total',
	'hallucinated_words_max',
	'aggregate_inference_rtf',
	'mean_inference_rtf',
	'median_inference_rtf',
	'p95_inference_rtf',
	'max_inference_rtf',
	'aggregate_model_inference_rtf',
	'mean_model_inference_rtf',
	'median_model_inference_rtf',
	'p95_model_inference_rtf',
	'max_model_inference_rtf',
	'mean_baseline_rss_mb',
	'max_baseline_rss_mb',
	'mean_peak_rss_mb',
	'max_peak_rss_mb',
	'mean_peak_rss_delta_mb',
	'max_peak_rss_delta_mb',
]);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
	throw new Error(message);
}

function assertObject(value, label) {
	if (!isObject(value)) fail(`${label} must be an object`);
}

function assertClosed(value, fields, label, optional = new Set()) {
	assertObject(value, label);
	for (const field of Object.keys(value)) {
		if (!fields.has(field)) fail(`${label}.${field} is not allowed`);
	}
	for (const field of fields) {
		if (!optional.has(field) && !Object.hasOwn(value, field)) fail(`${label}.${field} is required`);
	}
}

function assertFinite(value, label, minimum = 0) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
		fail(`${label} must be a finite number >= ${minimum}`);
	}
}

function assertInteger(value, label, minimum = 0) {
	if (!Number.isSafeInteger(value) || value < minimum) {
		fail(`${label} must be a safe integer >= ${minimum}`);
	}
}

function assertString(value, label) {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > 16_384 ||
		value !== value.trim() ||
		value.includes('\0')
	) {
		fail(`${label} must be a bounded non-empty string without surrounding whitespace`);
	}
}

function assertSha256(value, label) {
	if (!SHA256_PATTERN.test(value ?? '')) fail(`${label} must be a lowercase SHA-256 digest`);
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonical(value[key])]),
	);
}

function assertSame(left, right, label) {
	if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) {
		fail(`${label} does not match the bound evidence`);
	}
}

function variantKey(variant) {
	return `${variant.provider}/${variant.model}/${variant.backend}`;
}

function artifactKey(variant) {
	return `${variant.provider}/${variant.model}`;
}

function compareVariant(left, right) {
	return variantKey(left).localeCompare(variantKey(right));
}

function exactKeys(value, expectedKeys, label, validateValue) {
	assertObject(value, label);
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(`${label} keys do not match the committed target`);
	}
	for (const key of expected) validateValue(value[key], `${label}[${JSON.stringify(key)}]`, key);
}

function readJson(filePath, label) {
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
	if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES) {
		fail(`${label} must contain 1 through ${MAX_INPUT_BYTES} bytes`);
	}
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function loadPublicQualificationTargets() {
	return Object.fromEntries(
		Object.entries(SUITES).map(([suite, definition]) => {
			const target = readJson(path.join(here, definition.file), `${suite} target`);
			const errors = validateCoverageTargets(target);
			if (errors.length > 0) fail(`invalid ${suite} target:\n- ${errors.join('\n- ')}`);
			if (target.target_id !== definition.targetId) {
				fail(`${suite} target_id must remain '${definition.targetId}'`);
			}
			if (target.coverage_mode !== 'explicit-samples') {
				fail(`${suite} target must use explicit-samples coverage`);
			}
			const repetitions = target.repetitions ?? 1;
			const taskCount = target.sample_ids.length * target.benchmark_variants.length * repetitions;
			if (
				target.sample_ids.length !== definition.sampleCount ||
				target.benchmark_variants.length !== definition.variantCount ||
				repetitions !== definition.repetitions ||
				taskCount !== definition.taskCount
			) {
				fail(
					`${suite} target must remain ${definition.sampleCount} samples x ` +
						`${definition.variantCount} variants x ${definition.repetitions} repetitions ` +
						`(${definition.taskCount} tasks)`,
				);
			}
			return [suite, target];
		}),
	);
}

function expectedMeasurementKeys(target) {
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

function validateRevisionCommon(value, label, withCargoFeatures) {
	const fields = new Set([
		'schema_version',
		'protocol_id',
		'git_commit',
		'cargo_lock_sha256',
		'rustc_vv',
		'build_profile',
		'target_triple',
		'build_env_sha256',
		...(withCargoFeatures ? ['cargo_features'] : []),
	]);
	assertClosed(value, fields, label);
	if (value.schema_version !== 1) fail(`${label}.schema_version must be 1`);
	for (const field of ['protocol_id', 'git_commit', 'rustc_vv', 'build_profile', 'target_triple']) {
		assertString(value[field], `${label}.${field}`);
	}
	assertSha256(value.cargo_lock_sha256, `${label}.cargo_lock_sha256`);
	assertSha256(value.build_env_sha256, `${label}.build_env_sha256`);
	if (withCargoFeatures) {
		if (!Array.isArray(value.cargo_features) || value.cargo_features.length > 32) {
			fail(`${label}.cargo_features must be a bounded array`);
		}
		for (const [index, feature] of value.cargo_features.entries()) {
			assertString(feature, `${label}.cargo_features[${index}]`);
		}
	}
}

function validateSummary(value, label, expectedSamples = null) {
	assertClosed(value, SUMMARY_FIELDS, label);
	const integerFields = [
		'samples',
		'passed_samples',
		'wer_samples',
		'reference_words',
		'word_errors',
		'hallucination_samples',
		'hallucinated_words_total',
	];
	for (const field of integerFields) assertInteger(value[field], `${label}.${field}`);
	for (const field of SUMMARY_FIELDS) {
		if (integerFields.includes(field) || field === 'hallucinated_words_max') continue;
		if (value[field] !== null) assertFinite(value[field], `${label}.${field}`);
	}
	if (value.hallucinated_words_max !== null) {
		assertInteger(value.hallucinated_words_max, `${label}.hallucinated_words_max`);
	}
	if (expectedSamples !== null && value.samples !== expectedSamples) {
		fail(`${label}.samples must be ${expectedSamples}`);
	}
	if (value.wer_samples !== value.samples || value.macro_wer_percent === null) {
		fail(`${label} must describe WER evidence for every public sample`);
	}
	if (value.passed_samples > value.samples || value.wer_samples > value.samples) {
		fail(`${label} sample counts are inconsistent`);
	}
}

function validateSummaryRows(rows, dimensions, label, expectedTotal) {
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1024) {
		fail(`${label} must be a bounded non-empty array`);
	}
	const fields = new Set([...dimensions, 'summary']);
	const seen = new Set();
	let total = 0;
	for (const [index, row] of rows.entries()) {
		const prefix = `${label}[${index}]`;
		assertClosed(row, fields, prefix);
		for (const dimension of dimensions) assertString(row[dimension], `${prefix}.${dimension}`);
		const key = JSON.stringify(dimensions.map((dimension) => row[dimension]));
		if (seen.has(key)) fail(`${label} contains duplicate group ${key}`);
		seen.add(key);
		validateSummary(row.summary, `${prefix}.summary`);
		total += row.summary.samples;
	}
	if (expectedTotal !== null && total !== expectedTotal) {
		fail(`${label} must partition ${expectedTotal} measurements`);
	}
}

function validateVariantDiagnostic(value, label, target, expectedMeasurements) {
	assertClosed(
		value,
		new Set([
			'provider',
			'model',
			'backend',
			'observed_sample_count',
			'measurement_result_count',
			'groups',
		]),
		label,
	);
	for (const field of ['provider', 'model', 'backend'])
		assertString(value[field], `${label}.${field}`);
	if (!target.benchmark_variants.some((variant) => variantKey(variant) === variantKey(value))) {
		fail(`${label} is not a committed target variant`);
	}
	if (value.observed_sample_count !== target.sample_ids.length) {
		fail(`${label}.observed_sample_count must cover every target sample`);
	}
	if (value.measurement_result_count !== expectedMeasurements) {
		fail(`${label}.measurement_result_count must cover every planned repetition`);
	}
	assertClosed(
		value.groups,
		new Set(['overall', 'dataset', 'language', 'scenario', 'noise_condition', 'language_noise']),
		`${label}.groups`,
	);
	validateSummary(value.groups.overall, `${label}.groups.overall`, expectedMeasurements);
	validateSummaryRows(
		value.groups.dataset,
		['dataset'],
		`${label}.groups.dataset`,
		expectedMeasurements,
	);
	validateSummaryRows(
		value.groups.language,
		['language'],
		`${label}.groups.language`,
		expectedMeasurements,
	);
	validateSummaryRows(
		value.groups.scenario,
		['scenario'],
		`${label}.groups.scenario`,
		expectedMeasurements,
	);
	validateSummaryRows(
		value.groups.noise_condition,
		['noise_condition'],
		`${label}.groups.noise_condition`,
		expectedMeasurements,
	);
	validateSummaryRows(
		value.groups.language_noise,
		['language', 'noise_condition'],
		`${label}.groups.language_noise`,
		expectedMeasurements,
	);
}

function validateComparison(value, label, diagnostics, target, totalMeasurements) {
	assertClosed(
		value,
		new Set([
			'status',
			'scope',
			'target_completeness',
			'variant_count',
			'union_sample_count',
			'common_sample_count',
			'union_measurement_count',
			'common_measurement_count',
			'cohorts',
			'groups',
		]),
		label,
	);
	if (
		value.status !== 'comparable' ||
		value.scope !== 'supplied-variants' ||
		value.target_completeness !== 'not-assessed'
	) {
		fail(`${label} must contain a comparable complete common cohort`);
	}
	const perVariant = target.sample_ids.length * (target.repetitions ?? 1);
	if (
		value.variant_count !== target.benchmark_variants.length ||
		value.union_sample_count !== target.sample_ids.length ||
		value.common_sample_count !== target.sample_ids.length ||
		value.union_measurement_count !== perVariant ||
		value.common_measurement_count !== perVariant
	) {
		fail(`${label} cohort counts do not match the committed target`);
	}
	if (!Array.isArray(value.cohorts) || value.cohorts.length !== diagnostics.length) {
		fail(`${label}.cohorts must contain every target variant`);
	}
	for (const [index, cohort] of value.cohorts.entries()) {
		const prefix = `${label}.cohorts[${index}]`;
		assertClosed(
			cohort,
			new Set([
				'provider',
				'model',
				'backend',
				'observed_sample_count',
				'observed_measurement_count',
				'not_common_sample_count',
				'missing_from_union_sample_count',
				'not_common_measurement_count',
				'missing_from_union_measurement_count',
			]),
			prefix,
		);
		if (
			cohort.observed_sample_count !== target.sample_ids.length ||
			cohort.observed_measurement_count !== perVariant ||
			cohort.not_common_sample_count !== 0 ||
			cohort.missing_from_union_sample_count !== 0 ||
			cohort.not_common_measurement_count !== 0 ||
			cohort.missing_from_union_measurement_count !== 0
		) {
			fail(`${prefix} is not a complete common cohort`);
		}
	}
	assertObject(value.groups, `${label}.groups`);
	assertClosed(
		value.groups,
		new Set([
			'variant',
			'dataset_variant',
			'language_variant',
			'scenario_variant',
			'noise_condition_variant',
			'language_noise_variant',
		]),
		`${label}.groups`,
	);
	const specs = [
		['variant', []],
		['dataset_variant', ['dataset']],
		['language_variant', ['language']],
		['scenario_variant', ['scenario']],
		['noise_condition_variant', ['noise_condition']],
		['language_noise_variant', ['language', 'noise_condition']],
	];
	for (const [name, dimensions] of specs) {
		const rows = value.groups[name];
		if (!Array.isArray(rows) || rows.length === 0 || rows.length > 8192) {
			fail(`${label}.groups.${name} must be a bounded non-empty array`);
		}
		for (const [index, row] of rows.entries()) {
			const prefix = `${label}.groups.${name}[${index}]`;
			assertClosed(
				row,
				new Set(['provider', 'model', 'backend', ...dimensions, 'summary']),
				prefix,
			);
			for (const field of ['provider', 'model', 'backend', ...dimensions]) {
				assertString(row[field], `${prefix}.${field}`);
			}
			validateSummary(row.summary, `${prefix}.summary`);
		}
	}
	if (totalMeasurements !== target.benchmark_variants.length * perVariant) {
		fail(`${label} total measurement binding is inconsistent`);
	}
}

function validateAggregate(document, suite, target) {
	const label = `${suite}.aggregate`;
	assertClosed(document, AGGREGATE_FIELDS, label);
	if (document.schema_version !== 10) fail(`${label}.schema_version must be 10`);
	const generatedAt = Date.parse(document.generated_at);
	if (
		!Number.isFinite(generatedAt) ||
		new Date(generatedAt).toISOString() !== document.generated_at
	) {
		fail(`${label}.generated_at must be a canonical timestamp`);
	}
	for (const field of ['corpus_id', 'wer_scorer'])
		assertString(document[field], `${label}.${field}`);
	assertSha256(document.corpus_fingerprint, `${label}.corpus_fingerprint`);
	if (document.reference_protocol_id !== REFERENCE_PROTOCOL_ID) {
		fail(`${label}.reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`);
	}
	if (document.operating_system !== 'macos' || document.architecture !== 'aarch64') {
		fail(`${label} must come from macOS on arm64`);
	}
	validateHardwareProfile(document.hardware_profile, `${label}.hardware_profile`);
	if (!/^cpu=Apple(?: |;)/.test(document.hardware_profile)) {
		fail(`${label}.hardware_profile must identify Apple hardware`);
	}
	validateRevisionCommon(
		document.evaluator_revision_common,
		`${label}.evaluator_revision_common`,
		false,
	);

	const backends = new Set(target.benchmark_variants.map((variant) => variant.backend));
	exactKeys(document.accelerators, backends, `${label}.accelerators`, (value, field) =>
		assertString(value, field),
	);
	exactKeys(
		document.benchmark_executables,
		backends,
		`${label}.benchmark_executables`,
		(value, field) => assertSha256(value, field),
	);
	exactKeys(
		document.evaluator_revisions,
		backends,
		`${label}.evaluator_revisions`,
		(value, field) => {
			assertClosed(value, new Set(['evaluator_revision', 'evaluator_revision_sha256']), field);
			validateRevisionCommon(value.evaluator_revision, `${field}.evaluator_revision`, true);
			assertSha256(value.evaluator_revision_sha256, `${field}.evaluator_revision_sha256`);
			let computedDigest;
			try {
				computedDigest = evaluatorRevisionSha256(value.evaluator_revision);
			} catch (error) {
				fail(
					`${field}.evaluator_revision is invalid: ` +
						`${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (value.evaluator_revision_sha256 !== computedDigest) {
				fail(`${field}.evaluator_revision_sha256 does not match its embedded evaluator revision`);
			}
			const revisionCommon = { ...value.evaluator_revision };
			delete revisionCommon.cargo_features;
			assertSame(
				revisionCommon,
				document.evaluator_revision_common,
				`${field}.evaluator_revision common fields`,
			);
		},
	);
	const artifacts = new Set(target.benchmark_variants.map(artifactKey));
	exactKeys(document.model_artifacts, artifacts, `${label}.model_artifacts`, (value, field) =>
		assertSha256(value, field),
	);
	assertClosed(
		document.thresholds,
		new Set(['max_wer_percent', 'max_hallucinated_words']),
		`${label}.thresholds`,
	);
	assertFinite(document.thresholds.max_wer_percent, `${label}.thresholds.max_wer_percent`);
	assertInteger(
		document.thresholds.max_hallucinated_words,
		`${label}.thresholds.max_hallucinated_words`,
	);

	const repetitions = target.repetitions ?? 1;
	const perVariant = target.sample_ids.length * repetitions;
	const totalMeasurements = perVariant * target.benchmark_variants.length;
	for (const field of ['source_report_count', 'measurement_result_count']) {
		if (document[field] !== totalMeasurements)
			fail(`${label}.${field} must be ${totalMeasurements}`);
	}
	if (document.distinct_sample_count !== target.sample_ids.length) {
		fail(`${label}.distinct_sample_count must be ${target.sample_ids.length}`);
	}
	assertClosed(
		document.input_bindings,
		new Set(['standalone_schema_10', 'task_bound_schema_11']),
		`${label}.input_bindings`,
	);
	for (const binding of ['standalone_schema_10', 'task_bound_schema_11']) {
		assertClosed(
			document.input_bindings[binding],
			new Set(['report_count', 'measurement_result_count']),
			`${label}.input_bindings.${binding}`,
		);
	}
	if (
		document.input_bindings.standalone_schema_10.report_count !== 0 ||
		document.input_bindings.standalone_schema_10.measurement_result_count !== 0 ||
		document.input_bindings.task_bound_schema_11.report_count !== totalMeasurements ||
		document.input_bindings.task_bound_schema_11.measurement_result_count !== totalMeasurements
	) {
		fail(`${label} must contain only schema-11 task-bound reports for every planned task`);
	}

	assertClosed(document.diagnostics, new Set(['variants']), `${label}.diagnostics`);
	if (
		!Array.isArray(document.diagnostics.variants) ||
		document.diagnostics.variants.length !== target.benchmark_variants.length
	) {
		fail(`${label}.diagnostics.variants must contain every target variant`);
	}
	const seen = new Set();
	for (const [index, diagnostic] of document.diagnostics.variants.entries()) {
		validateVariantDiagnostic(
			diagnostic,
			`${label}.diagnostics.variants[${index}]`,
			target,
			perVariant,
		);
		const key = variantKey(diagnostic);
		if (seen.has(key)) fail(`${label}.diagnostics.variants duplicates '${key}'`);
		seen.add(key);
	}
	for (const variant of target.benchmark_variants) {
		if (!seen.has(variantKey(variant)))
			fail(`${label} is missing variant '${variantKey(variant)}'`);
	}
	validateComparison(
		document.comparison,
		`${label}.comparison`,
		document.diagnostics.variants,
		target,
		totalMeasurements,
	);
	return { totalMeasurements, perVariant, backends };
}

function validateCoverage(document, suite, target, aggregate) {
	const label = `${suite}.coverage`;
	assertClosed(document, COVERAGE_FIELDS, label);
	if (document.schema_version !== 11) fail(`${label}.schema_version must be 11`);
	if (document.target_id !== target.target_id)
		fail(`${label}.target_id does not match the committed target`);
	if (document.coverage_mode !== 'explicit-samples')
		fail(`${label}.coverage_mode must be explicit-samples`);
	if (document.repetitions !== (target.repetitions ?? 1)) fail(`${label}.repetitions is incorrect`);
	for (const field of ['corpus_id', 'corpus_fingerprint', 'reference_protocol_id', 'wer_scorer']) {
		if (document[field] !== aggregate[field])
			fail(`${label}.${field} must match ${suite}.aggregate`);
	}
	assertSame(document.model_artifacts, aggregate.model_artifacts, `${label}.model_artifacts`);
	const backends = new Set(target.benchmark_variants.map((variant) => variant.backend));
	exactKeys(
		document.evaluator_revision_sha256_by_backend,
		backends,
		`${label}.evaluator_revision_sha256_by_backend`,
		(value, field, backend) => {
			assertSha256(value, field);
			if (value !== aggregate.evaluator_revisions[backend].evaluator_revision_sha256) {
				fail(`${field} must match the aggregate evaluator revision`);
			}
		},
	);
	exactKeys(
		document.benchmark_executable_sha256_by_backend,
		backends,
		`${label}.benchmark_executable_sha256_by_backend`,
		(value, field, backend) => {
			assertSha256(value, field);
			if (value !== aggregate.benchmark_executables[backend]) {
				fail(`${field} must match the aggregate executable`);
			}
		},
	);
	if (
		document.minimum_distinct_sessions_per_cell !== null ||
		document.eligible_samples !== target.sample_ids.length ||
		document.participant_meeting_samples !== 0 ||
		document.participant_meeting_sessions !== 0
	) {
		fail(`${label} public explicit-sample counts are inconsistent`);
	}
	assertClosed(
		document.corpus,
		new Set(['unit_kind', 'covered_cells', 'required_cells', 'counts', 'missing_cells']),
		`${label}.corpus`,
	);
	if (
		document.corpus.unit_kind !== 'sample' ||
		document.corpus.covered_cells !== target.sample_ids.length ||
		document.corpus.required_cells !== target.sample_ids.length ||
		!Array.isArray(document.corpus.missing_cells) ||
		document.corpus.missing_cells.length !== 0
	) {
		fail(`${label}.corpus must completely cover the committed sample set`);
	}
	exactKeys(document.corpus.counts, target.sample_ids, `${label}.corpus.counts`, (value, field) => {
		if (value !== 1) fail(`${field} must be 1`);
	});

	const measurementKeys = expectedMeasurementKeys(target);
	const totalMeasurements = measurementKeys.length;
	assertClosed(
		document.measurements,
		new Set([
			'unit_kind',
			'reports',
			'covered_cells',
			'required_cells',
			'counts',
			'compatible_counts',
			'hardware_cohorts',
			'hardware_split_cells',
			'missing_cells',
			'matrix_hardware_cohorts',
			'complete_matrix_hardware_cohorts',
		]),
		`${label}.measurements`,
	);
	if (
		document.measurements.unit_kind !== 'sample' ||
		document.measurements.reports !== totalMeasurements ||
		document.measurements.covered_cells !== totalMeasurements ||
		document.measurements.required_cells !== totalMeasurements ||
		document.measurements.complete_matrix_hardware_cohorts !== 1 ||
		!Array.isArray(document.measurements.hardware_split_cells) ||
		document.measurements.hardware_split_cells.length !== 0 ||
		!Array.isArray(document.measurements.missing_cells) ||
		document.measurements.missing_cells.length !== 0 ||
		document.complete !== true
	) {
		fail(`${label}.measurements must contain one complete compatible hardware cohort`);
	}
	for (const field of ['counts', 'compatible_counts']) {
		exactKeys(
			document.measurements[field],
			measurementKeys,
			`${label}.measurements.${field}`,
			(value, item) => {
				if (value !== 1) fail(`${item} must be 1`);
			},
		);
	}
	exactKeys(
		document.measurements.hardware_cohorts,
		measurementKeys,
		`${label}.measurements.hardware_cohorts`,
		(value, field, key) => {
			if (!Array.isArray(value) || value.length !== 1) fail(`${field} must contain one cohort`);
			const cohort = value[0];
			assertClosed(
				cohort,
				new Set([
					'operating_system',
					'architecture',
					'hardware_profile',
					'accelerator',
					'distinct_units',
				]),
				`${field}[0]`,
			);
			const variant = target.benchmark_variants.find((candidate) =>
				key.includes(` / ${candidate.provider} / ${candidate.model} / ${candidate.backend}`),
			);
			if (
				!variant ||
				cohort.operating_system !== aggregate.operating_system ||
				cohort.architecture !== aggregate.architecture ||
				cohort.hardware_profile !== aggregate.hardware_profile ||
				cohort.accelerator !== aggregate.accelerators[variant.backend] ||
				cohort.distinct_units !== 1
			) {
				fail(`${field}[0] does not match the aggregate hardware cohort`);
			}
		},
	);
	if (
		!Array.isArray(document.measurements.matrix_hardware_cohorts) ||
		document.measurements.matrix_hardware_cohorts.length !== 1
	) {
		fail(`${label}.measurements.matrix_hardware_cohorts must contain exactly one cohort`);
	}
	const matrix = document.measurements.matrix_hardware_cohorts[0];
	assertClosed(
		matrix,
		new Set([
			'operating_system',
			'architecture',
			'hardware_profile',
			'accelerators',
			'covered_cells',
			'required_cells',
			'counts',
			'missing_cells',
		]),
		`${label}.measurements.matrix_hardware_cohorts[0]`,
	);
	if (
		matrix.operating_system !== aggregate.operating_system ||
		matrix.architecture !== aggregate.architecture ||
		matrix.hardware_profile !== aggregate.hardware_profile ||
		matrix.covered_cells !== totalMeasurements ||
		matrix.required_cells !== totalMeasurements ||
		!Array.isArray(matrix.missing_cells) ||
		matrix.missing_cells.length !== 0
	) {
		fail(`${label} matrix cohort is incomplete or hardware-mismatched`);
	}
	assertSame(matrix.accelerators, aggregate.accelerators, `${label} matrix accelerators`);
	exactKeys(matrix.counts, measurementKeys, `${label} matrix counts`, (value, field) => {
		if (value !== 1) fail(`${field} must be 1`);
	});
	return matrix;
}

function loadSuiteEvidence(input, suite, target) {
	assertClosed(input, new Set(['aggregate', 'coverage']), suite);
	validateAggregate(input.aggregate, suite, target);
	const cohort = validateCoverage(input.coverage, suite, target, input.aggregate);
	return { ...input, cohort };
}

function diagnosticMap(aggregate) {
	return new Map(aggregate.diagnostics.variants.map((variant) => [variantKey(variant), variant]));
}

function worstLanguageNoiseSlice(diagnostic) {
	return diagnostic.groups.language_noise
		.map((row) => ({
			language: row.language,
			noise_condition: row.noise_condition,
			macro_wer_percent: row.summary.macro_wer_percent,
		}))
		.sort(
			(left, right) =>
				right.macro_wer_percent - left.macro_wer_percent ||
				left.language.localeCompare(right.language) ||
				left.noise_condition.localeCompare(right.noise_condition),
		)[0];
}

function alignedCriticalSliceImprovement(full, quantized) {
	const sliceKey = (row) => `${row.language}\0${row.noise_condition}`;
	const fullSlices = new Map(full.groups.language_noise.map((row) => [sliceKey(row), row]));
	const quantizedSlices = new Map(
		quantized.groups.language_noise.map((row) => [sliceKey(row), row]),
	);
	if (
		fullSlices.size !== quantizedSlices.size ||
		[...fullSlices.keys()].some((key) => !quantizedSlices.has(key))
	) {
		fail(
			`catalog retention variants '${variantKey(full)}' and '${variantKey(quantized)}' ` +
				'must contain identical language/noise slices',
		);
	}
	return [...fullSlices.entries()]
		.map(([key, fullRow]) => {
			const quantizedRow = quantizedSlices.get(key);
			return {
				language: fullRow.language,
				noise_condition: fullRow.noise_condition,
				full_precision_macro_wer_percent: fullRow.summary.macro_wer_percent,
				quantized_macro_wer_percent: quantizedRow.summary.macro_wer_percent,
				improvement_points:
					quantizedRow.summary.macro_wer_percent - fullRow.summary.macro_wer_percent,
			};
		})
		.sort(
			(left, right) =>
				right.improvement_points - left.improvement_points ||
				left.language.localeCompare(right.language) ||
				left.noise_condition.localeCompare(right.noise_condition),
		)[0];
}

function downloadBytesMap() {
	return new Map(
		[...POLICY_MODELS, ...CATALOG_AUDIT_MODELS].map((model) => [
			`${model.provider}/${model.model}`,
			model.downloadBytes,
		]),
	);
}

function candidateMetrics(automatic, performance, target) {
	const quality = diagnosticMap(automatic.aggregate);
	const speed = diagnosticMap(performance.aggregate);
	const sizes = downloadBytesMap();
	return target.benchmark_variants.map((variant) => {
		const key = variantKey(variant);
		const qualityDiagnostic = quality.get(key);
		const performanceDiagnostic = speed.get(key);
		if (!qualityDiagnostic || !performanceDiagnostic) fail(`missing evidence for '${key}'`);
		const downloadBytes = sizes.get(artifactKey(variant));
		if (!Number.isSafeInteger(downloadBytes) || downloadBytes <= 0) {
			fail(`known download bytes are missing for '${artifactKey(variant)}'`);
		}
		return {
			provider: variant.provider,
			model: variant.model,
			backend: variant.backend,
			model_artifact_sha256: automatic.aggregate.model_artifacts[artifactKey(variant)],
			known_download_bytes: downloadBytes,
			macro_wer_percent: qualityDiagnostic.groups.overall.macro_wer_percent,
			worst_language_noise_slice: worstLanguageNoiseSlice(qualityDiagnostic),
			p95_inference_rtf: performanceDiagnostic.groups.overall.p95_inference_rtf,
			peak_rss_mb: performanceDiagnostic.groups.overall.max_peak_rss_mb,
		};
	});
}

function speedDifferenceFromFastest(candidate, fastest) {
	if (fastest === 0) return candidate.p95_inference_rtf === 0 ? 0 : Infinity;
	return (candidate.p95_inference_rtf - fastest) / fastest;
}

function selectCandidate(candidates) {
	const eligible = candidates.filter((candidate) => candidate.eligible);
	if (eligible.length === 0)
		return { status: 'no-eligible-candidate', selected_candidate: null, tie_break: null };
	const smallestDownload = Math.min(...eligible.map((candidate) => candidate.known_download_bytes));
	const smallest = eligible.filter(
		(candidate) => candidate.known_download_bytes === smallestDownload,
	);
	const fastest = Math.min(...smallest.map((candidate) => candidate.p95_inference_rtf));
	const speedBand = smallest.filter(
		(candidate) => speedDifferenceFromFastest(candidate, fastest) < 0.1,
	);
	const selected = [...speedBand].sort(
		(left, right) =>
			left.peak_rss_mb - right.peak_rss_mb ||
			left.known_download_bytes - right.known_download_bytes ||
			compareVariant(left, right),
	)[0];
	return {
		status: 'qualified',
		selected_candidate: {
			provider: selected.provider,
			model: selected.model,
			backend: selected.backend,
			model_artifact_sha256: selected.model_artifact_sha256,
		},
		tie_break: {
			smallest_eligible_download_bytes: smallestDownload,
			fastest_p95_inference_rtf_at_smallest_size: fastest,
			strict_speed_similarity_fraction: 0.1,
			resource_preference_candidates: speedBand.map(variantKey).sort(),
			order: ['peak_rss_mb', 'known_download_bytes', 'variant_identity'],
		},
	};
}

const RETENTION_PAIRS = Object.freeze([
	['tiny', 'tiny-q5_1'],
	['base', 'base-q5_1'],
	['small', 'small-q5_1'],
	['medium', 'medium-q5_0'],
	['large-v3-turbo', 'large-v3-turbo-q5_0'],
	['large-v3', 'large-v3-q5_0'],
]);

function evaluateCatalogRetention(catalog, performance) {
	if (!catalog) return { status: 'not-evaluated', decisions: [] };
	const catalogMetrics = diagnosticMap(catalog.aggregate);
	const performanceMetrics = diagnosticMap(performance.aggregate);
	const find = (model, maps) => {
		const matches = maps.flatMap((map) =>
			[...map.values()].filter((value) => value.provider === 'whisper' && value.model === model),
		);
		if (matches.length === 0) fail(`catalog retention evidence is missing whisper/${model}`);
		return [...matches].sort((left, right) => left.backend.localeCompare(right.backend))[0];
	};
	const decisions = RETENTION_PAIRS.map(([fullModel, quantizedModel]) => {
		const full = find(fullModel, [catalogMetrics]);
		const quantized = find(quantizedModel, [catalogMetrics, performanceMetrics]);
		const macroImprovement =
			quantized.groups.overall.macro_wer_percent - full.groups.overall.macro_wer_percent;
		const criticalSlice = alignedCriticalSliceImprovement(full, quantized);
		return {
			full_precision_variant: {
				provider: full.provider,
				model: full.model,
				backend: full.backend,
			},
			quantized_peer: {
				provider: quantized.provider,
				model: quantized.model,
				backend: quantized.backend,
			},
			macro_wer_improvement_points: macroImprovement,
			critical_slice: criticalSlice,
			critical_slice_improvement_points: criticalSlice.improvement_points,
			retain_new_download_visibility:
				macroImprovement >= 1 || criticalSlice.improvement_points >= 3,
		};
	});
	return { status: 'evaluated', decisions };
}

function bindSuiteProvenance(name, evidence, automatic) {
	for (const field of [
		'corpus_id',
		'corpus_fingerprint',
		'reference_protocol_id',
		'wer_scorer',
		'operating_system',
		'architecture',
		'hardware_profile',
	]) {
		if (evidence.aggregate[field] !== automatic.aggregate[field]) {
			fail(`${name}.aggregate.${field} must match automatic_policy.aggregate.${field}`);
		}
	}
	assertSame(
		evidence.aggregate.evaluator_revision_common,
		automatic.aggregate.evaluator_revision_common,
		`${name}.aggregate.evaluator_revision_common`,
	);
	assertSame(
		evidence.aggregate.thresholds,
		automatic.aggregate.thresholds,
		`${name}.aggregate.thresholds`,
	);
	for (const [backend, accelerator] of Object.entries(evidence.aggregate.accelerators)) {
		if (!Object.hasOwn(automatic.aggregate.accelerators, backend)) continue;
		if (automatic.aggregate.accelerators[backend] !== accelerator) {
			fail(`${name}.aggregate.accelerators.${backend} must match automatic-policy evidence`);
		}
		assertSame(
			evidence.aggregate.evaluator_revisions[backend],
			automatic.aggregate.evaluator_revisions[backend],
			`${name}.aggregate evaluator revision for '${backend}'`,
		);
		if (
			evidence.aggregate.benchmark_executables[backend] !==
			automatic.aggregate.benchmark_executables[backend]
		) {
			fail(
				`${name}.aggregate benchmark executable for '${backend}' must match automatic-policy evidence`,
			);
		}
	}
	for (const [artifact, digest] of Object.entries(evidence.aggregate.model_artifacts)) {
		if (
			Object.hasOwn(automatic.aggregate.model_artifacts, artifact) &&
			automatic.aggregate.model_artifacts[artifact] !== digest
		) {
			fail(`${name}.aggregate artifact '${artifact}' must match automatic-policy evidence`);
		}
	}
}

export function evaluatePublicCorpusQualification(input) {
	assertClosed(
		input,
		new Set(Object.keys(SUITES)),
		'qualification input',
		new Set(['catalog_audit']),
	);
	const targets = loadPublicQualificationTargets();
	const automatic = loadSuiteEvidence(
		input.automatic_policy,
		'automatic_policy',
		targets.automatic_policy,
	);
	const performance = loadSuiteEvidence(input.performance, 'performance', targets.performance);
	const catalog = input.catalog_audit
		? loadSuiteEvidence(input.catalog_audit, 'catalog_audit', targets.catalog_audit)
		: null;
	for (const [name, evidence] of [
		['performance', performance],
		...(catalog ? [['catalog_audit', catalog]] : []),
	]) {
		bindSuiteProvenance(name, evidence, automatic);
	}
	for (const variant of targets.automatic_policy.benchmark_variants) {
		const key = artifactKey(variant);
		if (performance.aggregate.model_artifacts[key] !== automatic.aggregate.model_artifacts[key]) {
			fail(`performance artifact '${key}' must match automatic-policy evidence`);
		}
	}

	const rawCandidates = candidateMetrics(automatic, performance, targets.automatic_policy);
	const bestMacro = Math.min(...rawCandidates.map((candidate) => candidate.macro_wer_percent));
	const bestWorst = Math.min(
		...rawCandidates.map((candidate) => candidate.worst_language_noise_slice.macro_wer_percent),
	);
	const candidates = rawCandidates.map((candidate) => {
		const failures = [];
		if (!(candidate.p95_inference_rtf < 1)) failures.push('p95-inference-rtf-not-below-1');
		if (candidate.macro_wer_percent > bestMacro + 2)
			failures.push('macro-wer-more-than-2-points-from-best');
		if (candidate.worst_language_noise_slice.macro_wer_percent > bestWorst + 5) {
			failures.push('worst-language-noise-slice-more-than-5-points-from-best');
		}
		return {
			...candidate,
			macro_wer_delta_from_best_points: candidate.macro_wer_percent - bestMacro,
			worst_slice_delta_from_best_points:
				candidate.worst_language_noise_slice.macro_wer_percent - bestWorst,
			eligible: failures.length === 0,
			ineligibility_reasons: failures,
		};
	});
	const decision = selectCandidate(candidates);
	return {
		schema_version: PUBLIC_QUALIFICATION_SCHEMA_VERSION,
		policy_id: PUBLIC_QUALIFICATION_POLICY_ID,
		corpus_id: automatic.aggregate.corpus_id,
		corpus_fingerprint: automatic.aggregate.corpus_fingerprint,
		hardware_cohort: {
			operating_system: automatic.aggregate.operating_system,
			architecture: automatic.aggregate.architecture,
			hardware_profile: automatic.aggregate.hardware_profile,
		},
		thresholds: {
			maximum_p95_inference_rtf_exclusive: 1,
			maximum_macro_wer_delta_points: 2,
			maximum_worst_slice_delta_points: 5,
			strict_speed_similarity_fraction: 0.1,
			full_precision_macro_improvement_points: 1,
			full_precision_worst_slice_improvement_points: 3,
		},
		phase_boundary: {
			phase: 'phase-1-transcription-only',
			may_update_tiers: ['high', 'ultra'],
			unchanged_tiers: ['low', 'medium'],
			translation_policy: 'unchanged-until-phase-2',
			catalog_audit_only_models: ['tiny-q5_1'],
			production_configuration_mutated: false,
		},
		evidence: {
			automatic_policy: {
				target_id: targets.automatic_policy.target_id,
				measurement_tasks: automatic.aggregate.measurement_result_count,
			},
			performance: {
				target_id: targets.performance.target_id,
				measurement_tasks: performance.aggregate.measurement_result_count,
			},
			catalog_audit:
				catalog === null
					? null
					: {
							target_id: targets.catalog_audit.target_id,
							measurement_tasks: catalog.aggregate.measurement_result_count,
						},
		},
		best_observed: {
			macro_wer_percent: bestMacro,
			worst_language_noise_slice_macro_wer_percent: bestWorst,
		},
		candidates: candidates.sort(compareVariant),
		decision,
		catalog_retention: evaluateCatalogRetention(catalog, performance),
	};
}

export function parseQualificationArgs(args) {
	const options = {};
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (!/^--(?:automatic|performance|catalog)-(?:aggregate|coverage)$/.test(option)) {
			fail(`unknown option: ${option}`);
		}
		if (Object.hasOwn(options, option)) fail(`${option} may only be provided once`);
		const value = args[index + 1];
		if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
			fail(`${option} requires a file path`);
		}
		options[option] = value;
		index += 1;
	}
	for (const suite of ['automatic', 'performance']) {
		for (const kind of ['aggregate', 'coverage']) {
			if (!options[`--${suite}-${kind}`]) fail(`--${suite}-${kind} is required`);
		}
	}
	const hasCatalogAggregate = Boolean(options['--catalog-aggregate']);
	const hasCatalogCoverage = Boolean(options['--catalog-coverage']);
	if (hasCatalogAggregate !== hasCatalogCoverage) {
		fail('--catalog-aggregate and --catalog-coverage must be provided together');
	}
	return options;
}

export function main(args = process.argv.slice(2)) {
	const options = parseQualificationArgs(args);
	const suite = (name) => ({
		aggregate: readJson(path.resolve(options[`--${name}-aggregate`]), `${name} aggregate`),
		coverage: readJson(path.resolve(options[`--${name}-coverage`]), `${name} coverage`),
	});
	const input = {
		automatic_policy: suite('automatic'),
		performance: suite('performance'),
		...(options['--catalog-aggregate'] ? { catalog_audit: suite('catalog') } : {}),
	};
	process.stdout.write(`${JSON.stringify(evaluatePublicCorpusQualification(input), null, 2)}\n`);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
