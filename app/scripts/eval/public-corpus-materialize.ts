#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCorpusBenchmarkArgs } from './corpus-benchmark-options.ts';
import { discoverCorpusBenchmarkCheckpoints } from './corpus-benchmark-checkpoints.ts';
import {
	planCorpusBenchmarkTasks,
	reportIdentityFromCheckpoint,
	taskReportFilename,
	validateTaskCheckpoint,
} from './corpus-benchmark-plan.ts';
import {
	collectEvaluatorContext,
	corpusBenchmarkErrorExitCode,
	loadCorpusBenchmarkTargets,
	taskFilenamePrefix,
} from './corpus-benchmark-run.ts';
import { writeCorpusBoundFiles } from './corpus-result.ts';
import { evaluateCoverage } from './coverage.ts';
import {
	createPublicCampaignCorpusLoader,
	PUBLIC_CAMPAIGN_SUITES,
} from './public-corpus-campaign.ts';
import {
	acquirePublicCorpusLock,
	releasePublicCorpusLock,
} from './public-corpus-lock.ts';
import {
	DEFAULT_PUBLIC_CATALOG,
	DEFAULT_PUBLIC_SELECTION,
	DEFAULT_PUBLIC_WORKSPACE,
} from './public-corpus-prepare.ts';
import { aggregateRunReports } from './report.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../../..');
const PUBLIC_MATERIALIZE_VALUE_OPTIONS = new Set([
	'--suite',
	'--workspace',
	'--catalog',
	'--selection',
]);
// Only options that influence task planning may be forwarded. Thresholds and
// accelerators change the committed task digests, so materialization must
// reproduce exactly the campaign's planning inputs to recognize its checkpoints.
const FORWARDED_VALUE_OPTIONS = new Set(['--max-wer', '--max-hallucinated-words', '--accelerator']);
const FORBIDDEN_GENERIC_OPTIONS = new Set([
	'--manifest',
	'--targets',
	'--models-dir',
	'--variant',
	'--run',
	'--require-complete',
]);

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

export function parsePublicMaterializeArgs(args) {
	let suite = 'automatic-policy';
	let workspace = DEFAULT_PUBLIC_WORKSPACE;
	let catalogPath = DEFAULT_PUBLIC_CATALOG;
	let selectionPath = DEFAULT_PUBLIC_SELECTION;
	const forwarded = [];
	const seen = new Set();
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (FORBIDDEN_GENERIC_OPTIONS.has(option)) {
			throw new Error(`${option} is fixed by public materialization; full fixed suites only`);
		}
		if (FORWARDED_VALUE_OPTIONS.has(option)) {
			forwarded.push(option, requiredValue(args, index, option));
			index += 1;
			continue;
		}
		if (!PUBLIC_MATERIALIZE_VALUE_OPTIONS.has(option)) {
			throw new Error(`unknown option: ${option}`);
		}
		if (seen.has(option)) throw new Error(`${option} may only be provided once`);
		seen.add(option);
		const value = requiredValue(args, index, option);
		index += 1;
		if (option === '--suite') suite = value;
		else if (option === '--workspace') workspace = path.resolve(value);
		else if (option === '--catalog') catalogPath = path.resolve(value);
		else selectionPath = path.resolve(value);
	}
	if (!Object.hasOwn(PUBLIC_CAMPAIGN_SUITES, suite)) {
		throw new Error("--suite must be 'automatic-policy', 'catalog-audit', or 'performance'");
	}
	const manifestPath = path.join(workspace, 'corpus-local.json');
	return {
		suite,
		workspace,
		catalogPath,
		selectionPath,
		manifestPath,
		campaignOptions: parseCorpusBenchmarkArgs(forwarded, {
			defaultManifest: manifestPath,
			defaultTargets: PUBLIC_CAMPAIGN_SUITES[suite],
		}),
	};
}

// Materialization is deliberately stricter than campaign resume: the lenient
// planner ignores checkpoints from other corpus revisions, but evidence
// materialization must reject them so a stale or foreign measurement can never
// slip into a suite's aggregate. Every discovered checkpoint must validate
// against exactly one currently planned task of the selected suite, and every
// planned task of that suite must have exactly one checkpoint identity (one
// hardware cohort). Because all three fixed public suites share one results
// directory, checkpoints that fully validate against a sibling fixed suite
// planned with identical corpus, thresholds, accelerators, and evaluator
// revisions are recognized and skipped; anything else is rejected as mixed or
// stale evidence.
export function bindMaterializationCheckpoints(checkpoints, tasks, suite, siblingPlans = []) {
	const recordsByTask = new Map(tasks.map((task) => [task.task_id, []]));
	for (const checkpoint of checkpoints) {
		const candidates = tasks.filter((task) =>
			checkpoint.name.startsWith(taskFilenamePrefix(task)),
		);
		if (candidates.length === 0) {
			const siblingErrors = [];
			let siblingValid = false;
			for (const sibling of siblingPlans) {
				for (const task of sibling.tasks) {
					if (!checkpoint.name.startsWith(taskFilenamePrefix(task))) continue;
					const errors = validateTaskCheckpoint(checkpoint.report, task);
					if (errors.length > 0) {
						siblingErrors.push(...errors);
						continue;
					}
					const identity = reportIdentityFromCheckpoint(checkpoint.report);
					if (checkpoint.name !== taskReportFilename(task, identity)) {
						siblingErrors.push('checkpoint filename does not match its sibling task and identity');
						continue;
					}
					siblingValid = true;
				}
			}
			if (!siblingValid) {
				const details = siblingErrors.length > 0 ? `\n- ${siblingErrors.join('\n- ')}` : '';
				throw new Error(
					`results contain a checkpoint that belongs to no fixed public suite planned ` +
						`with the current corpus, thresholds, and evaluator revision: ${checkpoint.name}; ` +
						'archive other campaigns, corpus revisions, and evaluator revisions elsewhere ' +
						`before materializing evidence${details}`,
				);
			}
			continue;
		}
		const valid = [];
		const candidateErrors = [];
		for (const task of candidates) {
			const errors = validateTaskCheckpoint(checkpoint.report, task);
			if (errors.length === 0) valid.push(task);
			else candidateErrors.push(...errors);
		}
		if (valid.length !== 1) {
			const details = candidateErrors.length > 0 ? `\n- ${candidateErrors.join('\n- ')}` : '';
			throw new Error(`invalid benchmark checkpoint for the '${suite}' campaign${details}`);
		}
		const task = valid[0];
		const identity = reportIdentityFromCheckpoint(checkpoint.report);
		const expectedName = taskReportFilename(task, identity);
		if (checkpoint.name !== expectedName) {
			throw new Error('benchmark checkpoint filename does not match its exact task and identity');
		}
		recordsByTask.get(task.task_id).push({ ...checkpoint, identity });
	}
	const missing = [];
	const ambiguous = [];
	const ordered = [];
	for (const task of tasks) {
		const taskRecords = recordsByTask.get(task.task_id) ?? [];
		if (taskRecords.length === 0) {
			missing.push(task.task_id);
			continue;
		}
		if (taskRecords.length > 1) {
			ambiguous.push(task);
			continue;
		}
		ordered.push(taskRecords[0]);
	}
	if (missing.length > 0) {
		throw new Error(
			`'${suite}' campaign is incomplete: ${missing.length} of ${tasks.length} planned ` +
				'task(s) have no checkpoint; finish or resume the campaign before materializing evidence',
		);
	}
	if (ambiguous.length > 0) {
		const example = ambiguous[0];
		throw new Error(
			`'${suite}' campaign mixes ${ambiguous.length} task(s) with multiple checkpoint ` +
				`identities (for example ${example.provider}/${example.model}/` +
				`${example.target_backend} on sample '${example.sample_id}' repeat ` +
				`${example.repeat_index}); materialization requires exactly one hardware cohort`,
		);
	}
	return ordered;
}

export function materializePublicCampaignEvidence(parsed, dependencyOverrides = {}) {
	const dependencies = {
		acquirePublicCorpusLock,
		releasePublicCorpusLock,
		loadCorpus: createPublicCampaignCorpusLoader(parsed, dependencyOverrides),
		loadTargets: loadCorpusBenchmarkTargets,
		collectEvaluatorContext,
		planTasks: planCorpusBenchmarkTasks,
		discoverCheckpoints: discoverCorpusBenchmarkCheckpoints,
		aggregate: aggregateRunReports,
		evaluateCoverage,
		writeOutputs: writeCorpusBoundFiles,
		...dependencyOverrides,
	};
	const lock = dependencies.acquirePublicCorpusLock(parsed.workspace);
	let materializeError;
	try {
		const corpus = dependencies.loadCorpus(parsed.manifestPath);
		const planSuite = (suite) => {
			const loadedTargets = dependencies.loadTargets(PUBLIC_CAMPAIGN_SUITES[suite]);
			const evaluatorContext = dependencies.collectEvaluatorContext({
				repoRoot: repositoryRoot,
				targets: loadedTargets.targets,
			});
			return {
				targets: loadedTargets.targets,
				tasks: dependencies.planTasks({
					corpus,
					targets: loadedTargets.targets,
					thresholds: {
						max_wer_percent: parsed.campaignOptions.maxWerPct,
						max_hallucinated_words: parsed.campaignOptions.maxHallucinatedWords,
					},
					accelerators: parsed.campaignOptions.accelerators,
					evaluatorRevisions: evaluatorContext.revisions,
				}),
			};
		};
		const { targets, tasks } = planSuite(parsed.suite);
		const siblingPlans = Object.keys(PUBLIC_CAMPAIGN_SUITES)
			.filter((candidate) => candidate !== parsed.suite)
			.map((candidate) => planSuite(candidate));
		const resultsDirectory = path.join(parsed.workspace, 'results');
		const checkpoints = dependencies.discoverCheckpoints(resultsDirectory);
		const records = bindMaterializationCheckpoints(checkpoints, tasks, parsed.suite, siblingPlans);
		const reports = records.map((record) => record.report);
		const aggregate = dependencies.aggregate(reports, corpus);
		const coverage = dependencies.evaluateCoverage(corpus, targets, reports);
		if (!coverage.complete) {
			throw new Error(
				`'${parsed.suite}' campaign evidence is incomplete: corpus cells ` +
					`${coverage.corpus.covered_cells}/${coverage.corpus.required_cells}, measurement ` +
					`cells ${coverage.measurements.covered_cells}/${coverage.measurements.required_cells}, ` +
					'complete hardware matrix cohorts ' +
					`${coverage.measurements.complete_matrix_hardware_cohorts}; refusing to materialize`,
			);
		}
		const aggregatePath = path.join(resultsDirectory, `${parsed.suite}-aggregate.json`);
		const coveragePath = path.join(resultsDirectory, `${parsed.suite}-coverage.json`);
		dependencies.writeOutputs({
			manifestPath: parsed.manifestPath,
			expectedFingerprint: corpus.corpus_fingerprint,
			outputs: [
				{
					outputPath: aggregatePath,
					contents: `${JSON.stringify(aggregate, null, 2)}\n`,
				},
				{
					outputPath: coveragePath,
					contents: `${JSON.stringify(coverage, null, 2)}\n`,
				},
			],
		});
		return {
			suite: parsed.suite,
			measurementCount: reports.length,
			aggregatePath,
			coveragePath,
		};
	} catch (error) {
		materializeError = error;
		throw error;
	} finally {
		try {
			if (!dependencies.releasePublicCorpusLock(lock)) {
				throw new Error('failed to release the public corpus materialization lock');
			}
		} catch (releaseError) {
			if (materializeError) {
				throw new AggregateError(
					[materializeError, releaseError],
					'public campaign materialization and lock release both failed',
				);
			}
			throw releaseError;
		}
	}
}

function usage() {
	return `Usage: nub app/scripts/eval/public-corpus-materialize.ts [options]

Materialize one fixed public suite's resumable campaign checkpoints into its
reviewable aggregate and coverage evidence. The suite's full campaign must be
complete on exactly one hardware cohort; incomplete or mixed campaigns are
rejected and nothing is written.

Options:
  --suite <name>             automatic-policy (default), catalog-audit, or performance
  --workspace <path>         Public corpus workspace (default: ${DEFAULT_PUBLIC_WORKSPACE})
  --catalog <path>           Public source catalog (default: committed catalog)
  --selection <path>         Public selection contract (default: committed selection)
  --max-wer <pct>            Planning threshold used by the campaign (default: 10)
  --max-hallucinated-words N Planning threshold used by the campaign (default: 2)
  --accelerator <b=id>       Planning accelerator pin used by the campaign
`;
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

async function main() {
	try {
		const args = process.argv.slice(2);
		if (args.includes('--help') || args.includes('-h')) {
			console.log(usage());
			return;
		}
		const parsed = parsePublicMaterializeArgs(args);
		const result = materializePublicCampaignEvidence(parsed);
		console.log(
			`${result.suite}: materialized ${result.measurementCount} measurement(s) into ` +
				`${result.aggregatePath} and ${result.coveragePath}`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = corpusBenchmarkErrorExitCode(error);
	}
}

if (isMainModule()) await main();
