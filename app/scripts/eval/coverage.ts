#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeCorpusBoundJson } from './corpus-result.ts';
import { findDuplicateAudioSamples, loadCorpus } from './corpus.ts';
import {
	normalizeCoverageTargets,
	resolveCoverageTarget,
	validateCoverageTargets,
	variantKey,
} from './corpus-targets.ts';
import {
	CAMPAIGN_RUN_REPORT_SCHEMA_VERSION,
	modelArtifactBindingKey,
	validateRunReport,
	validateRunReportsAgainstCorpus,
} from './report.ts';

const MAX_MATRIX_HARDWARE_COHORTS = 4096;
const EVALUATOR_REVISION_COMMON_FIELDS = Object.freeze([
	'schema_version',
	'protocol_id',
	'git_commit',
	'cargo_lock_sha256',
	'rustc_vv',
	'build_profile',
	'target_triple',
	'build_env_sha256',
]);

export { normalizeCoverageTargets, validateCoverageTargets };

function hardwareCohort(metrics) {
	return {
		operating_system: metrics.operating_system,
		architecture: metrics.architecture,
		hardware_profile: metrics.hardware_profile,
		accelerator: metrics.accelerator,
	};
}

function hardwareCohortKey(cohort) {
	return JSON.stringify([
		cohort.operating_system,
		cohort.architecture,
		cohort.hardware_profile,
		cohort.accelerator,
	]);
}

function baseHardwareCohort(cohort) {
	return {
		operating_system: cohort.operating_system,
		architecture: cohort.architecture,
		hardware_profile: cohort.hardware_profile,
	};
}

function baseHardwareCohortKey(cohort) {
	return JSON.stringify([cohort.operating_system, cohort.architecture, cohort.hardware_profile]);
}

function addToMeasurementCell(map, key, metrics, unitId) {
	if (!map.has(key)) {
		map.set(key, {
			units: new Set(),
			cohorts: new Map(),
		});
	}
	const cell = map.get(key);
	cell.units.add(unitId);
	const cohort = hardwareCohort(metrics);
	const cohortKey = hardwareCohortKey(cohort);
	if (!cell.cohorts.has(cohortKey)) {
		cell.cohorts.set(cohortKey, {
			...cohort,
			units: new Set(),
		});
	}
	cell.cohorts.get(cohortKey).units.add(unitId);
}

function addBackendProvenance(map, backend, digest, kind) {
	const priorDigest = map.get(backend);
	if (priorDigest !== undefined && priorDigest !== digest) {
		throw new Error(`reports use different ${kind} for backend '${backend}'`);
	}
	map.set(backend, digest);
}

function requireCanonicalSampleMetadata(result, sample) {
	const canonicalMetadata = {
		language: sample.language,
		noise_condition: sample.noise_condition,
		scenario: sample.scenario,
		speakers: sample.speakers,
		provenance_basis: sample.provenance.basis,
	};
	for (const [field, expected] of Object.entries(canonicalMetadata)) {
		if (result[field] !== expected) {
			throw new Error(
				`report sample '${result.sample_id}' ${field} does not match the corpus manifest`,
			);
		}
	}
}

function sortedMapEntries(map) {
	return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function measurementCohorts(cell) {
	if (!cell) return [];
	return [...cell.cohorts.values()]
		.map(({ units, ...cohort }) => ({
			...cohort,
			distinct_units: units.size,
		}))
		.sort(
			(a, b) =>
				b.distinct_units - a.distinct_units ||
				a.operating_system.localeCompare(b.operating_system) ||
				a.architecture.localeCompare(b.architecture) ||
				a.hardware_profile.localeCompare(b.hardware_profile) ||
				a.accelerator.localeCompare(b.accelerator),
		);
}

function matrixHardwareCohorts(requiredCells, measurementCells) {
	const baseCohorts = new Map();
	const requiredBackends = [...new Set(requiredCells.map((cell) => cell.backend))].sort();
	for (const cell of requiredCells) {
		for (const cohort of measurementCells.get(cell.key)?.cohorts.values() ?? []) {
			const base = baseHardwareCohort(cohort);
			const baseKey = baseHardwareCohortKey(base);
			if (!baseCohorts.has(baseKey)) {
				baseCohorts.set(baseKey, {
					...base,
					acceleratorsByBackend: new Map(),
					cells: new Map(),
				});
			}
			const matrixCohort = baseCohorts.get(baseKey);
			if (!matrixCohort.acceleratorsByBackend.has(cell.backend)) {
				matrixCohort.acceleratorsByBackend.set(cell.backend, new Set());
			}
			matrixCohort.acceleratorsByBackend.get(cell.backend).add(cohort.accelerator);
			if (!matrixCohort.cells.has(cell.key)) matrixCohort.cells.set(cell.key, new Map());
			matrixCohort.cells.get(cell.key).set(cohort.accelerator, cohort.units);
		}
	}

	const sortedBaseCohorts = [...baseCohorts.values()].sort(
		(a, b) =>
			a.operating_system.localeCompare(b.operating_system) ||
			a.architecture.localeCompare(b.architecture) ||
			a.hardware_profile.localeCompare(b.hardware_profile),
	);
	const candidates = [];
	for (const cohort of sortedBaseCohorts) {
		let acceleratorMappings = [{}];
		for (const backend of requiredBackends) {
			const accelerators = [...(cohort.acceleratorsByBackend.get(backend) ?? new Set())].sort();
			const options = accelerators.length > 0 ? accelerators : [null];
			if (
				acceleratorMappings.length >
				Math.floor((MAX_MATRIX_HARDWARE_COHORTS - candidates.length) / options.length)
			) {
				throw new Error(
					`hardware matrix exceeds ${MAX_MATRIX_HARDWARE_COHORTS} candidate accelerator mappings; reduce distinct hardware profiles or accelerator identities`,
				);
			}
			acceleratorMappings = acceleratorMappings.flatMap((mapping) =>
				options.map((accelerator) => ({ ...mapping, [backend]: accelerator })),
			);
		}

		for (const accelerators of acceleratorMappings) {
			const counts = Object.fromEntries(
				requiredCells.map((cell) => [
					cell.key,
					accelerators[cell.backend] === null
						? 0
						: (cohort.cells.get(cell.key)?.get(accelerators[cell.backend])?.size ?? 0),
				]),
			);
			const missingCells = requiredCells
				.filter((cell) => counts[cell.key] < cell.minimum)
				.map((cell) => cell.key);
			candidates.push({
				operating_system: cohort.operating_system,
				architecture: cohort.architecture,
				hardware_profile: cohort.hardware_profile,
				accelerators,
				covered_cells: requiredCells.length - missingCells.length,
				required_cells: requiredCells.length,
				counts,
				missing_cells: missingCells,
			});
		}
	}
	return candidates;
}

export function evaluateCoverage(corpus, targets, reports = []) {
	const resolvedTarget = resolveCoverageTarget(corpus, targets);
	const reportBindingErrors = validateRunReportsAgainstCorpus(reports, corpus);
	if (reportBindingErrors.length > 0) {
		throw new Error(
			`benchmark reports do not match the corpus manifest:\n- ${reportBindingErrors.join('\n- ')}`,
		);
	}
	if (
		resolvedTarget.repetitions > 1 &&
		reports.some((report) => report.schema_version !== CAMPAIGN_RUN_REPORT_SCHEMA_VERSION)
	) {
		throw new Error(
			'repeated coverage requires schema-11 campaign reports with planned task identities',
		);
	}
	const duplicateAudio = findDuplicateAudioSamples(corpus.samples);
	if (duplicateAudio.length > 0) {
		const { first, duplicate } = duplicateAudio[0];
		throw new Error(`corpus samples '${first.id}' and '${duplicate.id}' reuse identical audio`);
	}
	const samplesById = new Map(corpus.samples.map((sample) => [sample.id, sample]));
	const eligibleSamples = resolvedTarget.selected_samples.map((descriptor) => descriptor.sample);
	const requiredCorpusCells = resolvedTarget.corpus_cells;
	const corpusCoverage = Object.fromEntries(
		requiredCorpusCells.map((cell) => [cell.key, cell.units.size]),
	);
	const missingCorpusCells = requiredCorpusCells.filter(
		(cell) => corpusCoverage[cell.key] < cell.minimum,
	).map((cell) => cell.key);

	const measurementCells = new Map();
	const modelArtifacts = new Map();
	const evaluatorRevisions = new Map();
	const benchmarkExecutables = new Map();
	const measurementKeys = new Set();
	const benchmarkTaskSources = new Map();
	let commonEvaluatorRevision;
	let werScorer;
	for (const [index, report] of reports.entries()) {
		const errors = validateRunReport(report, `reports[${index}]`);
		if (errors.length > 0) throw new Error(`invalid benchmark report:\n- ${errors.join('\n- ')}`);
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
					`duplicate benchmark_task_id '${report.benchmark_task_id}' binds ` +
						`${priorTask.measurement} in reports[${priorTask.index}] and ` +
						`${taskMeasurement} in reports[${index}]`,
				);
			}
			benchmarkTaskSources.set(report.benchmark_task_id, {
				index,
				measurement: taskMeasurement,
			});
		}
		if (report.corpus_id !== corpus.corpus_id) {
			throw new Error(
				`report corpus '${report.corpus_id}' does not match manifest corpus '${corpus.corpus_id}'`,
			);
		}
		if (report.corpus_fingerprint !== corpus.corpus_fingerprint) {
			throw new Error(`report corpus fingerprint does not match the current manifest revision`);
		}
		if (werScorer === undefined) {
			werScorer = report.wer_scorer;
		} else if (report.wer_scorer !== werScorer) {
			throw new Error('reports use different WER scorers');
		}
		if (commonEvaluatorRevision === undefined) {
			commonEvaluatorRevision = Object.fromEntries(
				EVALUATOR_REVISION_COMMON_FIELDS.map((field) => [field, report.evaluator_revision[field]]),
			);
		} else {
			for (const field of EVALUATOR_REVISION_COMMON_FIELDS) {
				if (report.evaluator_revision[field] !== commonEvaluatorRevision[field]) {
					throw new Error(`reports use different evaluator revision field '${field}'`);
				}
			}
		}
		const reportBackend = report.results[0].metrics.backend;
		const modelKey = modelArtifactBindingKey(
			report.provider,
			report.model,
			reportBackend,
		);
		const priorArtifact = modelArtifacts.get(modelKey);
		if (priorArtifact !== undefined && priorArtifact !== report.model_artifact_sha256) {
			throw new Error(`reports use different artifacts for model '${modelKey}'`);
		}
		modelArtifacts.set(modelKey, report.model_artifact_sha256);
		const repeatIndex = report.repeat_index ?? 1;
		const reportVariantKey = variantKey(report.provider, report.model, reportBackend);
		for (const result of report.results) {
			const sample = samplesById.get(result.sample_id);
			if (!sample)
				throw new Error(`report sample '${result.sample_id}' is absent from the corpus manifest`);
			requireCanonicalSampleMetadata(result, sample);
			const measurementIdentityKey = [
				report.provider,
				report.model,
				result.metrics.backend,
				result.sample_id,
				repeatIndex,
			].join('\0');
			if (measurementKeys.has(measurementIdentityKey)) {
				throw new Error(
					`duplicate measurement for ${report.provider}/${report.model}/${result.metrics.backend} sample '${result.sample_id}'`,
				);
			}
			measurementKeys.add(measurementIdentityKey);
			addBackendProvenance(
				evaluatorRevisions,
				result.metrics.backend,
				report.evaluator_revision_sha256,
				'evaluator revisions',
			);
			addBackendProvenance(
				benchmarkExecutables,
				result.metrics.backend,
				result.metrics.benchmark_executable_sha256,
				'benchmark executables',
			);
			const descriptor = resolvedTarget.selected_by_id.get(sample.id);
			const measurementCell = resolvedTarget.measurement_cell_lookup.get(
				`${reportVariantKey}\0${sample.id}\0${repeatIndex}`,
			);
			if (!descriptor || !measurementCell) continue;
			addToMeasurementCell(
				measurementCells,
				measurementCell.key,
				result.metrics,
				descriptor.unit_id,
			);
		}
	}

	const requiredMeasurementCells = resolvedTarget.measurement_cells;
	const measurementCoverage = Object.fromEntries(
		requiredMeasurementCells.map(({ key }) => [key, measurementCells.get(key)?.units.size ?? 0]),
	);
	const measurementHardwareCohorts = Object.fromEntries(
		requiredMeasurementCells.map(({ key }) => [key, measurementCohorts(measurementCells.get(key))]),
	);
	const compatibleMeasurementCoverage = Object.fromEntries(
		requiredMeasurementCells.map(({ key }) => [
			key,
			measurementHardwareCohorts[key][0]?.distinct_units ?? 0,
		]),
	);
	const missingMeasurementCells = requiredMeasurementCells
		.filter(
			(cell) => compatibleMeasurementCoverage[cell.key] < cell.minimum,
		)
		.map(({ key }) => key);
	const hardwareSplitMeasurementCells = requiredMeasurementCells
		.filter(
			(cell) =>
				measurementCoverage[cell.key] >= cell.minimum &&
				compatibleMeasurementCoverage[cell.key] < cell.minimum,
		)
		.map(({ key }) => key);
	const measurementMatrixHardwareCohorts = matrixHardwareCohorts(
		requiredMeasurementCells,
		measurementCells,
	);
	const completeMatrixHardwareCohorts = measurementMatrixHardwareCohorts.filter(
		(cohort) => cohort.missing_cells.length === 0,
	).length;

	return {
		schema_version: 12,
		target_id: targets.target_id,
		coverage_mode: resolvedTarget.coverage_mode,
		repetitions: resolvedTarget.repetitions,
		corpus_id: corpus.corpus_id,
		corpus_fingerprint: corpus.corpus_fingerprint,
		...(targets.source_catalog_sha256 === undefined
			? {}
			: { source_catalog_sha256: corpus.source_catalog_sha256 }),
		...(targets.selection_sha256 === undefined
			? {}
			: { selection_sha256: corpus.preparation.selection_sha256 }),
		reference_protocol_id: corpus.reference_protocol_id,
		wer_scorer: werScorer ?? null,
		model_artifacts: sortedMapEntries(modelArtifacts),
		evaluator_revision_sha256_by_backend: sortedMapEntries(evaluatorRevisions),
		benchmark_executable_sha256_by_backend: sortedMapEntries(benchmarkExecutables),
		minimum_distinct_sessions_per_cell:
			resolvedTarget.coverage_mode === 'language-noise-matrix'
				? targets.min_sessions_per_language_noise_cell
				: null,
		eligible_samples: eligibleSamples.length,
		participant_meeting_samples: eligibleSamples.filter(
			(sample) => sample.scenario === 'meeting' && sample.provenance.basis === 'participant-consent',
		).length,
		participant_meeting_sessions: new Set(
			eligibleSamples
				.filter(
					(sample) =>
						sample.scenario === 'meeting' && sample.provenance.basis === 'participant-consent',
				)
				.map((sample) => sample.session_id),
		).size,
		corpus: {
			unit_kind:
				resolvedTarget.coverage_mode === 'language-noise-matrix' ? 'session' : 'sample',
			covered_cells: requiredCorpusCells.length - missingCorpusCells.length,
			required_cells: requiredCorpusCells.length,
			counts: corpusCoverage,
			missing_cells: missingCorpusCells,
		},
		measurements: {
			unit_kind:
				resolvedTarget.coverage_mode === 'language-noise-matrix' ? 'session' : 'sample',
			reports: reports.length,
			covered_cells: requiredMeasurementCells.length - missingMeasurementCells.length,
			required_cells: requiredMeasurementCells.length,
			counts: measurementCoverage,
			compatible_counts: compatibleMeasurementCoverage,
			hardware_cohorts: measurementHardwareCohorts,
			hardware_split_cells: hardwareSplitMeasurementCells,
			missing_cells: missingMeasurementCells,
			matrix_hardware_cohorts: measurementMatrixHardwareCohorts,
			complete_matrix_hardware_cohorts: completeMatrixHardwareCohorts,
		},
		complete: missingCorpusCells.length === 0 && completeMatrixHardwareCohorts > 0,
	};
}

export function formatCoverage(coverage) {
	const summarizeMissing = (cells) => {
		const visible = cells.slice(0, 8).join(', ');
		return cells.length > 8 ? `${visible}, … +${cells.length - 8} more` : visible;
	};
	const lines = [
		`${coverage.target_id} on ${coverage.corpus_id}`,
		`Reference protocol: ${coverage.reference_protocol_id}`,
		`Coverage mode: ${coverage.coverage_mode}`,
		coverage.coverage_mode === 'language-noise-matrix'
			? `Distinct participant meeting sessions: ${coverage.participant_meeting_sessions}`
			: `Explicit target samples: ${coverage.eligible_samples}`,
		`Corpus cells: ${coverage.corpus.covered_cells}/${coverage.corpus.required_cells}`,
		`Measurement cells: ${coverage.measurements.covered_cells}/${coverage.measurements.required_cells} (best compatible cohort per cell)`,
		`Full-matrix hardware cohorts: ${coverage.measurements.complete_matrix_hardware_cohorts}/${coverage.measurements.matrix_hardware_cohorts.length}`,
	];
	if (coverage.corpus.missing_cells.length > 0) {
		lines.push(`Missing corpus cells: ${summarizeMissing(coverage.corpus.missing_cells)}`);
	}
	if (coverage.measurements.missing_cells.length > 0) {
		lines.push(
			`Missing measurement cells: ${summarizeMissing(coverage.measurements.missing_cells)}`,
		);
	}
	if (coverage.measurements.hardware_split_cells.length > 0) {
		lines.push(
			`Hardware-split measurement cells: ${summarizeMissing(coverage.measurements.hardware_split_cells)}`,
		);
	}
	return `${lines.join('\n')}\n`;
}

function requiredFlagValue(args, index, name) {
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
	return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const args = process.argv.slice(2);
		let manifestPath = path.join(here, 'corpus-local.json');
		let targetsPath = path.join(here, 'corpus-targets.json');
		let jsonOutput = null;
		let requireComplete = false;
		const reportPaths = [];
		for (let index = 0; index < args.length; index += 1) {
			switch (args[index]) {
				case '--manifest':
					manifestPath = requiredFlagValue(args, index, '--manifest');
					index += 1;
					break;
				case '--targets':
					targetsPath = requiredFlagValue(args, index, '--targets');
					index += 1;
					break;
				case '--report':
					reportPaths.push(requiredFlagValue(args, index, '--report'));
					index += 1;
					break;
				case '--json':
					jsonOutput = requiredFlagValue(args, index, '--json');
					index += 1;
					break;
				case '--require-complete':
					requireComplete = true;
					break;
				default:
					throw new Error(`unknown option: ${args[index]}`);
			}
		}
		const corpus = loadCorpus(manifestPath);
		const targets = JSON.parse(fs.readFileSync(path.resolve(targetsPath), 'utf8'));
		const reports = reportPaths.map((reportPath) =>
			JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')),
		);
		const coverage = evaluateCoverage(corpus, targets, reports);
		process.stdout.write(formatCoverage(coverage));
		if (jsonOutput) {
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpus.corpus_fingerprint,
				outputPath: jsonOutput,
				value: coverage,
			});
		}
		if (requireComplete && !coverage.complete) process.exit(1);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
}
