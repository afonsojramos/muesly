#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findDuplicateAudioSamples, loadCorpus } from './corpus.mjs';
import { validateRunReport } from './report.mjs';

const TARGET_FIELDS = new Set([
	'schema_version',
	'target_id',
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

export function validateCoverageTargets(targets) {
	const errors = [];
	if (!isObject(targets)) return ['coverage targets must be a JSON object'];
	for (const field of Object.keys(targets)) {
		if (!TARGET_FIELDS.has(field)) errors.push(`targets.${field} is not an allowed field`);
	}
	if (targets.schema_version !== 1) errors.push('targets.schema_version must be 1');
	if (typeof targets.target_id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(targets.target_id)) {
		errors.push('targets.target_id must be a lowercase slug');
	}
	validateSlugList(targets.languages, 'targets.languages', errors, /^[a-z]{2,3}$/);
	validateSlugList(
		targets.noise_conditions,
		'targets.noise_conditions',
		errors,
		/^[a-z0-9][a-z0-9-]*$/,
	);
	if (!Array.isArray(targets.benchmark_variants) || targets.benchmark_variants.length === 0) {
		errors.push('targets.benchmark_variants must be a non-empty array');
	} else {
		const seenVariants = new Set();
		for (const [index, variant] of targets.benchmark_variants.entries()) {
			const prefix = `targets.benchmark_variants[${index}]`;
			if (!isObject(variant)) {
				errors.push(`${prefix} must be an object`);
				continue;
			}
			for (const field of Object.keys(variant)) {
				if (!['provider', 'model', 'backend'].includes(field)) {
					errors.push(`${prefix}.${field} is not an allowed field`);
				}
			}
			for (const field of ['provider', 'model', 'backend']) {
				if (
					typeof variant[field] !== 'string' ||
					!/^[a-z0-9][a-z0-9._-]*$/.test(variant[field])
				) {
					errors.push(`${prefix}.${field} must be a lowercase model slug`);
				}
			}
			const key = `${variant.provider}/${variant.model}/${variant.backend}`;
			if (seenVariants.has(key)) errors.push(`${prefix} duplicates '${key}'`);
			seenVariants.add(key);
		}
	}
	if (
		!Number.isInteger(targets.min_sessions_per_language_noise_cell) ||
		targets.min_sessions_per_language_noise_cell < 1
	) {
		errors.push('targets.min_sessions_per_language_noise_cell must be a positive integer');
	}
	return errors;
}

function primaryLanguage(language) {
	return language.split('-')[0].toLowerCase();
}

function cellKey(language, noiseCondition) {
	return `${language} / ${noiseCondition}`;
}

function measurementKey(language, noiseCondition, provider, model, backend) {
	return `${language} / ${noiseCondition} / ${provider} / ${model} / ${backend}`;
}

function addToCell(map, key, sessionId) {
	if (!map.has(key)) map.set(key, new Set());
	map.get(key).add(sessionId);
}

export function evaluateCoverage(corpus, targets, reports = []) {
	const targetErrors = validateCoverageTargets(targets);
	if (targetErrors.length > 0) {
		throw new Error(`invalid coverage targets:\n- ${targetErrors.join('\n- ')}`);
	}
	const duplicateAudio = findDuplicateAudioSamples(corpus.samples);
	if (duplicateAudio.length > 0) {
		const { first, duplicate } = duplicateAudio[0];
		throw new Error(
			`corpus samples '${first.id}' and '${duplicate.id}' reuse identical audio`,
		);
	}
	const samplesById = new Map(corpus.samples.map((sample) => [sample.id, sample]));
	const corpusCells = new Map();
	const eligibleSamples = corpus.samples.filter(
		(sample) => sample.scenario === 'meeting' && sample.provenance.basis === 'participant-consent',
	);
	for (const sample of eligibleSamples) {
		addToCell(
			corpusCells,
			cellKey(primaryLanguage(sample.language), sample.noise_condition),
			sample.session_id,
		);
	}

	const requiredCorpusCells = [];
	for (const language of targets.languages) {
		for (const noise of targets.noise_conditions) requiredCorpusCells.push(cellKey(language, noise));
	}
	const corpusCoverage = Object.fromEntries(
		requiredCorpusCells.map((key) => [key, corpusCells.get(key)?.size ?? 0]),
	);
	const missingCorpusCells = requiredCorpusCells.filter(
		(key) => corpusCoverage[key] < targets.min_sessions_per_language_noise_cell,
	);

	const measurementCells = new Map();
	const modelArtifacts = new Map();
	for (const [index, report] of reports.entries()) {
		const errors = validateRunReport(report, `reports[${index}]`);
		if (errors.length > 0) throw new Error(`invalid benchmark report:\n- ${errors.join('\n- ')}`);
		if (report.corpus_id !== corpus.corpus_id) {
			throw new Error(
				`report corpus '${report.corpus_id}' does not match manifest corpus '${corpus.corpus_id}'`,
			);
		}
		if (report.corpus_fingerprint !== corpus.corpus_fingerprint) {
			throw new Error(
				`report corpus fingerprint does not match the current manifest revision`,
			);
		}
		const modelKey = `${report.provider}/${report.model}`;
		const priorArtifact = modelArtifacts.get(modelKey);
		if (priorArtifact !== undefined && priorArtifact !== report.model_artifact_sha256) {
			throw new Error(`reports use different artifacts for model '${modelKey}'`);
		}
		modelArtifacts.set(modelKey, report.model_artifact_sha256);
		for (const result of report.results) {
			const sample = samplesById.get(result.sample_id);
			if (!sample) throw new Error(`report sample '${result.sample_id}' is absent from the corpus manifest`);
			if (sample.scenario !== 'meeting' || sample.provenance.basis !== 'participant-consent') continue;
			addToCell(
				measurementCells,
				measurementKey(
					primaryLanguage(sample.language),
					sample.noise_condition,
					report.provider,
					report.model,
					result.metrics.backend,
				),
				sample.session_id,
			);
		}
	}

	const requiredMeasurementCells = [];
	for (const language of targets.languages) {
		for (const noise of targets.noise_conditions) {
			for (const variant of targets.benchmark_variants) {
				requiredMeasurementCells.push(
					measurementKey(
						language,
						noise,
						variant.provider,
						variant.model,
						variant.backend,
					),
				);
			}
		}
	}
	const measurementCoverage = Object.fromEntries(
		requiredMeasurementCells.map((key) => [key, measurementCells.get(key)?.size ?? 0]),
	);
	const missingMeasurementCells = requiredMeasurementCells.filter(
		(key) => measurementCoverage[key] < targets.min_sessions_per_language_noise_cell,
	);

	return {
		schema_version: 2,
		target_id: targets.target_id,
		corpus_id: corpus.corpus_id,
		model_artifacts: Object.fromEntries(
			[...modelArtifacts.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		minimum_distinct_sessions_per_cell: targets.min_sessions_per_language_noise_cell,
		participant_meeting_samples: eligibleSamples.length,
		participant_meeting_sessions: new Set(eligibleSamples.map((sample) => sample.session_id)).size,
		corpus: {
			covered_cells: requiredCorpusCells.length - missingCorpusCells.length,
			required_cells: requiredCorpusCells.length,
			counts: corpusCoverage,
			missing_cells: missingCorpusCells,
		},
		measurements: {
			reports: reports.length,
			covered_cells: requiredMeasurementCells.length - missingMeasurementCells.length,
			required_cells: requiredMeasurementCells.length,
			counts: measurementCoverage,
			missing_cells: missingMeasurementCells,
		},
		complete: missingCorpusCells.length === 0 && missingMeasurementCells.length === 0,
	};
}

export function formatCoverage(coverage) {
	const summarizeMissing = (cells) => {
		const visible = cells.slice(0, 8).join(', ');
		return cells.length > 8 ? `${visible}, … +${cells.length - 8} more` : visible;
	};
	const lines = [
		`${coverage.target_id} on ${coverage.corpus_id}`,
		`Distinct participant meeting sessions: ${coverage.participant_meeting_sessions}`,
		`Corpus cells: ${coverage.corpus.covered_cells}/${coverage.corpus.required_cells}`,
		`Measurement cells: ${coverage.measurements.covered_cells}/${coverage.measurements.required_cells}`,
	];
	if (coverage.corpus.missing_cells.length > 0) {
		lines.push(`Missing corpus cells: ${summarizeMissing(coverage.corpus.missing_cells)}`);
	}
	if (coverage.measurements.missing_cells.length > 0) {
		lines.push(
			`Missing measurement cells: ${summarizeMissing(coverage.measurements.missing_cells)}`,
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
			const outputPath = path.resolve(jsonOutput);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.writeFileSync(outputPath, `${JSON.stringify(coverage, null, 2)}\n`);
		}
		if (requireComplete && !coverage.complete) process.exit(1);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
}
