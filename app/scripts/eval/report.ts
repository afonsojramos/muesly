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
import { loadCorpus } from './corpus.ts';
import { evaluatorRevisionSha256, validateEvaluatorRevision } from './evaluator-revision.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// The VAD flush pads one final 16 kHz processing block, so model input can
// legitimately exceed decoded source duration by less than one 30 ms block.
const MAX_INFERENCE_AUDIO_OVERRUN_SECONDS = 0.03;
const RUN_REPORT_FIELDS = new Set([
	'schema_version',
	'corpus_id',
	'corpus_fingerprint',
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
const THRESHOLD_FIELDS = new Set(['max_wer_percent', 'max_hallucinated_words']);
const RESULT_FIELDS = new Set([
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

const DIMENSIONS = [
	['overall', () => 'all'],
	['language', (record) => record.language],
	['noise_condition', (record) => record.noise_condition],
	['backend', (record) => record.metrics.backend],
	['provider_model', (record) => `${record.provider}/${record.model}`],
	[
		'language_noise_backend',
		(record) => `${record.language} / ${record.noise_condition} / ${record.metrics.backend}`,
	],
];

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function rejectUnknownAndMissingFields(value, allowedFields, field, errors) {
	if (!isObject(value)) return;
	for (const key of Object.keys(value)) {
		if (!allowedFields.has(key)) errors.push(`${field}.${key} is not allowed`);
	}
	for (const key of allowedFields) {
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
			if (
				normalized.includes('transcript') ||
				normalized.includes('hypothesis') ||
				normalized.includes('consent') ||
				(normalized.startsWith('reference') && normalized !== 'referencewords')
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
		metrics.inference_audio_seconds >
			metrics.audio_duration_seconds + MAX_INFERENCE_AUDIO_OVERRUN_SECONDS &&
		!approximatelyEqual(metrics.inference_audio_seconds, metrics.audio_duration_seconds)
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
	rejectUnknownAndMissingFields(report, RUN_REPORT_FIELDS, label, errors);
	if (report.schema_version !== 9) errors.push(`${label}.schema_version must be 9`);
	requireString(report.corpus_id, `${label}.corpus_id`, errors);
	requireSha256(report.corpus_fingerprint, `${label}.corpus_fingerprint`, errors);
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
	let reportMetricsIdentity;
	const checkedBenchmarkBindings = new Set();
	const sampleResultIndexes = new Map();
	for (const [index, result] of report.results.entries()) {
		const prefix = `${label}.results[${index}]`;
		if (!isObject(result)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		rejectUnknownAndMissingFields(result, RESULT_FIELDS, prefix, errors);
		for (const field of [
			'sample_id',
			'language',
			'noise_condition',
			'scenario',
			'provenance_basis',
		]) {
			requireString(result[field], `${prefix}.${field}`, errors);
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

function summarize(records) {
	const werRecords = records.filter((record) => record.reference_words !== null);
	const silenceRecords = records.filter((record) => record.reference_words === null);
	const referenceWords = werRecords.reduce((sum, record) => sum + record.reference_words, 0);
	const wordErrors = werRecords.reduce((sum, record) => sum + record.word_errors, 0);
	const rtfs = records.map((record) => record.metrics.inference_rtf);
	const modelRtfs = records
		.map((record) => record.metrics.model_inference_rtf)
		.filter((value) => value !== null);
	const peaks = records.map((record) => record.metrics.peak_rss_mb);
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
		max_inference_rtf: Math.max(...rtfs),
		aggregate_model_inference_rtf:
			inferenceAudioSeconds === 0 ? null : inferenceSeconds / inferenceAudioSeconds,
		mean_model_inference_rtf: modelRtfs.length === 0 ? null : mean(modelRtfs),
		median_model_inference_rtf: modelRtfs.length === 0 ? null : median(modelRtfs),
		max_model_inference_rtf: modelRtfs.length === 0 ? null : Math.max(...modelRtfs),
		mean_peak_rss_mb: mean(peaks),
		max_peak_rss_mb: Math.max(...peaks),
	};
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

export function aggregateRunReports(reports) {
	if (!Array.isArray(reports) || reports.length === 0)
		throw new Error('at least one run report is required');
	const records = [];
	let corpusId;
	let corpusFingerprint;
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
	for (const [index, report] of reports.entries()) {
		const errors = validateRunReport(report, `reports[${index}]`);
		if (errors.length > 0) throw new Error(`invalid benchmark report:\n- ${errors.join('\n- ')}`);
		if (corpusId === undefined) {
			corpusId = report.corpus_id;
			corpusFingerprint = report.corpus_fingerprint;
		} else if (report.corpus_id !== corpusId) {
			throw new Error(
				`cannot aggregate different corpora: '${corpusId}' and '${report.corpus_id}'`,
			);
		}
		if (report.corpus_fingerprint !== corpusFingerprint) {
			throw new Error('cannot aggregate reports from different corpus revisions');
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
			]);
			const source = `reports[${index}].results[${resultIndex}]`;
			const priorSource = measurementSources.get(measurementKey);
			if (priorSource !== undefined) {
				throw new Error(
					`cannot aggregate duplicate provider/model/backend/sample_id measurement ` +
						`${measurementKey} from ${priorSource} and ${source}`,
				);
			}
			measurementSources.set(measurementKey, source);
			records.push({ ...result, provider: report.provider, model: report.model });
		}
	}

	const groups = {};
	for (const [dimension, keyFor] of DIMENSIONS) {
		const grouped = new Map();
		for (const record of records) {
			const key = keyFor(record);
			if (!grouped.has(key)) grouped.set(key, []);
			grouped.get(key).push(record);
		}
		groups[dimension] = Object.fromEntries(
			[...grouped.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, values]) => [key, summarize(values)]),
		);
	}

	return {
		schema_version: 6,
		generated_at: new Date().toISOString(),
		corpus_id: corpusId,
		corpus_fingerprint: corpusFingerprint,
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
		sample_result_count: records.length,
		groups,
	};
}

function display(value, digits = 2) {
	return value === null ? '—' : value.toFixed(digits);
}

function escapeCell(value) {
	return value.replaceAll('|', '\\|');
}

export function renderMarkdown(report) {
	const lines = [
		'# ASR corpus benchmark',
		'',
		`Generated ${report.generated_at} from ${report.source_report_count} run report(s) and ${report.sample_result_count} sample result(s).`,
		'',
		`Corpus: \`${report.corpus_id}\``,
		'',
		`Corpus fingerprint: \`${report.corpus_fingerprint}\``,
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
		'WER is micro-averaged from total word errors / total reference words. Source-audio RTF divides inference time by original audio duration; model-input RTF divides it by the exact post-VAD audio passed to ASR. Memory is measured during local inference.',
	];
	for (const [dimension, groups] of Object.entries(report.groups)) {
		lines.push('', `## ${dimension.replaceAll('_', ' ')}`, '');
		lines.push(
			'| Group | Samples | Pass rate | WER | Aggregate source RTF | P50 source RTF | Aggregate model-input RTF | P50 model-input RTF | Max peak RSS | Hallucinated words |',
		);
		lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
		for (const [name, summary] of Object.entries(groups)) {
			const werCell = summary.wer_percent === null ? '—' : `${display(summary.wer_percent)}%`;
			lines.push(
				`| ${escapeCell(name)} | ${summary.samples} | ${display(summary.pass_rate_percent)}% | ${werCell} | ${display(summary.aggregate_inference_rtf, 3)} | ${display(summary.median_inference_rtf, 3)} | ${display(summary.aggregate_model_inference_rtf, 3)} | ${display(summary.median_model_inference_rtf, 3)} | ${display(summary.max_peak_rss_mb, 1)} MiB | ${summary.hallucinated_words_total} |`,
			);
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
				'Usage: nub report.ts <run.json>... [--manifest <path>] [--json <path>] [--markdown <path>]',
			);
		}
		if ((jsonOutput || markdownOutput) && !manifestPath) {
			throw new Error('--manifest is required when writing aggregate output files');
		}
		const reports = args.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
		const corpus = manifestPath ? loadCorpus(manifestPath) : null;
		if (corpus) {
			const bindingErrors = validateRunReportsAgainstCorpus(reports, corpus);
			if (bindingErrors.length > 0) {
				throw new Error(
					`benchmark reports do not match the corpus manifest:\n- ${bindingErrors.join('\n- ')}`,
				);
			}
		}
		const aggregate = aggregateRunReports(reports);
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
