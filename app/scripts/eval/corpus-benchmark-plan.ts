import { createHash } from 'node:crypto';
import path from 'node:path';

import {
	assertBenchmarkPlatform,
	benchmarkDefinitionForReportedBackend,
	evaluatorPlatformForTargetTriple,
} from './benchmark-executable.ts';
import {
	corpusFingerprint,
	isPublicDatasetId,
	isReferenceProtocolId,
	REFERENCE_PROTOCOL_IDS,
	validateCorpusDocument,
} from './corpus.ts';
import { resolveCoverageTarget } from './corpus-targets.ts';
import { evaluatorRevisionSha256, validateEvaluatorRevision } from './evaluator-revision.ts';
import { validateBenchmarkModelName } from './model-artifact.ts';
import {
	CAMPAIGN_RUN_REPORT_SCHEMA_VERSION,
	STANDALONE_RUN_REPORT_SCHEMA_VERSION,
	validateRunReport,
} from './report.ts';
import { WER_SCORER_ID } from './wer.ts';

const ACCELERATOR_BACKENDS = new Set(['metal', 'coreml-metal', 'cuda', 'vulkan', 'hipblas']);
const COMMON_EVALUATOR_REVISION_FIELDS = [
	'schema_version',
	'protocol_id',
	'git_commit',
	'cargo_lock_sha256',
	'rustc_vv',
	'build_profile',
	'target_triple',
	'build_env_sha256',
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// The VAD flush pads one final 16 kHz processing block, so model input can
// legitimately exceed decoded source duration by less than one 30 ms block.
const MAX_INFERENCE_AUDIO_OVERRUN_SECONDS = 0.03;
const PLANNING_CORPUS_FIELDS = new Set([
	'schema_version',
	'corpus_id',
	'reference_protocol_id',
	'description',
	'distribution',
	'source_catalog_sha256',
	'preparation',
	'samples',
	'corpus_fingerprint',
	'manifest_path',
]);
const SAFE_REFERENCE_WORDS_PATH = /^checkpoint\.results\[\d+\]\.reference_words$/;
const SAFE_REFERENCE_PROTOCOL_PATH = 'checkpoint.reference_protocol_id';
const CHECKPOINT_FIELDS = new Set([
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
	'benchmark_task_id',
	'repeat_index',
	'thresholds',
	'passed',
	'results',
]);
const THRESHOLD_FIELDS = new Set(['max_wer_percent', 'max_hallucinated_words']);
const RESULT_FIELDS = new Set([
	'sample_id',
	'dataset',
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
const NON_NEGATIVE_METRICS = [
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
const EVALUATOR_REVISION_ENTRY_FIELDS = new Set(['revision', 'sha256']);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, field) {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function positiveFiniteNumber(value, field) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive finite number`);
	}
	return value;
}

function nonNegativeInteger(value, field) {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value;
}

function normalizedRepeatIndex(value, field) {
	if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
		throw new Error(`${field} must be a safe integer from 1 through 10`);
	}
	return value;
}

function requireSha256(value, field) {
	if (!SHA256_PATTERN.test(value ?? '')) {
		throw new Error(`${field} must be a lowercase SHA-256 digest`);
	}
	return value;
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

function normalizeEvaluatorRevision(revision, digest, revisionField, digestField) {
	const revisionErrors = validateEvaluatorRevision(revision);
	if (revisionErrors.length > 0) {
		const mapped = revisionErrors.map((error) =>
			error.startsWith('evaluator_revision')
				? `${revisionField}${error.slice('evaluator_revision'.length)}`
				: `${revisionField}: ${error}`,
		);
		throw new Error(`invalid evaluator revision:\n- ${mapped.join('\n- ')}`);
	}
	const normalizedDigest = requireSha256(digest, digestField);
	const computedDigest = evaluatorRevisionSha256(revision);
	if (normalizedDigest !== computedDigest) {
		throw new Error(`${digestField} must match ${revisionField}`);
	}
	return {
		revision: copyEvaluatorRevision(revision),
		sha256: normalizedDigest,
	};
}

function assertEvaluatorRevisionBenchmarkBinding(revision, provider, targetBackend, field) {
	const definition = benchmarkDefinitionForReportedBackend(provider, targetBackend);
	if (
		revision.cargo_features.length !== definition.cargoFeatures.length ||
		revision.cargo_features.some((feature, index) => feature !== definition.cargoFeatures[index])
	) {
		throw new Error(
			`${field}.cargo_features must exactly match ` +
				`${definition.provider}/${definition.reportedBackend} ` +
				`(${JSON.stringify(definition.cargoFeatures)})`,
		);
	}
	const platform = evaluatorPlatformForTargetTriple(revision.target_triple);
	try {
		assertBenchmarkPlatform(
			definition.provider,
			definition.reportedBackend,
			platform.operatingSystem,
			platform.architecture,
		);
	} catch (error) {
		throw new Error(
			`${field}.target_triple is incompatible with ` +
				`${definition.provider}/${definition.reportedBackend}: ${error.message}`,
		);
	}
}

function normalizeEvaluatorRevisionEntry(value, field) {
	if (!isObject(value)) throw new Error(`${field} must be an object`);
	for (const key of Object.keys(value)) {
		if (!EVALUATOR_REVISION_ENTRY_FIELDS.has(key)) {
			throw new Error(`${field}.${key} is not allowed`);
		}
	}
	for (const key of EVALUATOR_REVISION_ENTRY_FIELDS) {
		if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key} is required`);
	}
	return normalizeEvaluatorRevision(
		value.revision,
		value.sha256,
		`${field}.revision`,
		`${field}.sha256`,
	);
}

function normalizeEvaluatorRevisions(evaluatorRevisions) {
	const entries =
		evaluatorRevisions instanceof Map
			? [...evaluatorRevisions.entries()]
			: isObject(evaluatorRevisions)
				? Object.entries(evaluatorRevisions)
				: null;
	if (!entries) {
		throw new Error('evaluatorRevisions must be an object or Map');
	}
	const normalized = new Map();
	for (const [backend, entry] of entries) {
		const targetBackend = requiredString(backend, 'evaluatorRevisions backend');
		normalized.set(
			targetBackend,
			normalizeEvaluatorRevisionEntry(entry, `evaluatorRevisions.${targetBackend}`),
		);
	}
	return normalized;
}

function normalizeThresholds(thresholds) {
	if (!isObject(thresholds)) throw new Error('thresholds must be an object');
	const maxWerPercent = thresholds.max_wer_percent;
	const maxHallucinatedWords = thresholds.max_hallucinated_words;
	if (typeof maxWerPercent !== 'number' || !Number.isFinite(maxWerPercent) || maxWerPercent < 0) {
		throw new Error('thresholds.max_wer_percent must be a non-negative finite number');
	}
	if (!Number.isInteger(maxHallucinatedWords) || maxHallucinatedWords < 0) {
		throw new Error('thresholds.max_hallucinated_words must be a non-negative integer');
	}
	return {
		max_wer_percent: maxWerPercent,
		max_hallucinated_words: maxHallucinatedWords,
	};
}

function normalizeAccelerator(value, field) {
	const accelerator = requiredString(value, field);
	if (/[;\r\n]/.test(accelerator)) {
		throw new Error(`${field} cannot contain semicolons or line breaks`);
	}
	if (accelerator.toLowerCase() === 'none') {
		throw new Error(`${field} must identify a real accelerator`);
	}
	return accelerator;
}

function normalizeAccelerators(accelerators) {
	if (accelerators === undefined || accelerators === null) return new Map();
	const entries =
		accelerators instanceof Map
			? [...accelerators.entries()]
			: isObject(accelerators)
				? Object.entries(accelerators)
				: null;
	if (!entries) throw new Error('accelerators must be an object or Map');
	const normalized = new Map();
	for (const [backend, value] of entries) {
		if (!ACCELERATOR_BACKENDS.has(backend)) {
			throw new Error(`accelerator backend '${backend}' is not a GPU target backend`);
		}
		normalized.set(backend, normalizeAccelerator(value, `accelerators.${backend}`));
	}
	return normalized;
}

function permitsAutomaticAccelerator(targetBackend, evaluatorRevision) {
	if (!['metal', 'coreml-metal'].includes(targetBackend)) return false;
	const platform = evaluatorPlatformForTargetTriple(evaluatorRevision.target_triple);
	return platform.operatingSystem === 'macos' && platform.architecture === 'aarch64';
}

function normalizeDataset(dataset, provenanceBasis, label) {
	if (provenanceBasis === 'public-license') {
		if (!isPublicDatasetId(dataset)) {
			throw new Error(`${label} must be fleurs, ami, or earnings21 for public-license samples`);
		}
		return dataset;
	}
	if (dataset !== undefined) {
		throw new Error(`${label} is only allowed for public-license samples`);
	}
	return undefined;
}

function matchesConfiguredAccelerator(actual, configured) {
	if (typeof actual !== 'string') return false;
	const prefix = `${configured} [ggml=`;
	return actual.startsWith(prefix) && actual.endsWith(']') && actual.length > prefix.length + 1;
}

function taskIdentity(task) {
	const mapping = resolveBenchmarkBackend(task.provider, task.target_backend);
	const thresholds = normalizeThresholds(task.thresholds);
	const evaluator = normalizeEvaluatorRevision(
		task.evaluator_revision,
		task.evaluator_revision_sha256,
		'task.evaluator_revision',
		'task.evaluator_revision_sha256',
	);
	assertEvaluatorRevisionBenchmarkBinding(
		evaluator.revision,
		mapping.provider,
		mapping.targetBackend,
		'task.evaluator_revision',
	);
	if (task.wer_scorer !== undefined && task.wer_scorer !== WER_SCORER_ID) {
		throw new Error(`task.wer_scorer must be '${WER_SCORER_ID}'`);
	}
	if (!isReferenceProtocolId(task.reference_protocol_id)) {
		throw new Error(
			`task.reference_protocol_id must be one of ${REFERENCE_PROTOCOL_IDS.map((id) => `'${id}'`).join(', ')}`,
		);
	}
	const accelerator =
		task.accelerator === null || task.accelerator === undefined
			? { mode: 'auto' }
			: {
					mode: 'explicit',
					value: normalizeAccelerator(task.accelerator, 'task.accelerator'),
				};
	if (task.real_run_backend !== undefined && task.real_run_backend !== mapping.realRunBackend) {
		throw new Error(
			`task.real_run_backend must be '${mapping.realRunBackend}' for ${task.provider}/${task.target_backend}`,
		);
	}
	const provenanceBasis = requiredString(task.provenance_basis, 'task.provenance_basis');
	const dataset = normalizeDataset(task.dataset, provenanceBasis, 'task.dataset');
	return {
		corpus_id: requiredString(task.corpus_id, 'task.corpus_id'),
		corpus_fingerprint: requireSha256(task.corpus_fingerprint, 'task.corpus_fingerprint'),
		reference_protocol_id: task.reference_protocol_id,
		target_id: requiredString(task.target_id, 'task.target_id'),
		wer_scorer: WER_SCORER_ID,
		evaluator_revision: evaluator.revision,
		evaluator_revision_sha256: evaluator.sha256,
		provider: mapping.provider,
		model: validateBenchmarkModelName(task.model),
		target_backend: mapping.targetBackend,
		sample_id: requiredString(task.sample_id, 'task.sample_id'),
		sample_revision_sha256: requireSha256(
			task.sample_revision_sha256,
			'task.sample_revision_sha256',
		),
		audio_sha256: requireSha256(task.audio_sha256, 'task.audio_sha256'),
		audio_duration_seconds: positiveFiniteNumber(
			task.audio_duration_seconds,
			'task.audio_duration_seconds',
		),
		session_id:
			task.session_id === null || task.session_id === undefined
				? null
				: requiredString(task.session_id, 'task.session_id'),
		language: requiredString(task.language, 'task.language'),
		target_language: requiredString(task.target_language, 'task.target_language'),
		noise_condition: requiredString(task.noise_condition, 'task.noise_condition'),
		scenario: requiredString(task.scenario, 'task.scenario'),
		speakers: nonNegativeInteger(task.speakers, 'task.speakers'),
		provenance_basis: provenanceBasis,
		...(dataset === undefined ? {} : { dataset }),
		repeat_index:
			task.repeat_index === undefined
				? 1
				: normalizedRepeatIndex(task.repeat_index, 'task.repeat_index'),
		thresholds,
		accelerator,
	};
}

function sha256(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function taskDigest(task) {
	return sha256(taskIdentity(task));
}

function normalizeReportIdentity(identity) {
	if (!isObject(identity)) throw new Error('report identity must be an object');
	return {
		model_artifact_sha256: requireSha256(
			identity.model_artifact_sha256,
			'report identity.model_artifact_sha256',
		),
		operating_system: requiredString(identity.operating_system, 'report identity.operating_system'),
		architecture: requiredString(identity.architecture, 'report identity.architecture'),
		hardware_profile: requiredString(identity.hardware_profile, 'report identity.hardware_profile'),
		accelerator: requiredString(identity.accelerator, 'report identity.accelerator'),
		benchmark_executable_sha256: requireSha256(
			identity.benchmark_executable_sha256,
			'report identity.benchmark_executable_sha256',
		),
	};
}

export function resolveBenchmarkBackend(provider, targetBackend) {
	const normalizedProvider = requiredString(provider, 'provider');
	const normalizedBackend = requiredString(targetBackend, 'target backend');
	const definition = benchmarkDefinitionForReportedBackend(normalizedProvider, normalizedBackend);
	return {
		provider: normalizedProvider,
		targetBackend: normalizedBackend,
		realRunBackend: definition.realRunBackend,
	};
}

export function taskReportFilename(task, reportIdentity = null) {
	const identity = taskIdentity(task);
	const baseDigest = sha256(identity);
	if (task.task_id !== undefined && task.task_id !== baseDigest) {
		throw new Error('task.task_id does not match its benchmark identity');
	}
	const prefix = `run-${identity.provider}-${identity.target_backend}`;
	if (reportIdentity === null || reportIdentity === undefined) {
		return `${prefix}-${baseDigest.slice(0, 16)}.run.json`;
	}
	const actualDigest = sha256({
		task_digest: baseDigest,
		report_identity: normalizeReportIdentity(reportIdentity),
	});
	return `${prefix}-${baseDigest.slice(0, 16)}-${actualDigest.slice(0, 16)}.run.json`;
}

function planningCorpusDocument(corpus) {
	for (const field of Object.keys(corpus)) {
		if (!PLANNING_CORPUS_FIELDS.has(field)) {
			throw new Error(`corpus.${field} is not an allowed field`);
		}
	}
	const samples = Array.isArray(corpus.samples)
		? corpus.samples.map((sample) => {
				if (!isObject(sample)) return sample;
				const { audio_file: _audioFile, reference_file: _referenceFile, ...source } = sample;
				return source;
			})
		: corpus.samples;
	const document = {
		schema_version: corpus.schema_version,
		corpus_id: corpus.corpus_id,
		reference_protocol_id: corpus.reference_protocol_id,
		description: corpus.description,
		distribution: corpus.distribution,
		...(corpus.source_catalog_sha256 === undefined
			? {}
			: { source_catalog_sha256: corpus.source_catalog_sha256 }),
		...(corpus.preparation === undefined
			? {}
			: { preparation: structuredClone(corpus.preparation) }),
		samples,
	};
	const manifestPath =
		typeof corpus.manifest_path === 'string'
			? path.resolve(corpus.manifest_path)
			: path.resolve('corpus-local.json');
	const errors = validateCorpusDocument(document, {
		manifestPath,
		checkFiles: false,
	});
	if (errors.length > 0) {
		throw new Error(`invalid planning corpus:\n- ${errors.join('\n- ')}`);
	}
	return document;
}

export function planCorpusBenchmarkTasks({
	corpus,
	targets,
	thresholds,
	accelerators = {},
	evaluatorRevisions,
}) {
	if (!isObject(corpus)) throw new Error('corpus must be an object');
	const planningCorpus = planningCorpusDocument(corpus);
	const corpusId = requiredString(corpus.corpus_id, 'corpus.corpus_id');
	const corpusFingerprintValue = requireSha256(
		corpus.corpus_fingerprint,
		'corpus.corpus_fingerprint',
	);
	if (corpusFingerprintValue !== corpusFingerprint(planningCorpus)) {
		throw new Error('corpus.corpus_fingerprint does not match the validated planning corpus');
	}
	const resolvedTarget = resolveCoverageTarget(
		{ ...planningCorpus, corpus_fingerprint: corpusFingerprintValue },
		targets,
	);
	const targetId = requiredString(targets.target_id, 'targets.target_id');
	const normalizedThresholds = normalizeThresholds(thresholds);
	const normalizedAccelerators = normalizeAccelerators(accelerators);
	const normalizedEvaluatorRevisions = normalizeEvaluatorRevisions(evaluatorRevisions);
	const plannedSamples = resolvedTarget.selected_samples.map(({ sample, target_language }) => {
		const sampleId = requiredString(sample.id, 'sample.id');
		const audioDurationSeconds = positiveFiniteNumber(
			sample.duration_seconds,
			`sample '${sampleId}'.duration_seconds`,
		);
		return {
			id: sampleId,
			session_id: sample.session_id ?? null,
			sample_revision_sha256: corpusFingerprint(sample),
			audio_sha256: requireSha256(
				sample.audio_sha256,
				`sample '${sampleId}'.audio_sha256`,
			),
			audio_duration_seconds: audioDurationSeconds,
			language: sample.language,
			target_language,
			noise_condition: sample.noise_condition,
			scenario: sample.scenario,
			speakers: sample.speakers,
			provenance_basis: sample.provenance.basis,
			...(sample.dataset === undefined ? {} : { dataset: sample.dataset }),
		};
	});

	const tasks = [];
	const variantKeys = new Set();
	const usedTargetBackends = new Set();
	let commonEvaluatorRevision = null;
	for (const [variantIndex, variant] of targets.benchmark_variants.entries()) {
		if (!isObject(variant)) {
			throw new Error(`targets.benchmark_variants[${variantIndex}] must be an object`);
		}
		const mapping = resolveBenchmarkBackend(variant.provider, variant.backend);
		const model = validateBenchmarkModelName(variant.model);
		const variantKey = `${mapping.provider}/${model}/${mapping.targetBackend}`;
		if (variantKeys.has(variantKey)) {
			throw new Error(`targets.benchmark_variants contains duplicate '${variantKey}'`);
		}
		variantKeys.add(variantKey);
		usedTargetBackends.add(mapping.targetBackend);
		const evaluator = normalizedEvaluatorRevisions.get(mapping.targetBackend);
		if (!evaluator) {
			throw new Error(
				`evaluatorRevisions.${mapping.targetBackend} is required by a benchmark variant`,
			);
		}
		const evaluatorCommon = Object.fromEntries(
			COMMON_EVALUATOR_REVISION_FIELDS.map((field) => [
				field,
				evaluator.revision[field],
			]),
		);
		if (commonEvaluatorRevision === null) {
			commonEvaluatorRevision = evaluatorCommon;
		} else {
			for (const field of COMMON_EVALUATOR_REVISION_FIELDS) {
				if (evaluatorCommon[field] !== commonEvaluatorRevision[field]) {
					throw new Error(
						`evaluator revisions use different common field '${field}'`,
					);
				}
			}
		}
		assertEvaluatorRevisionBenchmarkBinding(
			evaluator.revision,
			mapping.provider,
			mapping.targetBackend,
			`evaluatorRevisions.${mapping.targetBackend}.revision`,
		);
		const accelerator = normalizedAccelerators.get(mapping.targetBackend) ?? null;
		if (
			ACCELERATOR_BACKENDS.has(mapping.targetBackend) &&
			accelerator === null &&
			!permitsAutomaticAccelerator(mapping.targetBackend, evaluator.revision)
		) {
			throw new Error(
				`accelerators.${mapping.targetBackend} is required for ` +
					`${evaluator.revision.target_triple}`,
			);
		}
		for (const sample of plannedSamples) {
			for (let repeatIndex = 1; repeatIndex <= resolvedTarget.repetitions; repeatIndex += 1) {
				const task = {
					variant_index: variantIndex,
					corpus_id: corpusId,
					corpus_fingerprint: corpusFingerprintValue,
					reference_protocol_id: planningCorpus.reference_protocol_id,
					target_id: targetId,
					wer_scorer: WER_SCORER_ID,
					evaluator_revision: copyEvaluatorRevision(evaluator.revision),
					evaluator_revision_sha256: evaluator.sha256,
					provider: mapping.provider,
					model,
					target_backend: mapping.targetBackend,
					real_run_backend: mapping.realRunBackend,
					accelerator,
					sample_id: sample.id,
					sample_revision_sha256: sample.sample_revision_sha256,
					audio_sha256: sample.audio_sha256,
					audio_duration_seconds: sample.audio_duration_seconds,
					session_id: sample.session_id,
					language: sample.language,
					target_language: sample.target_language,
					noise_condition: sample.noise_condition,
					scenario: sample.scenario,
					speakers: sample.speakers,
					provenance_basis: sample.provenance_basis,
					...(sample.dataset === undefined ? {} : { dataset: sample.dataset }),
					repeat_index: repeatIndex,
					thresholds: { ...normalizedThresholds },
				};
				task.task_id = taskDigest(task);
				task.report_filename = taskReportFilename(task);
				tasks.push(task);
			}
		}
	}
	for (const backend of normalizedAccelerators.keys()) {
		if (!usedTargetBackends.has(backend)) {
			throw new Error(`accelerator backend '${backend}' is not used by a benchmark variant`);
		}
	}
	for (const backend of normalizedEvaluatorRevisions.keys()) {
		if (!usedTargetBackends.has(backend)) {
			throw new Error(`evaluator revision backend '${backend}' is not used by a benchmark variant`);
		}
	}
	return tasks;
}

function normalizedSensitiveKey(key) {
	return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveCheckpointKey(key, path) {
	const normalized = normalizedSensitiveKey(key);
	if (
		normalized.includes('transcript') ||
		normalized.includes('hypothesis') ||
		normalized.includes('consent')
	) {
		return true;
	}
	if (!normalized.startsWith('reference')) return false;
	if (normalized === 'referenceprotocolid' && path === SAFE_REFERENCE_PROTOCOL_PATH) return false;
	return normalized !== 'referencewords' || !SAFE_REFERENCE_WORDS_PATH.test(path);
}

function childPath(parent, key) {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
		? `${parent}.${key}`
		: `${parent}[${JSON.stringify(key)}]`;
}

export function sensitiveCheckpointKeyPaths(value) {
	const paths = [];
	const visited = new WeakSet();
	const visit = (current, currentPath) => {
		if (current === null || typeof current !== 'object') return;
		if (visited.has(current)) return;
		visited.add(current);
		if (Array.isArray(current)) {
			for (const [index, item] of current.entries()) visit(item, `${currentPath}[${index}]`);
			return;
		}
		for (const [key, item] of Object.entries(current)) {
			const path = childPath(currentPath, key);
			if (isSensitiveCheckpointKey(key, path)) paths.push(path);
			visit(item, path);
		}
	};
	visit(value, 'checkpoint');
	return paths;
}

function rejectUnknownFields(value, allowed, field, errors) {
	if (!isObject(value)) return;
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) errors.push(`${field}.${key} is not an allowed checkpoint field`);
	}
}

function isCanonicalTimestamp(value) {
	if (typeof value !== 'string') return false;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function finiteNonNegative(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function approximatelyEqual(left, right) {
	const tolerance = Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-6);
	return Math.abs(left - right) <= tolerance;
}

function validateCheckpointShape(report, errors) {
	if (!isObject(report)) return;
	rejectUnknownFields(report, CHECKPOINT_FIELDS, 'checkpoint', errors);
	if (!isCanonicalTimestamp(report.started_at)) {
		errors.push('checkpoint.started_at must be a canonical ISO-8601 timestamp');
	}
	if (!isCanonicalTimestamp(report.completed_at)) {
		errors.push('checkpoint.completed_at must be a canonical ISO-8601 timestamp');
	}
	if (
		isCanonicalTimestamp(report.started_at) &&
		isCanonicalTimestamp(report.completed_at) &&
		report.completed_at < report.started_at
	) {
		errors.push('checkpoint.completed_at must not precede checkpoint.started_at');
	}
	if (isObject(report.thresholds)) {
		rejectUnknownFields(report.thresholds, THRESHOLD_FIELDS, 'checkpoint.thresholds', errors);
	}
	if (!Array.isArray(report.results)) return;
	for (const [index, result] of report.results.entries()) {
		const prefix = `checkpoint.results[${index}]`;
		if (!isObject(result)) continue;
		rejectUnknownFields(result, RESULT_FIELDS, prefix, errors);
		const isWer = result.reference_words !== null || result.word_errors !== null;
		if (isWer) {
			if (!finiteNonNegative(result.wer_percent)) {
				errors.push(`${prefix}.wer_percent must be a non-negative finite number`);
			} else if (
				Number.isInteger(result.reference_words) &&
				result.reference_words > 0 &&
				Number.isInteger(result.word_errors) &&
				!approximatelyEqual(result.wer_percent, (result.word_errors / result.reference_words) * 100)
			) {
				errors.push(`${prefix}.wer_percent does not match word error counts`);
			}
			if (result.hallucinated_words !== null) {
				errors.push(`${prefix}.hallucinated_words must be null for WER samples`);
			}
		} else if (result.wer_percent !== null) {
			errors.push(`${prefix}.wer_percent must be null for non-WER samples`);
		}
		if (!isObject(result.metrics)) continue;
		rejectUnknownFields(result.metrics, METRICS_FIELDS, `${prefix}.metrics`, errors);
		for (const field of NON_NEGATIVE_METRICS) {
			if (!finiteNonNegative(result.metrics[field])) {
				errors.push(`${prefix}.metrics.${field} must be a non-negative finite number`);
			}
		}
		for (const field of ['operating_system', 'architecture', 'hardware_profile', 'accelerator']) {
			if (
				typeof result.metrics[field] === 'string' &&
				(result.metrics[field].includes('\0') || /[\r\n]/.test(result.metrics[field]))
			) {
				errors.push(`${prefix}.metrics.${field} must be a single-line identity`);
			}
		}
		if (
			finiteNonNegative(result.metrics.audio_duration_seconds) &&
			result.metrics.audio_duration_seconds > 0 &&
			finiteNonNegative(result.metrics.inference_seconds) &&
			finiteNonNegative(result.metrics.inference_rtf) &&
			!approximatelyEqual(
				result.metrics.inference_rtf,
				result.metrics.inference_seconds / result.metrics.audio_duration_seconds,
			)
		) {
			errors.push(`${prefix}.metrics.inference_rtf does not match inference duration`);
		}
		if (
			finiteNonNegative(result.metrics.audio_duration_seconds) &&
			result.metrics.audio_duration_seconds > 0 &&
			finiteNonNegative(result.metrics.inference_audio_seconds) &&
			result.metrics.inference_audio_seconds - result.metrics.audio_duration_seconds >
				MAX_INFERENCE_AUDIO_OVERRUN_SECONDS &&
			!approximatelyEqual(
				result.metrics.inference_audio_seconds - result.metrics.audio_duration_seconds,
				MAX_INFERENCE_AUDIO_OVERRUN_SECONDS,
			)
		) {
			errors.push(
				`${prefix}.metrics.inference_audio_seconds must not materially exceed source duration`,
			);
		}
		if (
			result.metrics.model_inference_rtf !== null &&
			!finiteNonNegative(result.metrics.model_inference_rtf)
		) {
			errors.push(
				`${prefix}.metrics.model_inference_rtf must be null or a non-negative finite number`,
			);
		}
		if (
			finiteNonNegative(result.metrics.inference_audio_seconds) &&
			result.metrics.inference_audio_seconds === 0
		) {
			if (result.metrics.model_inference_rtf !== null) {
				errors.push(
					`${prefix}.metrics.model_inference_rtf must be null when no audio reached the ASR model`,
				);
			}
			if (
				finiteNonNegative(result.metrics.inference_seconds) &&
				!approximatelyEqual(result.metrics.inference_seconds, 0)
			) {
				errors.push(
					`${prefix}.metrics.inference_seconds must be zero when no audio reached the ASR model`,
				);
			}
		} else if (
			finiteNonNegative(result.metrics.inference_audio_seconds) &&
			result.metrics.inference_audio_seconds > 0 &&
			finiteNonNegative(result.metrics.inference_seconds) &&
			finiteNonNegative(result.metrics.model_inference_rtf) &&
			!approximatelyEqual(
				result.metrics.model_inference_rtf,
				result.metrics.inference_seconds / result.metrics.inference_audio_seconds,
			)
		) {
			errors.push(`${prefix}.metrics.model_inference_rtf does not match model-input duration`);
		}
		if (
			finiteNonNegative(result.metrics.inference_audio_seconds) &&
			result.metrics.inference_audio_seconds > 0 &&
			result.metrics.model_inference_rtf === null
		) {
			errors.push(
				`${prefix}.metrics.model_inference_rtf must be present when audio reached the ASR model`,
			);
		}
		if (
			finiteNonNegative(result.metrics.baseline_rss_mb) &&
			finiteNonNegative(result.metrics.peak_rss_mb) &&
			result.metrics.peak_rss_mb < result.metrics.baseline_rss_mb
		) {
			errors.push(`${prefix}.metrics.peak_rss_mb must not be below baseline RSS`);
		}
		if (
			finiteNonNegative(result.metrics.baseline_rss_mb) &&
			finiteNonNegative(result.metrics.peak_rss_mb) &&
			finiteNonNegative(result.metrics.peak_rss_delta_mb) &&
			!approximatelyEqual(
				result.metrics.peak_rss_delta_mb,
				result.metrics.peak_rss_mb - result.metrics.baseline_rss_mb,
			)
		) {
			errors.push(`${prefix}.metrics.peak_rss_delta_mb does not match peak minus baseline`);
		}
	}
}

function checkpointTask(task) {
	const identity = taskIdentity(task);
	const taskId = sha256(identity);
	if (task.task_id !== undefined && task.task_id !== taskId) {
		throw new Error('task.task_id does not match its benchmark identity');
	}
	return {
		...identity,
		task_id: taskId,
		real_run_backend: resolveBenchmarkBackend(identity.provider, identity.target_backend)
			.realRunBackend,
		language: requiredString(task.language, 'task.language'),
		noise_condition: requiredString(task.noise_condition, 'task.noise_condition'),
		scenario: requiredString(task.scenario, 'task.scenario'),
		speakers: task.speakers,
		provenance_basis: requiredString(task.provenance_basis, 'task.provenance_basis'),
		explicit_accelerator:
			identity.accelerator.mode === 'explicit' ? identity.accelerator.value : null,
	};
}

function compareField(errors, actual, expected, field) {
	if (actual !== expected) {
		errors.push(`${field} must equal ${JSON.stringify(expected)}`);
	}
}

export function validateTaskCheckpoint(report, task, { expectedModelArtifactSha256 = null } = {}) {
	const errors = sensitiveCheckpointKeyPaths(report).map(
		(path) => `${path} is a forbidden sensitive checkpoint key`,
	);
	validateCheckpointShape(report, errors);
	let expected;
	try {
		expected = checkpointTask(task);
	} catch (error) {
		errors.push(`invalid benchmark task: ${error.message}`);
		return errors;
	}
	errors.push(...validateRunReport(report, 'checkpoint'));
	if (!isObject(report)) return errors;

	compareField(errors, report.corpus_id, expected.corpus_id, 'checkpoint.corpus_id');
	compareField(
		errors,
		report.corpus_fingerprint,
		expected.corpus_fingerprint,
		'checkpoint.corpus_fingerprint',
	);
	compareField(
		errors,
		report.reference_protocol_id,
		expected.reference_protocol_id,
		'checkpoint.reference_protocol_id',
	);
	compareField(errors, report.wer_scorer, WER_SCORER_ID, 'checkpoint.wer_scorer');
	compareField(
		errors,
		report.evaluator_revision_sha256,
		expected.evaluator_revision_sha256,
		'checkpoint.evaluator_revision_sha256',
	);
	if (
		validateEvaluatorRevision(report.evaluator_revision).length === 0 &&
		JSON.stringify(copyEvaluatorRevision(report.evaluator_revision)) !==
			JSON.stringify(expected.evaluator_revision)
	) {
		errors.push('checkpoint.evaluator_revision must match task.evaluator_revision');
	}
	compareField(errors, report.provider, expected.provider, 'checkpoint.provider');
	compareField(errors, report.model, expected.model, 'checkpoint.model');
	if (report.schema_version === CAMPAIGN_RUN_REPORT_SCHEMA_VERSION) {
		compareField(
			errors,
			report.benchmark_task_id,
			expected.task_id,
			'checkpoint.benchmark_task_id',
		);
		compareField(
			errors,
			report.repeat_index,
			expected.repeat_index,
			'checkpoint.repeat_index',
		);
	} else if (report.schema_version === STANDALONE_RUN_REPORT_SCHEMA_VERSION) {
		if (expected.repeat_index !== 1) {
			errors.push(
				'checkpoint.schema_version must be 11 for repeated campaign tasks because schema 10 ' +
					'does not bind the planned benchmark task identity',
			);
		}
		compareField(
			errors,
			report.repeat_index ?? 1,
			expected.repeat_index,
			'checkpoint.repeat_index',
		);
	}
	if (isObject(report.thresholds)) {
		compareField(
			errors,
			report.thresholds.max_wer_percent,
			expected.thresholds.max_wer_percent,
			'checkpoint.thresholds.max_wer_percent',
		);
		compareField(
			errors,
			report.thresholds.max_hallucinated_words,
			expected.thresholds.max_hallucinated_words,
			'checkpoint.thresholds.max_hallucinated_words',
		);
	}
	if (typeof report.passed !== 'boolean') {
		errors.push('checkpoint.passed must be boolean');
	}
	if (expectedModelArtifactSha256 !== null) {
		if (!SHA256_PATTERN.test(expectedModelArtifactSha256 ?? '')) {
			errors.push('expectedModelArtifactSha256 must be a lowercase SHA-256 digest');
		} else {
			compareField(
				errors,
				report.model_artifact_sha256,
				expectedModelArtifactSha256,
				'checkpoint.model_artifact_sha256',
			);
		}
	}
	if (!Array.isArray(report.results) || report.results.length !== 1) {
		errors.push('checkpoint.results must contain exactly one result');
		return errors;
	}
	const result = report.results[0];
	if (!isObject(result)) return errors;
	compareField(errors, result.sample_id, expected.sample_id, 'checkpoint.results[0].sample_id');
	compareField(errors, result.language, expected.language, 'checkpoint.results[0].language');
	compareField(
		errors,
		result.noise_condition,
		expected.noise_condition,
		'checkpoint.results[0].noise_condition',
	);
	compareField(errors, result.scenario, expected.scenario, 'checkpoint.results[0].scenario');
	compareField(errors, result.speakers, expected.speakers, 'checkpoint.results[0].speakers');
	compareField(
		errors,
		result.provenance_basis,
		expected.provenance_basis,
		'checkpoint.results[0].provenance_basis',
	);
	compareField(errors, result.dataset, expected.dataset, 'checkpoint.results[0].dataset');
	if (typeof report.passed === 'boolean' && typeof result.passed === 'boolean') {
		compareField(errors, report.passed, result.passed, 'checkpoint.passed');
	}
	if (
		expected.scenario === 'meeting' &&
		(result.reference_words === null || result.word_errors === null)
	) {
		errors.push('checkpoint.results[0] must contain WER counts for a meeting sample');
	}
	if (
		typeof result.passed === 'boolean' &&
		finiteNonNegative(result.wer_percent) &&
		result.wer_percent > expected.thresholds.max_wer_percent &&
		result.passed
	) {
		errors.push('checkpoint.results[0].passed cannot be true above the WER threshold');
	}
	if (!isObject(result.metrics)) return errors;
	compareField(
		errors,
		result.metrics.audio_sha256,
		expected.audio_sha256,
		'checkpoint.results[0].metrics.audio_sha256',
	);
	if (
		finiteNonNegative(result.metrics.audio_duration_seconds) &&
		!approximatelyEqual(
			result.metrics.audio_duration_seconds,
			expected.audio_duration_seconds,
		)
	) {
		errors.push(
			'checkpoint.results[0].metrics.audio_duration_seconds must match the planned corpus sample',
		);
	}
	compareField(
		errors,
		result.metrics.provider,
		expected.provider,
		'checkpoint.results[0].metrics.provider',
	);
	compareField(errors, result.metrics.model, expected.model, 'checkpoint.results[0].metrics.model');
	compareField(
		errors,
		result.metrics.backend,
		expected.target_backend,
		'checkpoint.results[0].metrics.backend',
	);
	if (expected.explicit_accelerator !== null) {
		if (
			!matchesConfiguredAccelerator(
				result.metrics.accelerator,
				expected.explicit_accelerator,
			)
		) {
			errors.push(
				'checkpoint.results[0].metrics.accelerator must bind the configured accelerator ' +
					`${JSON.stringify(expected.explicit_accelerator)} to a detected ggml device`,
			);
		}
	}
	return errors;
}

export function assertTaskCheckpoint(report, task, options = {}) {
	const errors = validateTaskCheckpoint(report, task, options);
	if (errors.length > 0) {
		throw new Error(`invalid benchmark checkpoint:\n- ${errors.join('\n- ')}`);
	}
	return report;
}

export function reportIdentityFromCheckpoint(report) {
	if (!isObject(report) || !Array.isArray(report.results) || report.results.length !== 1) {
		throw new Error('checkpoint must contain exactly one result');
	}
	const metrics = report.results[0]?.metrics;
	if (!isObject(metrics)) throw new Error('checkpoint result must contain metrics');
	const benchmarkExecutableSha256 = requireSha256(
		report.benchmark_executable_sha256,
		'checkpoint.benchmark_executable_sha256',
	);
	const metricsBenchmarkExecutableSha256 = requireSha256(
		metrics.benchmark_executable_sha256,
		'checkpoint.results[0].metrics.benchmark_executable_sha256',
	);
	if (benchmarkExecutableSha256 !== metricsBenchmarkExecutableSha256) {
		throw new Error('checkpoint benchmark executable digest must match its result metrics');
	}
	return normalizeReportIdentity({
		model_artifact_sha256: report.model_artifact_sha256,
		operating_system: metrics.operating_system,
		architecture: metrics.architecture,
		hardware_profile: metrics.hardware_profile,
		accelerator: metrics.accelerator,
		benchmark_executable_sha256: benchmarkExecutableSha256,
	});
}
