import { benchmarkDefinitionForReportedBackend } from './benchmark-executable.ts';
import { REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { validateBenchmarkModelName } from './model-artifact.ts';

export const COVERAGE_TARGET_SCHEMA_VERSION = 3;
const LEGACY_MATRIX_TARGET_SCHEMA_VERSION = 2;

const COVERAGE_MODES = new Set(['language-noise-matrix', 'explicit-samples']);
const COMMON_TARGET_FIELDS = new Set([
	'schema_version',
	'target_id',
	'reference_protocol_id',
	'description',
	'coverage_mode',
	'benchmark_variants',
	'repetitions',
]);
const MODE_TARGET_FIELDS = {
	'language-noise-matrix': new Set([
		'languages',
		'noise_conditions',
		'min_sessions_per_language_noise_cell',
	]),
	'explicit-samples': new Set(['sample_ids']),
};
const LEGACY_MATRIX_TARGET_FIELDS = new Set([
	'schema_version',
	'target_id',
	'reference_protocol_id',
	'description',
	'languages',
	'noise_conditions',
	'benchmark_variants',
	'min_sessions_per_language_noise_cell',
]);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSlugList(value, field, errors, pattern) {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${field} must be a non-empty array`);
		return;
	}
	const seen = new Set();
	for (const item of value) {
		if (typeof item !== 'string' || !pattern.test(item)) {
			errors.push(`${field} may only contain lowercase slug values`);
			continue;
		}
		if (seen.has(item)) errors.push(`${field} contains duplicate '${item}'`);
		seen.add(item);
	}
}

function validateBenchmarkVariants(value, errors) {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push('targets.benchmark_variants must be a non-empty array');
		return;
	}
	const seenVariants = new Set();
	for (const [index, variant] of value.entries()) {
		const prefix = `targets.benchmark_variants[${index}]`;
		if (!isObject(variant)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		const validSlugs = new Set();
		for (const field of Object.keys(variant)) {
			if (!['provider', 'model', 'backend'].includes(field)) {
				errors.push(`${prefix}.${field} is not an allowed field`);
			}
		}
		for (const field of ['provider', 'backend']) {
			if (
				typeof variant[field] !== 'string' ||
				!/^[a-z0-9][a-z0-9._-]*$/.test(variant[field])
			) {
				errors.push(`${prefix}.${field} must be a lowercase model slug`);
			} else {
				validSlugs.add(field);
			}
		}
		try {
			validateBenchmarkModelName(variant.model);
			validSlugs.add('model');
		} catch {
			errors.push(`${prefix}.model must be a bounded portable lowercase model slug`);
		}
		if (validSlugs.has('provider') && validSlugs.has('backend')) {
			try {
				benchmarkDefinitionForReportedBackend(variant.provider, variant.backend);
			} catch (error) {
				errors.push(`${prefix}: ${error.message}`);
			}
		}
		const key = variantKey(variant.provider, variant.model, variant.backend);
		if (seenVariants.has(key)) errors.push(`${prefix} duplicates '${key}'`);
		seenVariants.add(key);
	}
}

function validateCurrentCoverageTargets(targets) {
	const errors = [];
	if (!isObject(targets)) return ['coverage targets must be a JSON object'];
	const modeFields = MODE_TARGET_FIELDS[targets.coverage_mode] ?? new Set();
	const allowedFields = new Set([...COMMON_TARGET_FIELDS, ...modeFields]);
	for (const field of Object.keys(targets)) {
		if (!allowedFields.has(field)) errors.push(`targets.${field} is not an allowed field`);
	}
	if (targets.schema_version !== COVERAGE_TARGET_SCHEMA_VERSION) {
		errors.push(`targets.schema_version must be ${COVERAGE_TARGET_SCHEMA_VERSION}`);
	}
	if (targets.reference_protocol_id !== REFERENCE_PROTOCOL_ID) {
		errors.push(`targets.reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`);
	}
	if (typeof targets.target_id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(targets.target_id)) {
		errors.push('targets.target_id must be a lowercase slug');
	}
	if (
		targets.description !== undefined &&
		(typeof targets.description !== 'string' || targets.description.trim().length === 0)
	) {
		errors.push('targets.description must be a non-empty string when present');
	}
	if (!COVERAGE_MODES.has(targets.coverage_mode)) {
		errors.push('targets.coverage_mode must be language-noise-matrix or explicit-samples');
	}
	if (
		targets.repetitions !== undefined &&
		(!Number.isSafeInteger(targets.repetitions) || targets.repetitions < 1 || targets.repetitions > 10)
	) {
		errors.push('targets.repetitions must be a safe integer from 1 through 10');
	}
	validateBenchmarkVariants(targets.benchmark_variants, errors);

	if (targets.coverage_mode === 'language-noise-matrix') {
		validateSlugList(targets.languages, 'targets.languages', errors, /^[a-z]{2,3}$/);
		validateSlugList(
			targets.noise_conditions,
			'targets.noise_conditions',
			errors,
			/^[a-z0-9][a-z0-9-]*$/,
		);
		if (
			!Number.isInteger(targets.min_sessions_per_language_noise_cell) ||
			targets.min_sessions_per_language_noise_cell < 1
		) {
			errors.push('targets.min_sessions_per_language_noise_cell must be a positive integer');
		}
	} else if (targets.coverage_mode === 'explicit-samples') {
		validateSlugList(targets.sample_ids, 'targets.sample_ids', errors, /^[a-z0-9][a-z0-9-]*$/);
	}
	return errors;
}

export function normalizeCoverageTargets(targets) {
	if (!isObject(targets) || targets.schema_version !== LEGACY_MATRIX_TARGET_SCHEMA_VERSION) {
		return targets;
	}
	return {
		...targets,
		schema_version: COVERAGE_TARGET_SCHEMA_VERSION,
		coverage_mode: 'language-noise-matrix',
	};
}

export function validateCoverageTargets(targets) {
	if (!isObject(targets) || targets.schema_version !== LEGACY_MATRIX_TARGET_SCHEMA_VERSION) {
		return validateCurrentCoverageTargets(targets);
	}
	const errors = [];
	for (const field of Object.keys(targets)) {
		if (!LEGACY_MATRIX_TARGET_FIELDS.has(field)) {
			errors.push(`targets.${field} is not an allowed field in schema 2`);
		}
	}
	return [...errors, ...validateCurrentCoverageTargets(normalizeCoverageTargets(targets))];
}

export function primaryLanguage(language) {
	return language.split('-')[0].toLowerCase();
}

export function variantKey(provider, model, backend) {
	return `${provider}/${model}/${backend}`;
}

function matrixCellKey(language, noiseCondition) {
	return `${language} / ${noiseCondition}`;
}

function repeatSuffix(repetitions, repeatIndex) {
	return repetitions === 1 ? '' : ` / repeat ${repeatIndex}`;
}

function matrixMeasurementKey(cell, variant, repetitions, repeatIndex) {
	return `${cell} / ${variant.provider} / ${variant.model} / ${variant.backend}${repeatSuffix(repetitions, repeatIndex)}`;
}

function explicitMeasurementKey(sampleId, variant, repetitions, repeatIndex) {
	return `${sampleId} / ${variant.provider} / ${variant.model} / ${variant.backend}${repeatSuffix(repetitions, repeatIndex)}`;
}

function compareMatrixSamples(left, right) {
	return left.session_id.localeCompare(right.session_id) || left.id.localeCompare(right.id);
}

function sampleDescriptor(sample, coverageKey, unitId) {
	return {
		sample,
		target_language: primaryLanguage(sample.language),
		coverage_key: coverageKey,
		unit_id: unitId,
	};
}

export function resolveCoverageTarget(corpus, targets) {
	const targetErrors = validateCoverageTargets(targets);
	if (targetErrors.length > 0) {
		throw new Error(`invalid coverage targets:\n- ${targetErrors.join('\n- ')}`);
	}
	targets = normalizeCoverageTargets(targets);
	if (!isObject(corpus) || !Array.isArray(corpus.samples)) {
		throw new Error('corpus must contain a samples array');
	}
	if (corpus.reference_protocol_id !== targets.reference_protocol_id) {
		throw new Error('coverage targets reference protocol does not match the corpus manifest');
	}
	const samplesById = new Map();
	for (const sample of corpus.samples) {
		if (!isObject(sample) || typeof sample.id !== 'string') continue;
		if (samplesById.has(sample.id)) throw new Error(`corpus sample id '${sample.id}' is duplicated`);
		samplesById.set(sample.id, sample);
	}

	const repetitions = targets.repetitions ?? 1;
	const selectedSamples = [];
	const corpusCells = [];
	if (targets.coverage_mode === 'language-noise-matrix') {
		const byCell = new Map();
		for (const sample of corpus.samples) {
			if (
				!isObject(sample) ||
				sample.scenario !== 'meeting' ||
				sample.provenance?.basis !== 'participant-consent' ||
				typeof sample.language !== 'string' ||
				typeof sample.noise_condition !== 'string' ||
				typeof sample.session_id !== 'string'
			) {
				continue;
			}
			const key = matrixCellKey(primaryLanguage(sample.language), sample.noise_condition);
			if (!byCell.has(key)) byCell.set(key, []);
			byCell.get(key).push(sample);
		}
		for (const language of targets.languages) {
			for (const noiseCondition of targets.noise_conditions) {
				const key = matrixCellKey(language, noiseCondition);
				const samples = [...(byCell.get(key) ?? [])].sort(compareMatrixSamples);
				const descriptors = samples.map((sample) =>
					sampleDescriptor(sample, key, sample.session_id),
				);
				selectedSamples.push(...descriptors);
				corpusCells.push({
					key,
					minimum: targets.min_sessions_per_language_noise_cell,
					unit_kind: 'session',
					units: new Set(descriptors.map((descriptor) => descriptor.unit_id)),
				});
			}
		}
	} else {
		for (const sampleId of targets.sample_ids) {
			const sample = samplesById.get(sampleId);
			if (!sample) throw new Error(`target sample '${sampleId}' is absent from the corpus manifest`);
			const descriptor = sampleDescriptor(sample, sampleId, sampleId);
			selectedSamples.push(descriptor);
			corpusCells.push({
				key: sampleId,
				minimum: 1,
				unit_kind: 'sample',
				units: new Set([sampleId]),
			});
		}
	}

	const selectedById = new Map(selectedSamples.map((descriptor) => [descriptor.sample.id, descriptor]));
	const variantsByKey = new Map(
		targets.benchmark_variants.map((variant) => [
			variantKey(variant.provider, variant.model, variant.backend),
			variant,
		]),
	);
	const measurementCells = [];
	const measurementCellLookup = new Map();
	if (targets.coverage_mode === 'language-noise-matrix') {
		for (const corpusCell of corpusCells) {
			for (const variant of targets.benchmark_variants) {
				const exactVariantKey = variantKey(variant.provider, variant.model, variant.backend);
				for (let repeatIndex = 1; repeatIndex <= repetitions; repeatIndex += 1) {
					const cell = {
						key: matrixMeasurementKey(corpusCell.key, variant, repetitions, repeatIndex),
						backend: variant.backend,
						minimum: corpusCell.minimum,
						unit_kind: corpusCell.unit_kind,
						repeat_index: repeatIndex,
						units: new Set(),
					};
					measurementCells.push(cell);
					for (const descriptor of selectedSamples) {
						if (descriptor.coverage_key !== corpusCell.key) continue;
						measurementCellLookup.set(
							`${exactVariantKey}\0${descriptor.sample.id}\0${repeatIndex}`,
							cell,
						);
					}
				}
			}
		}
	} else {
		for (const descriptor of selectedSamples) {
			for (const variant of targets.benchmark_variants) {
				const exactVariantKey = variantKey(variant.provider, variant.model, variant.backend);
				for (let repeatIndex = 1; repeatIndex <= repetitions; repeatIndex += 1) {
					const cell = {
						key: explicitMeasurementKey(
							descriptor.sample.id,
							variant,
							repetitions,
							repeatIndex,
						),
						backend: variant.backend,
						minimum: 1,
						unit_kind: 'sample',
						repeat_index: repeatIndex,
						units: new Set(),
					};
					measurementCells.push(cell);
					measurementCellLookup.set(
						`${exactVariantKey}\0${descriptor.sample.id}\0${repeatIndex}`,
						cell,
					);
				}
			}
		}
	}

	return {
		coverage_mode: targets.coverage_mode,
		repetitions,
		selected_samples: selectedSamples,
		selected_by_id: selectedById,
		corpus_cells: corpusCells,
		measurement_cells: measurementCells,
		variants_by_key: variantsByKey,
		measurement_cell_lookup: measurementCellLookup,
	};
}
