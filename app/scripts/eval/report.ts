#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	assertBenchmarkPlatform,
	benchmarkDefinitionForReportedBackend,
	evaluatorPlatformForTargetTriple,
	validateHardwareProfile,
} from './benchmark-executable.ts';
import { writeCorpusBoundFiles } from './corpus-result.ts';
import {
	corpusFingerprint as calculateCorpusFingerprint,
	isPublicDatasetId,
	isReferenceProtocolId,
	loadCorpus,
	REFERENCE_PROTOCOL_IDS,
} from './corpus.ts';
import { evaluatorRevisionSha256, validateEvaluatorRevision } from './evaluator-revision.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const STANDALONE_RUN_REPORT_SCHEMA_VERSION = 10;
export const CAMPAIGN_RUN_REPORT_SCHEMA_VERSION = 11;
export const AGGREGATE_REPORT_SCHEMA_VERSION = 12;
export const AGGREGATION_UNIT_POLICY = 'session-id-or-singleton-sample-v1';
// The VAD flush pads one final 16 kHz processing block, so model input can
// legitimately exceed decoded source duration by less than one 30 ms block.
const MAX_INFERENCE_AUDIO_OVERRUN_SECONDS = 0.03;
const RUN_REPORT_REQUIRED_FIELDS = new Set([
	'schema_version',
	'corpus_id',
	'corpus_fingerprint',
	'reference_protocol_id',
	'started_at',
	'completed_at',
	'wer_scorer',
	'evaluator_revision',
	'evaluator_revision_sha256',
	'benchmark_executable_sha256',
	'provider',
	'model',
	'model_artifact_sha256',
	'thresholds',
	'passed',
	'results',
]);
const RUN_REPORT_FIELDS = new Set([
	...RUN_REPORT_REQUIRED_FIELDS,
	'benchmark_task_id',
	'repeat_index',
]);
const THRESHOLD_FIELDS = new Set(['max_wer_percent', 'max_hallucinated_words']);
const RESULT_REQUIRED_FIELDS = new Set([
	'sample_id',
	'language',
	'noise_condition',
	'scenario',
	'speakers',
	'provenance_basis',
	'reference_words',
	'word_errors',
	'wer_percent',
	'hallucinated_words',
	'passed',
	'metrics',
]);
const RESULT_FIELDS = new Set([...RESULT_REQUIRED_FIELDS, 'dataset']);
const METRICS_FIELDS = new Set([
	'schema_version',
	'provider',
	'model',
	'backend',
	'operating_system',
	'architecture',
	'hardware_profile',
	'accelerator',
	'benchmark_executable_sha256',
	'audio_sha256',
	'audio_duration_seconds',
	'decode_seconds',
	'vad_seconds',
	'model_download_seconds',
	'model_load_seconds',
	'inference_seconds',
	'inference_rtf',
	'inference_audio_seconds',
	'model_inference_rtf',
	'measured_total_seconds',
	'baseline_rss_mb',
	'peak_rss_mb',
	'peak_rss_delta_mb',
]);
const NUMERIC_METRICS_FIELDS = [
	'audio_duration_seconds',
	'decode_seconds',
	'vad_seconds',
	'model_download_seconds',
	'model_load_seconds',
	'inference_seconds',
	'inference_rtf',
	'inference_audio_seconds',
	'measured_total_seconds',
	'baseline_rss_mb',
	'peak_rss_mb',
	'peak_rss_delta_mb',
];
const CORPUS_MANIFEST_FIELDS = [
	'schema_version',
	'corpus_id',
	'reference_protocol_id',
	'description',
	'distribution',
	'source_catalog_sha256',
	'preparation',
	'samples',
];

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function corpusManifestProjection(corpus) {
	return Object.fromEntries(
		CORPUS_MANIFEST_FIELDS.filter((field) => Object.hasOwn(corpus, field)).map((field) => {
			if (field !== 'samples' || !Array.isArray(corpus.samples)) return [field, corpus[field]];
			return [
				field,
				corpus.samples.map((sample) => {
					if (!isObject(sample)) return sample;
					return Object.fromEntries(
						Object.entries(sample).filter(
							([key]) => key !== 'audio_file' && key !== 'reference_file',
						),
					);
				}),
			];
		}),
	);
}

function aggregationCorpusSamples(corpus) {
	if (!isObject(corpus)) {
		throw new Error('a loaded corpus manifest is required for aggregate reporting');
	}
	if (!Array.isArray(corpus.samples)) {
		throw new Error('aggregate corpus.samples must be an array');
	}
	if (!SHA256_PATTERN.test(corpus.corpus_fingerprint ?? '')) {
		throw new Error('aggregate corpus.corpus_fingerprint must be a lowercase SHA-256 digest');
	}
	const expectedFingerprint = calculateCorpusFingerprint(corpusManifestProjection(corpus));
	if (corpus.corpus_fingerprint !== expectedFingerprint) {
		throw new Error('aggregate corpus fingerprint does not match its manifest contents');
	}
	const samples = new Map();
	for (const [index, sample] of corpus.samples.entries()) {
		if (!isObject(sample) || typeof sample.id !== 'string' || sample.id.length === 0) {
			throw new Error(`aggregate corpus.samples[${index}].id must be a non-empty string`);
		}
		if (samples.has(sample.id)) {
			throw new Error(`aggregate corpus sample id '${sample.id}' is duplicated`);
		}
		if (
			sample.session_id !== undefined &&
			!/^session-[a-z0-9][a-z0-9-]*$/.test(sample.session_id)
		) {
			throw new Error(
				`aggregate corpus sample '${sample.id}'.session_id must be an opaque session-* identifier`,
			);
		}
		if (sample.scenario === 'meeting' && sample.session_id === undefined) {
			throw new Error(
				`aggregate corpus sample '${sample.id}'.session_id is required for meeting recordings`,
			);
		}
		samples.set(sample.id, sample);
	}
	return samples;
}

function requireString(value, field, errors) {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value !== value.trim() ||
		value.includes('\0') ||
		/[\r\n]/.test(value)
	) {
		errors.push(`${field} must be a non-empty single-line string without surrounding whitespace`);
	}
}

function requireVersionedIdentifier(value, field, errors) {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]*-v[1-9][0-9]*$/.test(value)) {
		errors.push(`${field} must be a lowercase versioned identifier ending in -v<number>`);
	}
}

function rejectUnknownAndMissingFields(
	value,
	allowedFields,
	field,
	errors,
	requiredFields = allowedFields,
) {
	if (!isObject(value)) return;
	for (const key of Object.keys(value)) {
		if (!allowedFields.has(key)) errors.push(`${field}.${key} is not allowed`);
	}
	for (const key of requiredFields) {
		if (!Object.hasOwn(value, key)) errors.push(`${field}.${key} is required`);
	}
}

function isCanonicalTimestamp(value) {
	if (typeof value !== 'string') return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function approximatelyEqual(left, right) {
	const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-6);
	return Math.abs(left - right) <= tolerance;
}

function equalStringArrays(left, right) {
	return (
		Array.isArray(left) &&
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function requireSha256(value, field, errors) {
	if (!SHA256_PATTERN.test(value ?? '')) {
		errors.push(`${field} must be a lowercase SHA-256 digest`);
	}
}

function sensitiveReportKeyPaths(value, root = 'report') {
	const paths = [];
	const visited = new WeakSet();
	const visit = (current, currentPath) => {
		if (current === null || typeof current !== 'object' || visited.has(current)) return;
		visited.add(current);
		if (Array.isArray(current)) {
			for (const [index, item] of current.entries()) visit(item, `${currentPath}[${index}]`);
			return;
		}
		for (const [key, item] of Object.entries(current)) {
			const path = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
				? `${currentPath}.${key}`
				: `${currentPath}[${JSON.stringify(key)}]`;
			const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
			const isPublicReferenceProtocol =
				normalized === 'referenceprotocolid' && path === `${root}.reference_protocol_id`;
			if (
				normalized.includes('transcript') ||
				normalized.includes('hypothesis') ||
				normalized.includes('consent') ||
				(normalized.startsWith('reference') &&
					normalized !== 'referencewords' &&
					!isPublicReferenceProtocol)
			) {
				paths.push(path);
			}
			visit(item, path);
		}
	};
	visit(value, root);
	return paths;
}

function evaluatorRevisionErrors(value, field) {
	return validateEvaluatorRevision(value).map((error) =>
		error.startsWith('evaluator_revision')
			? `${field}${error.slice('evaluator_revision'.length)}`
			: `${field}: ${error}`,
	);
}

export function validateBenchmarkMetrics(metrics, label = 'metrics') {
	const errors = sensitiveReportKeyPaths(metrics, label).map(
		(path) => `${path} is a forbidden sensitive metrics key`,
	);
	if (!isObject(metrics)) return [`${label} must be an object`];
	rejectUnknownAndMissingFields(metrics, METRICS_FIELDS, label, errors);
	if (metrics.schema_version !== 7) errors.push(`${label}.schema_version must be 7`);
	for (const field of [
		'provider',
		'model',
		'backend',
		'operating_system',
		'architecture',
		'hardware_profile',
		'accelerator',
	]) {
		requireString(metrics[field], `${label}.${field}`, errors);
	}
	try {
		validateHardwareProfile(metrics.hardware_profile, `${label}.hardware_profile`);
	} catch (error) {
		errors.push(error.message);
	}
	requireSha256(
		metrics.benchmark_executable_sha256,
		`${label}.benchmark_executable_sha256`,
		errors,
	);
	requireSha256(metrics.audio_sha256, `${label}.audio_sha256`, errors);
	for (const field of NUMERIC_METRICS_FIELDS) {
		if (!finiteNumber(metrics[field]) || metrics[field] < 0) {
			errors.push(`${label}.${field} must be a non-negative finite number`);
		}
	}
	const measuredPhaseSeconds = [
		'decode_seconds',
		'vad_seconds',
		'model_download_seconds',
		'model_load_seconds',
		'inference_seconds',
	].reduce(
		(sum, field) =>
			finiteNumber(metrics[field]) && metrics[field] >= 0 ? sum + metrics[field] : Number.NaN,
		0,
	);
	if (
		finiteNumber(metrics.measured_total_seconds) &&
		metrics.measured_total_seconds >= 0 &&
		finiteNumber(measuredPhaseSeconds) &&
		metrics.measured_total_seconds < measuredPhaseSeconds &&
		!approximatelyEqual(metrics.measured_total_seconds, measuredPhaseSeconds)
	) {
		errors.push(`${label}.measured_total_seconds must cover all measured phases`);
	}
	if (finiteNumber(metrics.audio_duration_seconds) && metrics.audio_duration_seconds <= 0) {
		errors.push(`${label}.audio_duration_seconds must be positive`);
	}
	if (
		finiteNumber(metrics.audio_duration_seconds) &&
		metrics.audio_duration_seconds > 0 &&
		finiteNumber(metrics.inference_audio_seconds) &&
		metrics.inference_audio_seconds - metrics.audio_duration_seconds >
			MAX_INFERENCE_AUDIO_OVERRUN_SECONDS &&
		!approximatelyEqual(
			metrics.inference_audio_seconds - metrics.audio_duration_seconds,
			MAX_INFERENCE_AUDIO_OVERRUN_SECONDS,
		)
	) {
		errors.push(`${label}.inference_audio_seconds must not materially exceed source duration`);
	}
	if (
		finiteNumber(metrics.audio_duration_seconds) &&
		metrics.audio_duration_seconds > 0 &&
		finiteNumber(metrics.inference_seconds) &&
		metrics.inference_seconds >= 0 &&
		finiteNumber(metrics.inference_rtf) &&
		metrics.inference_rtf >= 0 &&
		!approximatelyEqual(
			metrics.inference_rtf,
			metrics.inference_seconds / metrics.audio_duration_seconds,
		)
	) {
		errors.push(`${label}.inference_rtf does not match inference duration`);
	}
	if (
		metrics.model_inference_rtf !== null &&
		(!finiteNumber(metrics.model_inference_rtf) || metrics.model_inference_rtf < 0)
	) {
		errors.push(`${label}.model_inference_rtf must be null or a non-negative finite number`);
	}
	if (finiteNumber(metrics.inference_audio_seconds) && metrics.inference_audio_seconds === 0) {
		if (metrics.model_inference_rtf !== null) {
			errors.push(`${label}.model_inference_rtf must be null when no audio reached the ASR model`);
		}
		if (
			finiteNumber(metrics.inference_seconds) &&
			!approximatelyEqual(metrics.inference_seconds, 0)
		) {
			errors.push(`${label}.inference_seconds must be zero when no audio reached the ASR model`);
		}
	} else if (
		finiteNumber(metrics.inference_audio_seconds) &&
		metrics.inference_audio_seconds > 0 &&
		finiteNumber(metrics.inference_seconds) &&
		metrics.inference_seconds >= 0 &&
		finiteNumber(metrics.model_inference_rtf) &&
		metrics.model_inference_rtf >= 0 &&
		!approximatelyEqual(
			metrics.model_inference_rtf,
			metrics.inference_seconds / metrics.inference_audio_seconds,
		)
	) {
		errors.push(`${label}.model_inference_rtf does not match model-input duration`);
	}
	if (
		finiteNumber(metrics.inference_audio_seconds) &&
		metrics.inference_audio_seconds > 0 &&
		metrics.model_inference_rtf === null
	) {
		errors.push(`${label}.model_inference_rtf must be present when audio reached the ASR model`);
	}
	for (const field of ['baseline_rss_mb', 'peak_rss_mb']) {
		if (finiteNumber(metrics[field]) && metrics[field] <= 0) {
			errors.push(`${label}.${field} must be positive`);
		}
	}
	if (
		finiteNumber(metrics.baseline_rss_mb) &&
		metrics.baseline_rss_mb > 0 &&
		finiteNumber(metrics.peak_rss_mb) &&
		metrics.peak_rss_mb > 0 &&
		metrics.peak_rss_mb < metrics.baseline_rss_mb
	) {
		errors.push(`${label}.peak_rss_mb must not be below baseline RSS`);
	}
	if (
		finiteNumber(metrics.baseline_rss_mb) &&
		metrics.baseline_rss_mb > 0 &&
		finiteNumber(metrics.peak_rss_mb) &&
		metrics.peak_rss_mb > 0 &&
		finiteNumber(metrics.peak_rss_delta_mb) &&
		metrics.peak_rss_delta_mb >= 0 &&
		!approximatelyEqual(metrics.peak_rss_delta_mb, metrics.peak_rss_mb - metrics.baseline_rss_mb)
	) {
		errors.push(`${label}.peak_rss_delta_mb does not match peak minus baseline`);
	}
	return errors;
}

/**
 * Core ML consumes a backend-specific compiled encoder bundle in addition to
 * the shared GGML file. Keep its artifact binding backend-scoped while
 * preserving the historical provider/model binding for every other backend.
 */
export function modelArtifactBindingKey(provider, model, reportedBackend) {
	const baseKey = `${provider}/${model}`;
	return reportedBackend === 'coreml-metal' ? `${baseKey}/${reportedBackend}` : baseKey;
}

export function validateRunReport(report, label = 'report') {
	const errors = sensitiveReportKeyPaths(report, label).map(
		(path) => `${path} is a forbidden sensitive report key`,
	);
	if (!isObject(report)) {
		return [`${label} must be a JSON object`];
	}
	for (const key of Object.keys(report)) {
		if (!RUN_REPORT_FIELDS.has(key)) errors.push(`${label}.${key} is not allowed`);
	}
	for (const key of RUN_REPORT_REQUIRED_FIELDS) {
		if (!Object.hasOwn(report, key)) errors.push(`${label}.${key} is required`);
	}
	const standaloneReport = report.schema_version === STANDALONE_RUN_REPORT_SCHEMA_VERSION;
	const campaignReport = report.schema_version === CAMPAIGN_RUN_REPORT_SCHEMA_VERSION;
	if (!standaloneReport && !campaignReport) {
		errors.push(
			`${label}.schema_version must be ${STANDALONE_RUN_REPORT_SCHEMA_VERSION} or ` +
				`${CAMPAIGN_RUN_REPORT_SCHEMA_VERSION}`,
		);
	}
	if (standaloneReport && report.benchmark_task_id !== undefined) {
		errors.push(`${label}.benchmark_task_id is only allowed in schema-11 campaign reports`);
	}
	if (standaloneReport && report.repeat_index !== undefined && report.repeat_index !== 1) {
		errors.push(`${label}.repeat_index must be absent or 1 for schema-10 standalone reports`);
	}
	if (campaignReport) {
		if (!Object.hasOwn(report, 'benchmark_task_id')) {
			errors.push(`${label}.benchmark_task_id is required for schema-11 campaign reports`);
		}
		if (!Object.hasOwn(report, 'repeat_index')) {
			errors.push(`${label}.repeat_index is required for schema-11 campaign reports`);
		}
		requireSha256(report.benchmark_task_id, `${label}.benchmark_task_id`, errors);
	}
	if (
		report.repeat_index !== undefined &&
		(!Number.isSafeInteger(report.repeat_index) ||
			report.repeat_index < 1 ||
			report.repeat_index > 10)
	) {
		errors.push(`${label}.repeat_index must be a safe integer from 1 through 10`);
	}
	requireString(report.corpus_id, `${label}.corpus_id`, errors);
	requireSha256(report.corpus_fingerprint, `${label}.corpus_fingerprint`, errors);
	if (!isReferenceProtocolId(report.reference_protocol_id)) {
		errors.push(
			`${label}.reference_protocol_id must be one of ${REFERENCE_PROTOCOL_IDS.map((id) => `'${id}'`).join(', ')}`,
		);
	}
	if (!isCanonicalTimestamp(report.started_at)) {
		errors.push(`${label}.started_at must be a canonical ISO-8601 timestamp`);
	}
	if (!isCanonicalTimestamp(report.completed_at)) {
		errors.push(`${label}.completed_at must be a canonical ISO-8601 timestamp`);
	}
	if (
		isCanonicalTimestamp(report.started_at) &&
		isCanonicalTimestamp(report.completed_at) &&
		report.completed_at < report.started_at
	) {
		errors.push(`${label}.completed_at must not precede ${label}.started_at`);
	}
	requireVersionedIdentifier(report.wer_scorer, `${label}.wer_scorer`, errors);
	const revisionErrors = evaluatorRevisionErrors(
		report.evaluator_revision,
		`${label}.evaluator_revision`,
	);
	errors.push(...revisionErrors);
	requireSha256(report.evaluator_revision_sha256, `${label}.evaluator_revision_sha256`, errors);
	if (
		revisionErrors.length === 0 &&
		SHA256_PATTERN.test(report.evaluator_revision_sha256 ?? '') &&
		evaluatorRevisionSha256(report.evaluator_revision) !== report.evaluator_revision_sha256
	) {
		errors.push(`${label}.evaluator_revision_sha256 must match ${label}.evaluator_revision`);
	}
	let evaluatorPlatform;
	if (revisionErrors.length === 0) {
		try {
			evaluatorPlatform = evaluatorPlatformForTargetTriple(report.evaluator_revision.target_triple);
		} catch (error) {
			errors.push(`${label}.evaluator_revision.target_triple: ${error.message}`);
		}
	}
	requireSha256(report.benchmark_executable_sha256, `${label}.benchmark_executable_sha256`, errors);
	requireString(report.provider, `${label}.provider`, errors);
	requireString(report.model, `${label}.model`, errors);
	requireSha256(report.model_artifact_sha256, `${label}.model_artifact_sha256`, errors);
	if (!isObject(report.thresholds)) {
		errors.push(`${label}.thresholds must be an object`);
	} else {
		rejectUnknownAndMissingFields(
			report.thresholds,
			THRESHOLD_FIELDS,
			`${label}.thresholds`,
			errors,
		);
		for (const field of ['max_wer_percent', 'max_hallucinated_words']) {
			if (!finiteNumber(report.thresholds[field]) || report.thresholds[field] < 0) {
				errors.push(`${label}.thresholds.${field} must be a non-negative finite number`);
			}
		}
		if (!Number.isInteger(report.thresholds.max_hallucinated_words)) {
			errors.push(`${label}.thresholds.max_hallucinated_words must be an integer`);
		}
	}
	if (typeof report.passed !== 'boolean') errors.push(`${label}.passed must be boolean`);
	if (!Array.isArray(report.results) || report.results.length === 0) {
		errors.push(`${label}.results must be a non-empty array`);
		return errors;
	}
	if (campaignReport && report.results.length !== 1) {
		errors.push(`${label}.results must contain exactly one result for a schema-11 campaign report`);
	}
	let reportMetricsIdentity;
	const checkedBenchmarkBindings = new Set();
	const sampleResultIndexes = new Map();
	for (const [index, result] of report.results.entries()) {
		const prefix = `${label}.results[${index}]`;
		if (!isObject(result)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		rejectUnknownAndMissingFields(result, RESULT_FIELDS, prefix, errors, RESULT_REQUIRED_FIELDS);
		for (const field of [
			'sample_id',
			'language',
			'noise_condition',
			'scenario',
			'provenance_basis',
		]) {
			requireString(result[field], `${prefix}.${field}`, errors);
		}
		if (result.provenance_basis === 'public-license') {
			if (!Object.hasOwn(result, 'dataset')) {
				errors.push(`${prefix}.dataset is required for public-license samples`);
			} else if (!isPublicDatasetId(result.dataset)) {
				errors.push(`${prefix}.dataset must be fleurs, ami, or earnings21`);
			}
		} else if (Object.hasOwn(result, 'dataset')) {
			errors.push(`${prefix}.dataset is only allowed for public-license samples`);
		}
		if (typeof result.sample_id === 'string' && result.sample_id.length > 0) {
			const priorIndex = sampleResultIndexes.get(result.sample_id);
			if (priorIndex !== undefined) {
				errors.push(
					`${prefix}.sample_id duplicates ${label}.results[${priorIndex}].sample_id ` +
						`'${result.sample_id}'`,
				);
			} else {
				sampleResultIndexes.set(result.sample_id, index);
			}
		}
		if (!Number.isInteger(result.speakers) || result.speakers < 0) {
			errors.push(`${prefix}.speakers must be a non-negative integer`);
		}
		if (typeof result.passed !== 'boolean') errors.push(`${prefix}.passed must be boolean`);
		if (!isObject(result.metrics)) {
			errors.push(`${prefix}.metrics must be an object`);
			continue;
		}
		errors.push(...validateBenchmarkMetrics(result.metrics, `${prefix}.metrics`));
		if (result.metrics.provider !== report.provider) {
			errors.push(`${prefix}.metrics.provider must match ${label}.provider`);
		}
		if (result.metrics.model !== report.model) {
			errors.push(`${prefix}.metrics.model must match ${label}.model`);
		}
		if (typeof report.provider === 'string' && typeof result.metrics.backend === 'string') {
			const bindingKey = `${report.provider}\0${result.metrics.backend}`;
			let definition;
			try {
				definition = benchmarkDefinitionForReportedBackend(report.provider, result.metrics.backend);
			} catch (error) {
				errors.push(
					`${prefix}.metrics.backend is incompatible with ${label}.provider: ${error.message}`,
				);
			}
			if (definition && !checkedBenchmarkBindings.has(bindingKey)) {
				checkedBenchmarkBindings.add(bindingKey);
				if (
					revisionErrors.length === 0 &&
					!equalStringArrays(report.evaluator_revision.cargo_features, definition.cargoFeatures)
				) {
					errors.push(
						`${label}.evaluator_revision.cargo_features must exactly match ` +
							`${definition.provider}/${definition.reportedBackend} ` +
							`(${JSON.stringify(definition.cargoFeatures)})`,
					);
				}
				if (evaluatorPlatform) {
					try {
						assertBenchmarkPlatform(
							definition.provider,
							definition.reportedBackend,
							evaluatorPlatform.operatingSystem,
							evaluatorPlatform.architecture,
						);
					} catch (error) {
						errors.push(
							`${label}.evaluator_revision.target_triple is incompatible with ` +
								`${definition.provider}/${definition.reportedBackend}: ${error.message}`,
						);
					}
				}
			}
			if (definition) {
				const gpuBackend = ['metal', 'coreml-metal', 'cuda', 'vulkan', 'hipblas'].includes(
					definition.reportedBackend,
				);
				if (gpuBackend && result.metrics.accelerator?.toLowerCase() === 'none') {
					errors.push(`${prefix}.metrics.accelerator must identify the measured GPU`);
				}
				if (!gpuBackend && result.metrics.accelerator !== 'none') {
					errors.push(
						`${prefix}.metrics.accelerator must be 'none' for ${definition.reportedBackend}`,
					);
				}
			}
			if (evaluatorPlatform) {
				if (result.metrics.operating_system !== evaluatorPlatform.operatingSystem) {
					errors.push(
						`${prefix}.metrics.operating_system must match ` +
							`${label}.evaluator_revision.target_triple ` +
							`(${evaluatorPlatform.operatingSystem})`,
					);
				}
				if (result.metrics.architecture !== evaluatorPlatform.architecture) {
					errors.push(
						`${prefix}.metrics.architecture must match ` +
							`${label}.evaluator_revision.target_triple ` +
							`(${evaluatorPlatform.architecture})`,
					);
				}
			}
		}
		const metricsIdentity = {
			backend: result.metrics.backend,
			operating_system: result.metrics.operating_system,
			architecture: result.metrics.architecture,
			hardware_profile: result.metrics.hardware_profile,
			accelerator: result.metrics.accelerator,
		};
		if (reportMetricsIdentity === undefined) {
			reportMetricsIdentity = metricsIdentity;
		} else {
			for (const [field, expected] of Object.entries(reportMetricsIdentity)) {
				if (metricsIdentity[field] !== expected) {
					errors.push(`${prefix}.metrics.${field} must match the first result in ${label}`);
				}
			}
		}
		if (result.metrics.benchmark_executable_sha256 !== report.benchmark_executable_sha256) {
			errors.push(
				`${prefix}.metrics.benchmark_executable_sha256 must match ${label}.benchmark_executable_sha256`,
			);
		}
		const isWer = result.reference_words !== null || result.word_errors !== null;
		if (isWer) {
			if (!Number.isInteger(result.reference_words) || result.reference_words <= 0) {
				errors.push(`${prefix}.reference_words must be a positive integer for WER samples`);
			}
			if (!Number.isInteger(result.word_errors) || result.word_errors < 0) {
				errors.push(`${prefix}.word_errors must be a non-negative integer for WER samples`);
			}
			if (!finiteNumber(result.wer_percent) || result.wer_percent < 0) {
				errors.push(`${prefix}.wer_percent must be a non-negative finite number for WER samples`);
			} else if (
				Number.isInteger(result.reference_words) &&
				result.reference_words > 0 &&
				Number.isInteger(result.word_errors) &&
				result.word_errors >= 0 &&
				!approximatelyEqual(result.wer_percent, (result.word_errors / result.reference_words) * 100)
			) {
				errors.push(`${prefix}.wer_percent does not match word error counts`);
			}
			if (result.hallucinated_words !== null) {
				errors.push(`${prefix}.hallucinated_words must be null for WER samples`);
			}
			if (
				typeof result.passed === 'boolean' &&
				finiteNumber(result.wer_percent) &&
				finiteNumber(report.thresholds?.max_wer_percent) &&
				result.passed &&
				result.wer_percent > report.thresholds.max_wer_percent
			) {
				errors.push(`${prefix}.passed cannot be true above the WER threshold`);
			}
		} else {
			if (result.reference_words !== null) {
				errors.push(`${prefix}.reference_words must be null for non-WER samples`);
			}
			if (result.word_errors !== null) {
				errors.push(`${prefix}.word_errors must be null for non-WER samples`);
			}
			if (result.wer_percent !== null) {
				errors.push(`${prefix}.wer_percent must be null for non-WER samples`);
			}
			if (!Number.isInteger(result.hallucinated_words) || result.hallucinated_words < 0) {
				errors.push(
					`${prefix}.hallucinated_words must be a non-negative integer for non-WER samples`,
				);
			}
			if (
				typeof result.passed === 'boolean' &&
				Number.isInteger(result.hallucinated_words) &&
				finiteNumber(report.thresholds?.max_hallucinated_words) &&
				result.passed &&
				result.hallucinated_words > report.thresholds.max_hallucinated_words
			) {
				errors.push(`${prefix}.passed cannot be true above the hallucination threshold`);
			}
		}
	}
	if (
		typeof report.passed === 'boolean' &&
		report.results.every((result) => isObject(result) && typeof result.passed === 'boolean') &&
		report.passed !== report.results.every((result) => result.passed)
	) {
		errors.push(`${label}.passed must equal whether every result passed`);
	}
	return errors;
}

export function validateRunReportsAgainstCorpus(reports, corpus, label = 'reports') {
	const errors = [];
	if (!Array.isArray(reports)) return [`${label} must be an array`];
	if (!isObject(corpus)) return ['corpus must be a loaded corpus manifest'];
	if (typeof corpus.corpus_id !== 'string' || corpus.corpus_id.length === 0) {
		errors.push('corpus.corpus_id must be a non-empty string');
	}
	if (!SHA256_PATTERN.test(corpus.corpus_fingerprint ?? '')) {
		errors.push('corpus.corpus_fingerprint must be a lowercase SHA-256 digest');
	}
	if (!isReferenceProtocolId(corpus.reference_protocol_id)) {
		errors.push(
			`corpus.reference_protocol_id must be one of ${REFERENCE_PROTOCOL_IDS.map((id) => `'${id}'`).join(', ')}`,
		);
	}
	if (!Array.isArray(corpus.samples)) {
		errors.push('corpus.samples must be an array');
		return errors;
	}
	const samplesById = new Map();
	for (const [index, sample] of corpus.samples.entries()) {
		if (!isObject(sample) || typeof sample.id !== 'string' || sample.id.length === 0) {
			errors.push(`corpus.samples[${index}].id must be a non-empty string`);
			continue;
		}
		if (samplesById.has(sample.id)) {
			errors.push(`corpus sample id '${sample.id}' is duplicated`);
			continue;
		}
		samplesById.set(sample.id, sample);
	}
	for (const [reportIndex, report] of reports.entries()) {
		const reportPrefix = `${label}[${reportIndex}]`;
		if (!isObject(report)) {
			errors.push(`${reportPrefix} must be a JSON object`);
			continue;
		}
		if (report.corpus_id !== corpus.corpus_id) {
			errors.push(`${reportPrefix}.corpus_id must match corpus.corpus_id '${corpus.corpus_id}'`);
		}
		if (report.corpus_fingerprint !== corpus.corpus_fingerprint) {
			errors.push(
				`${reportPrefix}.corpus_fingerprint must match corpus.corpus_fingerprint ` +
					`'${corpus.corpus_fingerprint}'`,
			);
		}
		if (report.reference_protocol_id !== corpus.reference_protocol_id) {
			errors.push(
				`${reportPrefix}.reference_protocol_id must match corpus.reference_protocol_id ` +
					`'${corpus.reference_protocol_id}'`,
			);
		}
		if (!Array.isArray(report.results)) continue;
		for (const [resultIndex, result] of report.results.entries()) {
			if (!isObject(result) || typeof result.sample_id !== 'string') continue;
			const resultPrefix = `${reportPrefix}.results[${resultIndex}]`;
			const sample = samplesById.get(result.sample_id);
			if (!sample) {
				errors.push(`${resultPrefix}.sample_id '${result.sample_id}' is not present in the corpus`);
				continue;
			}
			for (const [resultField, sampleValue, sampleField] of [
				['dataset', sample.dataset, 'dataset'],
				['language', sample.language, 'language'],
				['noise_condition', sample.noise_condition, 'noise_condition'],
				['scenario', sample.scenario, 'scenario'],
				['speakers', sample.speakers, 'speakers'],
				['provenance_basis', sample.provenance?.basis, 'provenance.basis'],
			]) {
				if (result[resultField] !== sampleValue) {
					errors.push(
						`${resultPrefix}.${resultField} must match corpus sample ` +
							`'${result.sample_id}'.${sampleField} (${JSON.stringify(sampleValue)})`,
					);
				}
			}
			if (
				SHA256_PATTERN.test(sample.audio_sha256 ?? '') &&
				result.metrics?.audio_sha256 !== sample.audio_sha256
			) {
				errors.push(
					`${resultPrefix}.metrics.audio_sha256 must match corpus sample ` +
						`'${result.sample_id}'.audio_sha256`,
				);
			}
			if (
				finiteNumber(sample.duration_seconds) &&
				sample.duration_seconds > 0 &&
				finiteNumber(result.metrics?.audio_duration_seconds) &&
				!approximatelyEqual(result.metrics.audio_duration_seconds, sample.duration_seconds)
			) {
				errors.push(
					`${resultPrefix}.metrics.audio_duration_seconds must match corpus sample ` +
						`'${result.sample_id}'.duration_seconds (${sample.duration_seconds})`,
				);
			}
		}
	}
	return errors;
}

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function nearestRankPercentile(values, percentile) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function reduceSampleMeasurements(records) {
	const first = records[0];
	const referenceWords = first.reference_words;
	return {
		sample_id: first.sample_id,
		unit_key: first.unit_key,
		unit_kind: first.unit_kind,
		passed: records.every((record) => record.passed),
		reference_words: referenceWords,
		mean_word_errors:
			referenceWords === null ? null : mean(records.map((record) => record.word_errors)),
		audio_duration_seconds: first.metrics.audio_duration_seconds,
		mean_inference_seconds: mean(records.map((record) => record.metrics.inference_seconds)),
		mean_inference_audio_seconds: mean(
			records.map((record) => record.metrics.inference_audio_seconds),
		),
		peak_rss_mb: Math.max(...records.map((record) => record.metrics.peak_rss_mb)),
		peak_rss_delta_mb: Math.max(...records.map((record) => record.metrics.peak_rss_delta_mb)),
	};
}

function reduceAnalysisUnit(samples) {
	const first = samples[0];
	const werSamples = samples.filter((sample) => sample.reference_words !== null);
	const referenceWords = werSamples.reduce((sum, sample) => sum + sample.reference_words, 0);
	const wordErrors = werSamples.reduce((sum, sample) => sum + sample.mean_word_errors, 0);
	const audioDurationSeconds = samples.reduce(
		(sum, sample) => sum + sample.audio_duration_seconds,
		0,
	);
	const inferenceSeconds = samples.reduce((sum, sample) => sum + sample.mean_inference_seconds, 0);
	const inferenceAudioSeconds = samples.reduce(
		(sum, sample) => sum + sample.mean_inference_audio_seconds,
		0,
	);
	return {
		unit_key: first.unit_key,
		unit_kind: first.unit_kind,
		passed: samples.every((sample) => sample.passed),
		wer_percent: referenceWords === 0 ? null : (wordErrors / referenceWords) * 100,
		inference_rtf: inferenceSeconds / audioDurationSeconds,
		model_inference_rtf:
			inferenceAudioSeconds === 0 ? null : inferenceSeconds / inferenceAudioSeconds,
		peak_rss_mb: Math.max(...samples.map((sample) => sample.peak_rss_mb)),
		peak_rss_delta_mb: Math.max(...samples.map((sample) => sample.peak_rss_delta_mb)),
	};
}

function summarizeAnalysisUnits(records) {
	const measurementsBySample = new Map();
	for (const record of records) {
		const sampleMeasurements = measurementsBySample.get(record.sample_id);
		if (sampleMeasurements) sampleMeasurements.push(record);
		else measurementsBySample.set(record.sample_id, [record]);
	}
	const samples = [...measurementsBySample.entries()]
		.sort(([left], [right]) => compareText(left, right))
		.map(([, measurements]) =>
			reduceSampleMeasurements(
				measurements.sort((left, right) => left.repeat_index - right.repeat_index),
			),
		);
	const samplesByUnit = new Map();
	for (const sample of samples) {
		const unitSamples = samplesByUnit.get(sample.unit_key);
		if (unitSamples) unitSamples.push(sample);
		else samplesByUnit.set(sample.unit_key, [sample]);
	}
	const units = [...samplesByUnit.entries()]
		.sort(([left], [right]) => compareText(left, right))
		.map(([, unitSamples]) => reduceAnalysisUnit(unitSamples));
	const werUnits = units.filter((unit) => unit.wer_percent !== null);
	const modelRtfUnits = units.filter((unit) => unit.model_inference_rtf !== null);
	const inferenceRtfs = units.map((unit) => unit.inference_rtf);
	const modelInferenceRtfs = modelRtfUnits.map((unit) => unit.model_inference_rtf);
	const peaks = units.map((unit) => unit.peak_rss_mb);
	const peakDeltas = units.map((unit) => unit.peak_rss_delta_mb);
	return {
		unit_count: units.length,
		session_count: units.filter((unit) => unit.unit_kind === 'session').length,
		singleton_sample_count: units.filter((unit) => unit.unit_kind === 'singleton-sample').length,
		passed_unit_count: units.filter((unit) => unit.passed).length,
		pass_rate_percent: (units.filter((unit) => unit.passed).length / units.length) * 100,
		wer_unit_count: werUnits.length,
		wer_percent: werUnits.length === 0 ? null : mean(werUnits.map((unit) => unit.wer_percent)),
		mean_inference_rtf: mean(inferenceRtfs),
		median_inference_rtf: median(inferenceRtfs),
		p95_inference_rtf: nearestRankPercentile(inferenceRtfs, 0.95),
		max_inference_rtf: Math.max(...inferenceRtfs),
		model_rtf_unit_count: modelRtfUnits.length,
		mean_model_inference_rtf: modelInferenceRtfs.length === 0 ? null : mean(modelInferenceRtfs),
		median_model_inference_rtf: modelInferenceRtfs.length === 0 ? null : median(modelInferenceRtfs),
		p95_model_inference_rtf: nearestRankPercentile(modelInferenceRtfs, 0.95),
		max_model_inference_rtf:
			modelInferenceRtfs.length === 0 ? null : Math.max(...modelInferenceRtfs),
		mean_peak_rss_mb: mean(peaks),
		median_peak_rss_mb: median(peaks),
		p95_peak_rss_mb: nearestRankPercentile(peaks, 0.95),
		max_peak_rss_mb: Math.max(...peaks),
		mean_peak_rss_delta_mb: mean(peakDeltas),
		median_peak_rss_delta_mb: median(peakDeltas),
		p95_peak_rss_delta_mb: nearestRankPercentile(peakDeltas, 0.95),
		max_peak_rss_delta_mb: Math.max(...peakDeltas),
	};
}

function summarize(records) {
	const werRecords = records.filter((record) => record.reference_words !== null);
	const silenceRecords = records.filter((record) => record.reference_words === null);
	const referenceWords = werRecords.reduce((sum, record) => sum + record.reference_words, 0);
	const wordErrors = werRecords.reduce((sum, record) => sum + record.word_errors, 0);
	const rtfs = records.map((record) => record.metrics.inference_rtf);
	const modelRtfs = records
		.map((record) => record.metrics.model_inference_rtf)
		.filter((value) => value !== null);
	const baselines = records.map((record) => record.metrics.baseline_rss_mb);
	const peaks = records.map((record) => record.metrics.peak_rss_mb);
	const peakDeltas = records.map((record) => record.metrics.peak_rss_delta_mb);
	const audioDurationSeconds = records.reduce(
		(sum, record) => sum + record.metrics.audio_duration_seconds,
		0,
	);
	const inferenceSeconds = records.reduce(
		(sum, record) => sum + record.metrics.inference_seconds,
		0,
	);
	const inferenceAudioSeconds = records.reduce(
		(sum, record) => sum + record.metrics.inference_audio_seconds,
		0,
	);
	return {
		samples: records.length,
		passed_samples: records.filter((record) => record.passed).length,
		pass_rate_percent: (records.filter((record) => record.passed).length / records.length) * 100,
		audio_duration_seconds: audioDurationSeconds,
		inference_seconds: inferenceSeconds,
		inference_audio_seconds: inferenceAudioSeconds,
		wer_samples: werRecords.length,
		reference_words: referenceWords,
		word_errors: wordErrors,
		wer_percent: referenceWords === 0 ? null : (wordErrors / referenceWords) * 100,
		macro_wer_percent:
			werRecords.length === 0 ? null : mean(werRecords.map((record) => record.wer_percent)),
		hallucination_samples: silenceRecords.length,
		hallucinated_words_total: silenceRecords.reduce(
			(sum, record) => sum + record.hallucinated_words,
			0,
		),
		hallucinated_words_max:
			silenceRecords.length === 0
				? null
				: Math.max(...silenceRecords.map((record) => record.hallucinated_words)),
		aggregate_inference_rtf:
			audioDurationSeconds === 0 ? null : inferenceSeconds / audioDurationSeconds,
		mean_inference_rtf: mean(rtfs),
		median_inference_rtf: median(rtfs),
		p95_inference_rtf: nearestRankPercentile(rtfs, 0.95),
		max_inference_rtf: Math.max(...rtfs),
		aggregate_model_inference_rtf:
			inferenceAudioSeconds === 0 ? null : inferenceSeconds / inferenceAudioSeconds,
		mean_model_inference_rtf: modelRtfs.length === 0 ? null : mean(modelRtfs),
		median_model_inference_rtf: modelRtfs.length === 0 ? null : median(modelRtfs),
		p95_model_inference_rtf: nearestRankPercentile(modelRtfs, 0.95),
		max_model_inference_rtf: modelRtfs.length === 0 ? null : Math.max(...modelRtfs),
		mean_baseline_rss_mb: mean(baselines),
		max_baseline_rss_mb: Math.max(...baselines),
		mean_peak_rss_mb: mean(peaks),
		max_peak_rss_mb: Math.max(...peaks),
		mean_peak_rss_delta_mb: mean(peakDeltas),
		max_peak_rss_delta_mb: Math.max(...peakDeltas),
		unit_balanced: summarizeAnalysisUnits(records),
	};
}

function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function variantIdentity(provider, model, backend) {
	return { provider, model, backend };
}

function variantKey(identity) {
	return JSON.stringify([identity.provider, identity.model, identity.backend]);
}

function compareVariants(left, right) {
	return (
		compareText(left.provider, right.provider) ||
		compareText(left.model, right.model) ||
		compareText(left.backend, right.backend)
	);
}

function groupedSummaries(records, dimensions) {
	const groups = new Map();
	for (const record of records) {
		const values = Object.fromEntries(
			dimensions.map(([field, valueFor]) => [field, valueFor(record)]),
		);
		const key = JSON.stringify(dimensions.map(([field]) => values[field]));
		const existing = groups.get(key);
		if (existing) {
			existing.records.push(record);
		} else {
			groups.set(key, { values, records: [record] });
		}
	}
	return [...groups.values()]
		.sort((left, right) => {
			for (const [field] of dimensions) {
				const comparison = compareText(left.values[field], right.values[field]);
				if (comparison !== 0) return comparison;
			}
			return 0;
		})
		.map(({ values, records: groupRecords }) => ({
			...values,
			summary: summarize(groupRecords),
		}));
}

function summarizeVariant(identity, records) {
	const orderedRecords = [...records].sort(
		(left, right) =>
			compareText(left.sample_id, right.sample_id) || left.repeat_index - right.repeat_index,
	);
	const hardWerRecords = orderedRecords.filter(
		(record) => record.noise_condition !== 'synthetic-overlap',
	);
	return {
		...identity,
		observed_sample_count: new Set(orderedRecords.map((record) => record.sample_id)).size,
		measurement_result_count: orderedRecords.length,
		groups: {
			overall: summarize(orderedRecords),
			hard_wer_overall: hardWerRecords.length === 0 ? null : summarize(hardWerRecords),
			dataset: groupedSummaries(
				orderedRecords.filter((record) => record.dataset !== undefined),
				[['dataset', (record) => record.dataset]],
			),
			language: groupedSummaries(orderedRecords, [['language', (record) => record.language]]),
			scenario: groupedSummaries(orderedRecords, [['scenario', (record) => record.scenario]]),
			noise_condition: groupedSummaries(orderedRecords, [
				['noise_condition', (record) => record.noise_condition],
			]),
			language_noise: groupedSummaries(orderedRecords, [
				['language', (record) => record.language],
				['noise_condition', (record) => record.noise_condition],
			]),
		},
	};
}

function comparisonGroups(diagnostics) {
	const withVariant = (diagnostic, value) => ({
		provider: diagnostic.provider,
		model: diagnostic.model,
		backend: diagnostic.backend,
		...value,
	});
	const sortRows = (rows, dimensions = []) =>
		rows.sort((left, right) => {
			for (const field of dimensions) {
				const comparison = compareText(left[field], right[field]);
				if (comparison !== 0) return comparison;
			}
			return compareVariants(left, right);
		});
	return {
		variant: diagnostics.map((diagnostic) =>
			withVariant(diagnostic, { summary: diagnostic.groups.overall }),
		),
		dataset_variant: sortRows(
			diagnostics.flatMap((diagnostic) =>
				diagnostic.groups.dataset.map((row) => withVariant(diagnostic, row)),
			),
			['dataset'],
		),
		language_variant: sortRows(
			diagnostics.flatMap((diagnostic) =>
				diagnostic.groups.language.map((row) => withVariant(diagnostic, row)),
			),
			['language'],
		),
		scenario_variant: sortRows(
			diagnostics.flatMap((diagnostic) =>
				diagnostic.groups.scenario.map((row) => withVariant(diagnostic, row)),
			),
			['scenario'],
		),
		noise_condition_variant: sortRows(
			diagnostics.flatMap((diagnostic) =>
				diagnostic.groups.noise_condition.map((row) => withVariant(diagnostic, row)),
			),
			['noise_condition'],
		),
		language_noise_variant: sortRows(
			diagnostics.flatMap((diagnostic) =>
				diagnostic.groups.language_noise.map((row) => withVariant(diagnostic, row)),
			),
			['language', 'noise_condition'],
		),
	};
}

function sampleIdentity(record) {
	return {
		audio_sha256: record.metrics.audio_sha256,
		audio_duration_seconds: record.metrics.audio_duration_seconds,
		dataset: record.dataset,
		language: record.language,
		noise_condition: record.noise_condition,
		scenario: record.scenario,
		speakers: record.speakers,
		provenance_basis: record.provenance_basis,
		reference_words: record.reference_words,
	};
}

function sampleIdentityMismatch(left, right) {
	for (const field of [
		'audio_sha256',
		'dataset',
		'language',
		'noise_condition',
		'scenario',
		'speakers',
		'provenance_basis',
		'reference_words',
	]) {
		if (left[field] !== right[field]) return field;
	}
	if (left.audio_duration_seconds !== right.audio_duration_seconds) {
		return 'audio_duration_seconds';
	}
	return null;
}

function copyEvaluatorRevision(revision) {
	return {
		schema_version: revision.schema_version,
		protocol_id: revision.protocol_id,
		git_commit: revision.git_commit,
		cargo_lock_sha256: revision.cargo_lock_sha256,
		rustc_vv: revision.rustc_vv,
		build_profile: revision.build_profile,
		target_triple: revision.target_triple,
		cargo_features: [...revision.cargo_features],
		build_env_sha256: revision.build_env_sha256,
	};
}

function commonEvaluatorRevision(revision) {
	const common = copyEvaluatorRevision(revision);
	delete common.cargo_features;
	return common;
}

export function aggregateRunReports(reports, corpus) {
	if (!Array.isArray(reports) || reports.length === 0)
		throw new Error('at least one run report is required');
	for (const [index, report] of reports.entries()) {
		const errors = validateRunReport(report, `reports[${index}]`);
		if (errors.length > 0) throw new Error(`invalid benchmark report:\n- ${errors.join('\n- ')}`);
	}
	const corpusSamples = aggregationCorpusSamples(corpus);
	const bindingErrors = validateRunReportsAgainstCorpus(reports, corpus);
	if (bindingErrors.length > 0) {
		throw new Error(
			`benchmark reports do not match the corpus manifest:\n- ${bindingErrors.join('\n- ')}`,
		);
	}
	const records = [];
	let corpusId;
	let corpusFingerprint;
	let referenceProtocolId;
	let werScorer;
	let evaluatorRevisionCommon;
	let thresholds;
	let operatingSystem;
	let architecture;
	let hardwareProfile;
	const accelerators = new Map();
	const modelArtifacts = new Map();
	const evaluatorRevisions = new Map();
	const benchmarkExecutables = new Map();
	const measurementSources = new Map();
	const benchmarkTaskSources = new Map();
	const sampleIdentities = new Map();
	const inputBindings = {
		standalone_schema_10: { report_count: 0, measurement_result_count: 0 },
		task_bound_schema_11: { report_count: 0, measurement_result_count: 0 },
	};
	for (const [index, report] of reports.entries()) {
		const inputBinding =
			report.schema_version === STANDALONE_RUN_REPORT_SCHEMA_VERSION
				? inputBindings.standalone_schema_10
				: inputBindings.task_bound_schema_11;
		inputBinding.report_count += 1;
		inputBinding.measurement_result_count += report.results.length;
		if (report.schema_version === CAMPAIGN_RUN_REPORT_SCHEMA_VERSION) {
			const result = report.results[0];
			const taskMeasurement = JSON.stringify([
				report.provider,
				report.model,
				result.metrics.backend,
				result.sample_id,
				report.repeat_index,
			]);
			const priorTask = benchmarkTaskSources.get(report.benchmark_task_id);
			if (priorTask !== undefined) {
				throw new Error(
					`cannot aggregate duplicate benchmark_task_id '${report.benchmark_task_id}' ` +
						`for ${priorTask.measurement} from reports[${priorTask.index}] and ` +
						`${taskMeasurement} from reports[${index}]`,
				);
			}
			benchmarkTaskSources.set(report.benchmark_task_id, {
				index,
				measurement: taskMeasurement,
			});
		}
		if (corpusId === undefined) {
			corpusId = report.corpus_id;
			corpusFingerprint = report.corpus_fingerprint;
			referenceProtocolId = report.reference_protocol_id;
		} else if (report.corpus_id !== corpusId) {
			throw new Error(
				`cannot aggregate different corpora: '${corpusId}' and '${report.corpus_id}'`,
			);
		}
		if (report.corpus_fingerprint !== corpusFingerprint) {
			throw new Error('cannot aggregate reports from different corpus revisions');
		}
		if (report.reference_protocol_id !== referenceProtocolId) {
			throw new Error('cannot aggregate reports using different reference protocols');
		}
		if (werScorer === undefined) {
			werScorer = report.wer_scorer;
		} else if (report.wer_scorer !== werScorer) {
			throw new Error('cannot aggregate reports produced with different WER scorers');
		}
		const reportCommonRevision = commonEvaluatorRevision(report.evaluator_revision);
		if (evaluatorRevisionCommon === undefined) {
			evaluatorRevisionCommon = reportCommonRevision;
		} else if (JSON.stringify(reportCommonRevision) !== JSON.stringify(evaluatorRevisionCommon)) {
			throw new Error(
				'cannot aggregate evaluator revisions with different common build provenance',
			);
		}
		const modelKey = modelArtifactBindingKey(
			report.provider,
			report.model,
			report.results[0].metrics.backend,
		);
		const priorArtifact = modelArtifacts.get(modelKey);
		if (priorArtifact !== undefined && priorArtifact !== report.model_artifact_sha256) {
			throw new Error(`cannot aggregate different artifacts for model '${modelKey}'`);
		}
		modelArtifacts.set(modelKey, report.model_artifact_sha256);
		if (thresholds === undefined) {
			thresholds = { ...report.thresholds };
		} else if (
			report.thresholds.max_wer_percent !== thresholds.max_wer_percent ||
			report.thresholds.max_hallucinated_words !== thresholds.max_hallucinated_words
		) {
			throw new Error('cannot aggregate reports produced with different pass thresholds');
		}
		for (const [resultIndex, result] of report.results.entries()) {
			const repeatIndex = report.repeat_index ?? 1;
			if (operatingSystem === undefined) {
				operatingSystem = result.metrics.operating_system;
				architecture = result.metrics.architecture;
				hardwareProfile = result.metrics.hardware_profile;
			} else if (
				result.metrics.operating_system !== operatingSystem ||
				result.metrics.architecture !== architecture ||
				result.metrics.hardware_profile !== hardwareProfile
			) {
				throw new Error('cannot aggregate reports from different hardware profiles');
			}
			const priorAccelerator = accelerators.get(result.metrics.backend);
			if (priorAccelerator !== undefined && priorAccelerator !== result.metrics.accelerator) {
				throw new Error(
					`cannot aggregate different accelerators for backend '${result.metrics.backend}'`,
				);
			}
			accelerators.set(result.metrics.backend, result.metrics.accelerator);
			const priorEvaluatorRevision = evaluatorRevisions.get(result.metrics.backend);
			if (
				priorEvaluatorRevision !== undefined &&
				priorEvaluatorRevision.evaluator_revision_sha256 !== report.evaluator_revision_sha256
			) {
				throw new Error(
					`cannot aggregate different evaluator revisions for backend '${result.metrics.backend}'`,
				);
			}
			evaluatorRevisions.set(result.metrics.backend, {
				evaluator_revision: copyEvaluatorRevision(report.evaluator_revision),
				evaluator_revision_sha256: report.evaluator_revision_sha256,
			});
			const priorBenchmarkExecutable = benchmarkExecutables.get(result.metrics.backend);
			if (
				priorBenchmarkExecutable !== undefined &&
				priorBenchmarkExecutable !== report.benchmark_executable_sha256
			) {
				throw new Error(
					`cannot aggregate different benchmark executables for backend '${result.metrics.backend}'`,
				);
			}
			benchmarkExecutables.set(result.metrics.backend, report.benchmark_executable_sha256);
			const measurementKey = JSON.stringify([
				report.provider,
				report.model,
				result.metrics.backend,
				result.sample_id,
				repeatIndex,
			]);
			const source = `reports[${index}].results[${resultIndex}]`;
			const priorSource = measurementSources.get(measurementKey);
			if (priorSource !== undefined) {
				throw new Error(
					`cannot aggregate duplicate provider/model/backend/sample_id/repeat_index measurement ` +
						`${measurementKey} from ${priorSource} and ${source}`,
				);
			}
			measurementSources.set(measurementKey, source);
			const identity = sampleIdentity(result);
			const priorIdentity = sampleIdentities.get(result.sample_id);
			if (priorIdentity !== undefined) {
				const mismatch = sampleIdentityMismatch(priorIdentity, identity);
				if (mismatch !== null) {
					throw new Error(
						`cannot aggregate inconsistent identity for sample '${result.sample_id}': ` +
							`${mismatch} differs at ${source}`,
					);
				}
			} else {
				sampleIdentities.set(result.sample_id, identity);
			}
			const corpusSample = corpusSamples.get(result.sample_id);
			const sessionUnit = corpusSample.session_id !== undefined;
			records.push({
				...result,
				provider: report.provider,
				model: report.model,
				repeat_index: repeatIndex,
				unit_key: sessionUnit
					? `session\0${corpusSample.session_id}`
					: `sample\0${corpusSample.id}`,
				unit_kind: sessionUnit ? 'session' : 'singleton-sample',
			});
		}
	}

	const variantsByKey = new Map();
	for (const record of records) {
		const identity = variantIdentity(record.provider, record.model, record.metrics.backend);
		const key = variantKey(identity);
		const existing = variantsByKey.get(key);
		if (existing) {
			existing.records.push(record);
			existing.sampleIds.add(record.sample_id);
			existing.measurementIds.add(`${record.sample_id}\0${record.repeat_index}`);
		} else {
			variantsByKey.set(key, {
				...identity,
				records: [record],
				sampleIds: new Set([record.sample_id]),
				measurementIds: new Set([`${record.sample_id}\0${record.repeat_index}`]),
			});
		}
	}
	const variants = [...variantsByKey.values()].sort(compareVariants);
	const unionSampleIds = new Set(variants.flatMap((variant) => [...variant.sampleIds]));
	const unionMeasurementIds = new Set(variants.flatMap((variant) => [...variant.measurementIds]));
	const commonSampleIds = new Set(variants[0].sampleIds);
	const commonMeasurementIds = new Set(variants[0].measurementIds);
	for (const variant of variants.slice(1)) {
		for (const sampleId of commonSampleIds) {
			if (!variant.sampleIds.has(sampleId)) commonSampleIds.delete(sampleId);
		}
		for (const measurementId of commonMeasurementIds) {
			if (!variant.measurementIds.has(measurementId)) commonMeasurementIds.delete(measurementId);
		}
	}
	const identicalCohorts = variants.every(
		(variant) =>
			variant.measurementIds.size === variants[0].measurementIds.size &&
			[...variants[0].measurementIds].every((measurementId) =>
				variant.measurementIds.has(measurementId),
			),
	);
	const comparisonStatus =
		variants.length < 2
			? 'single-variant'
			: identicalCohorts
				? 'comparable'
				: 'unequal-measurement-cohorts';
	const diagnostics = variants.map((variant) =>
		summarizeVariant(
			variantIdentity(variant.provider, variant.model, variant.backend),
			variant.records,
		),
	);
	const comparisonCohorts = variants.map((variant) => ({
		provider: variant.provider,
		model: variant.model,
		backend: variant.backend,
		observed_sample_count: variant.sampleIds.size,
		observed_measurement_count: variant.measurementIds.size,
		not_common_sample_count: [...variant.sampleIds].filter(
			(sampleId) => !commonSampleIds.has(sampleId),
		).length,
		missing_from_union_sample_count: unionSampleIds.size - variant.sampleIds.size,
		not_common_measurement_count: [...variant.measurementIds].filter(
			(measurementId) => !commonMeasurementIds.has(measurementId),
		).length,
		missing_from_union_measurement_count: unionMeasurementIds.size - variant.measurementIds.size,
	}));

	return {
		schema_version: AGGREGATE_REPORT_SCHEMA_VERSION,
		aggregation_unit_policy: AGGREGATION_UNIT_POLICY,
		generated_at: new Date().toISOString(),
		corpus_id: corpusId,
		corpus_fingerprint: corpusFingerprint,
		reference_protocol_id: referenceProtocolId,
		wer_scorer: werScorer,
		evaluator_revision_common: evaluatorRevisionCommon,
		evaluator_revisions: Object.fromEntries(
			[...evaluatorRevisions.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		benchmark_executables: Object.fromEntries(
			[...benchmarkExecutables.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		operating_system: operatingSystem,
		architecture,
		hardware_profile: hardwareProfile,
		accelerators: Object.fromEntries(
			[...accelerators.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		model_artifacts: Object.fromEntries(
			[...modelArtifacts.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		thresholds,
		source_report_count: reports.length,
		measurement_result_count: records.length,
		input_bindings: inputBindings,
		distinct_sample_count: unionSampleIds.size,
		diagnostics: { variants: diagnostics },
		comparison: {
			status: comparisonStatus,
			scope: 'supplied-variants',
			target_completeness: 'not-assessed',
			variant_count: variants.length,
			union_sample_count: unionSampleIds.size,
			common_sample_count: commonSampleIds.size,
			union_measurement_count: unionMeasurementIds.size,
			common_measurement_count: commonMeasurementIds.size,
			cohorts: comparisonCohorts,
			groups: comparisonStatus === 'comparable' ? comparisonGroups(diagnostics) : null,
		},
	};
}

function display(value, digits = 2) {
	return value === null ? '—' : value.toFixed(digits);
}

function escapeCell(value) {
	return value.replaceAll('|', '\\|');
}

function variantLabel(row) {
	return `${row.provider}/${row.model}/${row.backend}`;
}

function appendSummaryTable(lines, rows) {
	lines.push(
		'| Group | Measurements | Analysis units (sessions + singleton samples) | WER units | Model-RTF units | Unit pass rate | Pooled WER | Unit-balanced WER | Pooled source RTF | Unit P50 source RTF | Unit P95 source RTF | Unit P50 model-input RTF | Unit P95 model-input RTF | Unit P95 sampled evaluator-process host RSS | Unit max sampled evaluator-process host RSS | Unit max sampled host RSS increase | Hallucinated words |',
	);
	lines.push(
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
	);
	for (const { label, summary } of rows) {
		const balanced = summary.unit_balanced;
		const werCell = summary.wer_percent === null ? '—' : `${display(summary.wer_percent)}%`;
		const balancedWerCell =
			balanced.wer_percent === null ? '—' : `${display(balanced.wer_percent)}%`;
		const unitCountCell =
			`${balanced.unit_count} (${balanced.session_count} + ` +
			`${balanced.singleton_sample_count})`;
		lines.push(
			`| ${escapeCell(label)} | ${summary.samples} | ${unitCountCell} | ${balanced.wer_unit_count} | ${balanced.model_rtf_unit_count} | ${display(balanced.pass_rate_percent)}% | ${werCell} | ${balancedWerCell} | ${display(summary.aggregate_inference_rtf, 3)} | ${display(balanced.median_inference_rtf, 3)} | ${display(balanced.p95_inference_rtf, 3)} | ${display(balanced.median_model_inference_rtf, 3)} | ${display(balanced.p95_model_inference_rtf, 3)} | ${display(balanced.p95_peak_rss_mb, 1)} MiB | ${display(balanced.max_peak_rss_mb, 1)} MiB | ${display(balanced.max_peak_rss_delta_mb, 1)} MiB | ${summary.hallucinated_words_total} |`,
		);
	}
}

function comparisonRowLabel(dimension, row) {
	const variant = variantLabel(row);
	if (dimension === 'dataset_variant') return `${row.dataset} / ${variant}`;
	if (dimension === 'language_variant') return `${row.language} / ${variant}`;
	if (dimension === 'scenario_variant') return `${row.scenario} / ${variant}`;
	if (dimension === 'noise_condition_variant') return `${row.noise_condition} / ${variant}`;
	if (dimension === 'language_noise_variant') {
		return `${row.language} / ${row.noise_condition} / ${variant}`;
	}
	return variant;
}

function comparisonDimensionTitle(dimension) {
	if (dimension === 'variant') return 'By exact variant';
	if (dimension === 'dataset_variant') return 'By dataset and exact variant';
	if (dimension === 'language_variant') return 'By language and exact variant';
	if (dimension === 'scenario_variant') return 'By scenario and exact variant';
	if (dimension === 'noise_condition_variant') return 'By noise condition and exact variant';
	return 'By language, noise condition, and exact variant';
}

export function renderMarkdown(report) {
	const lines = [
		'# ASR corpus benchmark',
		'',
		`Generated ${report.generated_at} from ${report.source_report_count} run report(s), ${report.measurement_result_count} measurement result(s), and ${report.distinct_sample_count} distinct sample(s).`,
		'',
		'Input bindings:',
		'',
		`- Standalone schema 10: ${report.input_bindings.standalone_schema_10.report_count} report(s), ${report.input_bindings.standalone_schema_10.measurement_result_count} measurement result(s).`,
		`- Task-bound schema 11: ${report.input_bindings.task_bound_schema_11.report_count} report(s), ${report.input_bindings.task_bound_schema_11.measurement_result_count} measurement result(s).`,
		'',
		`Corpus: \`${report.corpus_id}\``,
		'',
		`Corpus fingerprint: \`${report.corpus_fingerprint}\``,
		'',
		`Aggregation-unit policy: \`${report.aggregation_unit_policy}\``,
		'',
		`Reference protocol: \`${report.reference_protocol_id}\``,
		'',
		`WER scorer: \`${report.wer_scorer}\``,
		'',
		'Evaluator revisions:',
		'',
		...Object.entries(report.evaluator_revisions).map(
			([backend, provenance]) =>
				`- \`${backend}\`: \`${provenance.evaluator_revision_sha256}\` (features: ${
					provenance.evaluator_revision.cargo_features.length === 0
						? '`none`'
						: provenance.evaluator_revision.cargo_features
								.map((feature) => `\`${feature}\``)
								.join(', ')
				})`,
		),
		'',
		'Benchmark executables:',
		'',
		...Object.entries(report.benchmark_executables).map(
			([backend, digest]) => `- \`${backend}\`: \`${digest}\``,
		),
		'',
		`Platform: \`${report.operating_system}/${report.architecture}\``,
		'',
		`Hardware profile: \`${report.hardware_profile}\``,
		`Accelerators: ${Object.entries(report.accelerators)
			.map(([backend, accelerator]) => `\`${backend}\` = \`${accelerator}\``)
			.join('; ')}`,
		'',
		'Model artifacts:',
		'',
		...Object.entries(report.model_artifacts).map(
			([model, digest]) => `- \`${model}\`: \`${digest}\``,
		),
		'',
		`Pass thresholds: WER ≤ ${display(report.thresholds.max_wer_percent)}%; hallucinated words ≤ ${display(report.thresholds.max_hallucinated_words, 0)}.`,
		'',
		'Unit-balanced metrics first reduce technical repeats into each sample, pool samples within the same manifest-declared session, and then weight every session equally. Error and timing components are averaged across repeats; pass state requires every repeat to pass, and peak RSS keeps the maximum. Samples without a natural session are explicitly treated as singleton units. Pooled WER/RTF and the remaining flat JSON summary fields are measurement-weighted diagnostics; raw session identifiers are never emitted.',
		'',
		'P95 uses the deterministic nearest-rank method and equals the maximum with 1–19 eligible units. Source-audio RTF divides inference time by original audio duration; model-input RTF divides it by the exact post-VAD audio passed to ASR. WER and model-RTF unit counts show their eligible denominators.',
		'',
		'Each language, scenario, and noise slice rebuilds units from only the samples in that slice. A multilingual or mixed-noise session can therefore contribute once to multiple slice rows; slice unit counts do not partition the overall count.',
		'',
		"RSS is evaluator-process host memory sampled every 10 ms from immediately before model load through the end of inference. It includes the evaluator process and runtime, excludes accelerator VRAM, and may miss peaks between samples. RSS increase is the sampled peak minus that process's pre-model-load baseline; it is not model-only memory.",
		'',
		'## Session-balanced hard WER',
		'',
		'`synthetic-overlap` is excluded before repeats and manifest sessions are reduced. These rows are the decision-safe serial-WER view; overlap remains in the other diagnostic and performance summaries.',
		'',
	];
	appendSummaryTable(
		lines,
		report.diagnostics.variants
			.filter((diagnostic) => diagnostic.groups.hard_wer_overall !== null)
			.map((diagnostic) => ({
				label: variantLabel(diagnostic),
				summary: diagnostic.groups.hard_wer_overall,
			})),
	);
	lines.push('', '## Comparison status', '');
	if (report.comparison.status === 'comparable') {
		lines.push(
			`Comparable across ${report.comparison.variant_count} supplied exact variants on an identical ${report.comparison.common_sample_count}-sample, ${report.comparison.common_measurement_count}-measurement cohort.`,
		);
	} else if (report.comparison.status === 'single-variant') {
		lines.push('No cross-variant comparison: only one exact variant was supplied.');
	} else {
		lines.push(
			`No cross-variant comparison: supplied variants have unequal sample/repeat cohorts (${report.comparison.common_measurement_count} common of ${report.comparison.union_measurement_count} distinct measurements across ${report.comparison.union_sample_count} samples). Post-hoc intersection metrics are intentionally not reported.`,
		);
	}
	lines.push(
		'',
		'This comparison scope includes only the supplied variants and does not assess target completeness. Use `eval:coverage --require-complete` for the target-matrix gate.',
		'',
		'| Variant | Observed samples | Observed measurements | Measurements outside common cohort | Measurements missing from union |',
		'| --- | ---: | ---: | ---: | ---: |',
		...report.comparison.cohorts.map(
			(cohort) =>
				`| ${escapeCell(variantLabel(cohort))} | ${cohort.observed_sample_count} | ${cohort.observed_measurement_count} | ${cohort.not_common_measurement_count} | ${cohort.missing_from_union_measurement_count} |`,
		),
	);
	if (report.comparison.groups !== null) {
		lines.push('', '## Cross-variant comparisons');
		for (const [dimension, rows] of Object.entries(report.comparison.groups)) {
			if (rows.length === 0) continue;
			lines.push('', `### ${comparisonDimensionTitle(dimension)}`, '');
			appendSummaryTable(
				lines,
				rows.map((row) => ({ label: comparisonRowLabel(dimension, row), summary: row.summary })),
			);
		}
	} else {
		lines.push(
			'',
			'## Available-sample diagnostics',
			'',
			'These summaries describe each exact variant independently. Because the observed sample cohorts are not comparison-safe, do not compare values across variant subsections.',
		);
		for (const diagnostic of report.diagnostics.variants) {
			lines.push('', `### ${variantLabel(diagnostic)}`, '', '#### Overall', '');
			appendSummaryTable(lines, [{ label: 'all observed', summary: diagnostic.groups.overall }]);
			for (const [dimension, rows] of [
				['Dataset', diagnostic.groups.dataset],
				['Language', diagnostic.groups.language],
				['Scenario', diagnostic.groups.scenario],
				['Noise condition', diagnostic.groups.noise_condition],
				['Language and noise condition', diagnostic.groups.language_noise],
			]) {
				if (rows.length === 0) continue;
				lines.push('', `#### ${dimension}`, '');
				appendSummaryTable(
					lines,
					rows.map((row) => ({
						label:
							row.language && row.noise_condition
								? `${row.language} / ${row.noise_condition}`
								: (row.dataset ?? row.language ?? row.scenario ?? row.noise_condition),
						summary: row.summary,
					})),
				);
			}
		}
	}
	return `${lines.join('\n')}\n`;
}

function stringFlag(args, name) {
	const index = args.indexOf(name);
	if (index === -1) return null;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
	args.splice(index, 2);
	return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const args = process.argv.slice(2);
		const manifestPath = stringFlag(args, '--manifest');
		const jsonOutput = stringFlag(args, '--json');
		const markdownOutput = stringFlag(args, '--markdown');
		if (args.length === 0) {
			throw new Error(
				'Usage: nub report.ts <run.json>... --manifest <path> [--json <path>] [--markdown <path>]',
			);
		}
		if (!manifestPath) {
			throw new Error('--manifest is required for aggregate reporting');
		}
		const reports = args.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
		const corpus = loadCorpus(manifestPath);
		const aggregate = aggregateRunReports(reports, corpus);
		const markdown = renderMarkdown(aggregate);
		if (jsonOutput || markdownOutput) {
			writeCorpusBoundFiles({
				manifestPath,
				expectedFingerprint: aggregate.corpus_fingerprint,
				outputs: [
					...(jsonOutput
						? [
								{
									outputPath: jsonOutput,
									contents: `${JSON.stringify(aggregate, null, 2)}\n`,
								},
							]
						: []),
					...(markdownOutput ? [{ outputPath: markdownOutput, contents: markdown }] : []),
				],
			});
		}
		if (!markdownOutput) process.stdout.write(markdown);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
}
