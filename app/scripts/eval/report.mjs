#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeCorpusBoundFiles } from './corpus-result.mjs';
import { loadCorpus } from './corpus.mjs';

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

function requireString(value, field, errors) {
	if (typeof value !== 'string' || value.length === 0) errors.push(`${field} must be a non-empty string`);
}

export function validateRunReport(report, label = 'report') {
	const errors = [];
	if (report === null || typeof report !== 'object' || Array.isArray(report)) {
		return [`${label} must be a JSON object`];
	}
	if (report.schema_version !== 7) errors.push(`${label}.schema_version must be 7`);
	requireString(report.corpus_id, `${label}.corpus_id`, errors);
	if (!/^[a-f0-9]{64}$/.test(report.corpus_fingerprint ?? '')) {
		errors.push(`${label}.corpus_fingerprint must be a lowercase SHA-256 digest`);
	}
	requireString(report.provider, `${label}.provider`, errors);
	requireString(report.model, `${label}.model`, errors);
	if (!/^[a-f0-9]{64}$/.test(report.model_artifact_sha256 ?? '')) {
		errors.push(`${label}.model_artifact_sha256 must be a lowercase SHA-256 digest`);
	}
	if (report.thresholds === null || typeof report.thresholds !== 'object' || Array.isArray(report.thresholds)) {
		errors.push(`${label}.thresholds must be an object`);
	} else {
		for (const field of ['max_wer_percent', 'max_hallucinated_words']) {
			if (!finiteNumber(report.thresholds[field]) || report.thresholds[field] < 0) {
				errors.push(`${label}.thresholds.${field} must be a non-negative finite number`);
			}
		}
		if (!Number.isInteger(report.thresholds.max_hallucinated_words)) {
			errors.push(`${label}.thresholds.max_hallucinated_words must be an integer`);
		}
	}
	if (!Array.isArray(report.results) || report.results.length === 0) {
		errors.push(`${label}.results must be a non-empty array`);
		return errors;
	}
	for (const [index, result] of report.results.entries()) {
		const prefix = `${label}.results[${index}]`;
		if (result === null || typeof result !== 'object' || Array.isArray(result)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		for (const field of ['sample_id', 'language', 'noise_condition']) {
			requireString(result[field], `${prefix}.${field}`, errors);
		}
		if (typeof result.passed !== 'boolean') errors.push(`${prefix}.passed must be boolean`);
		if (result.metrics === null || typeof result.metrics !== 'object' || Array.isArray(result.metrics)) {
			errors.push(`${prefix}.metrics must be an object`);
			continue;
		}
		if (result.metrics.schema_version !== 4) {
			errors.push(`${prefix}.metrics.schema_version must be 4`);
		}
		requireString(result.metrics.backend, `${prefix}.metrics.backend`, errors);
		requireString(result.metrics.operating_system, `${prefix}.metrics.operating_system`, errors);
		requireString(result.metrics.architecture, `${prefix}.metrics.architecture`, errors);
		requireString(result.metrics.hardware_profile, `${prefix}.metrics.hardware_profile`, errors);
		requireString(result.metrics.accelerator, `${prefix}.metrics.accelerator`, errors);
		for (const field of [
			'inference_seconds',
			'inference_rtf',
			'peak_rss_mb',
			'audio_duration_seconds',
		]) {
			if (!finiteNumber(result.metrics[field]) || result.metrics[field] < 0) {
				errors.push(`${prefix}.metrics.${field} must be a non-negative finite number`);
			}
		}
		const isWer = result.reference_words !== null || result.word_errors !== null;
		if (isWer) {
			if (!Number.isInteger(result.reference_words) || result.reference_words <= 0) {
				errors.push(`${prefix}.reference_words must be a positive integer for WER samples`);
			}
			if (!Number.isInteger(result.word_errors) || result.word_errors < 0) {
				errors.push(`${prefix}.word_errors must be a non-negative integer for WER samples`);
			}
		} else if (!Number.isInteger(result.hallucinated_words) || result.hallucinated_words < 0) {
			errors.push(`${prefix}.hallucinated_words must be a non-negative integer for non-WER samples`);
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
	const peaks = records.map((record) => record.metrics.peak_rss_mb);
	const audioDurationSeconds = records.reduce(
		(sum, record) => sum + record.metrics.audio_duration_seconds,
		0,
	);
	const inferenceSeconds = records.reduce(
		(sum, record) => sum + record.metrics.inference_seconds,
		0,
	);
	return {
		samples: records.length,
		passed_samples: records.filter((record) => record.passed).length,
		pass_rate_percent: (records.filter((record) => record.passed).length / records.length) * 100,
		audio_duration_seconds: audioDurationSeconds,
		inference_seconds: inferenceSeconds,
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
			silenceRecords.length === 0 ? null : Math.max(...silenceRecords.map((record) => record.hallucinated_words)),
		aggregate_inference_rtf:
			audioDurationSeconds === 0 ? null : inferenceSeconds / audioDurationSeconds,
		mean_inference_rtf: mean(rtfs),
		median_inference_rtf: median(rtfs),
		max_inference_rtf: Math.max(...rtfs),
		mean_peak_rss_mb: mean(peaks),
		max_peak_rss_mb: Math.max(...peaks),
	};
}

export function aggregateRunReports(reports) {
	if (!Array.isArray(reports) || reports.length === 0) throw new Error('at least one run report is required');
	const records = [];
	let corpusId;
	let corpusFingerprint;
	let thresholds;
	let operatingSystem;
	let architecture;
	let hardwareProfile;
	const accelerators = new Map();
	const modelArtifacts = new Map();
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
		const modelKey = `${report.provider}/${report.model}`;
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
			for (const result of report.results) {
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
				if (
					priorAccelerator !== undefined &&
					priorAccelerator !== result.metrics.accelerator
				) {
					throw new Error(
						`cannot aggregate different accelerators for backend '${result.metrics.backend}'`,
					);
				}
				accelerators.set(result.metrics.backend, result.metrics.accelerator);
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
			[...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, summarize(values)]),
		);
	}

	return {
		schema_version: 2,
		generated_at: new Date().toISOString(),
		corpus_id: corpusId,
		corpus_fingerprint: corpusFingerprint,
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
		'WER is micro-averaged from total word errors / total reference words. RTF and memory are measured during local inference.',
	];
	for (const [dimension, groups] of Object.entries(report.groups)) {
		lines.push('', `## ${dimension.replaceAll('_', ' ')}`, '');
		lines.push('| Group | Samples | Pass rate | WER | Aggregate RTF | P50 RTF | Max peak RSS | Hallucinated words |');
		lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
		for (const [name, summary] of Object.entries(groups)) {
			const werCell = summary.wer_percent === null ? '—' : `${display(summary.wer_percent)}%`;
			lines.push(
				`| ${escapeCell(name)} | ${summary.samples} | ${display(summary.pass_rate_percent)}% | ${werCell} | ${display(summary.aggregate_inference_rtf, 3)} | ${display(summary.median_inference_rtf, 3)} | ${display(summary.max_peak_rss_mb, 1)} MiB | ${summary.hallucinated_words_total} |`,
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
				'Usage: report.mjs <run.json>... [--manifest <path>] [--json <path>] [--markdown <path>]',
			);
		}
		if ((jsonOutput || markdownOutput) && !manifestPath) {
			throw new Error('--manifest is required when writing aggregate output files');
		}
		const reports = args.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
		const aggregate = aggregateRunReports(reports);
		const markdown = renderMarkdown(aggregate);
		if (jsonOutput || markdownOutput) {
			const corpus = loadCorpus(manifestPath);
			if (aggregate.corpus_id !== corpus.corpus_id) {
				throw new Error(
					`report corpus '${aggregate.corpus_id}' does not match manifest corpus '${corpus.corpus_id}'`,
				);
			}
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
