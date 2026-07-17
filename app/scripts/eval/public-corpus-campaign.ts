#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseCorpusBenchmarkArgs } from './corpus-benchmark-options.ts';
import {
	corpusBenchmarkErrorExitCode,
	formatCorpusBenchmarkProgress,
	formatCorpusBenchmarkSummary,
	runCorpusBenchmarkCampaign,
} from './corpus-benchmark-run.ts';
import { loadCorpus } from './corpus.ts';
import {
	acquirePublicCorpusLock,
	releasePublicCorpusLock,
} from './public-corpus-lock.ts';
import { validateFinalizedPublicCorpus } from './public-corpus.ts';
import {
	assertWorkspaceIsUntracked,
	DEFAULT_PUBLIC_CATALOG,
	DEFAULT_PUBLIC_SELECTION,
	DEFAULT_PUBLIC_WORKSPACE,
} from './public-corpus-prepare.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_CAMPAIGN_SUITES = Object.freeze({
	'automatic-policy': path.join(here, 'public-corpus-targets-automatic-policy.json'),
	'catalog-audit': path.join(here, 'public-corpus-targets-catalog-audit.json'),
	performance: path.join(here, 'public-corpus-targets-performance.json'),
});
const PUBLIC_VALUE_OPTIONS = new Set(['--suite', '--workspace', '--catalog', '--selection']);
const FORBIDDEN_GENERIC_OPTIONS = new Set(['--manifest', '--targets']);

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

export function parsePublicCampaignArgs(args) {
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
			throw new Error(`${option} is fixed by the public campaign; use --workspace or --suite`);
		}
		if (!PUBLIC_VALUE_OPTIONS.has(option)) {
			forwarded.push(option);
			continue;
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
		campaignOptions: parseCorpusBenchmarkArgs(forwarded, {
			defaultManifest: manifestPath,
			defaultTargets: PUBLIC_CAMPAIGN_SUITES[suite],
		}),
	};
}

export function createPublicCampaignCorpusLoader(options, dependencyOverrides = {}) {
	const dependencies = {
		assertWorkspaceIsUntracked,
		validateFinalizedPublicCorpus,
		loadCorpus,
		...dependencyOverrides,
	};
	const expectedManifestPath = path.resolve(options.workspace, 'corpus-local.json');
	return (manifestPath) => {
		if (path.resolve(manifestPath) !== expectedManifestPath) {
			throw new Error('public campaign manifest does not match the selected workspace');
		}
		dependencies.assertWorkspaceIsUntracked(options.workspace);
		const validationErrors = dependencies.validateFinalizedPublicCorpus({
			workspace: options.workspace,
			catalogPath: options.catalogPath,
			selectionPath: options.selectionPath,
		});
		if (validationErrors.length > 0) {
			throw new Error(`public corpus validation failed:\n- ${validationErrors.join('\n- ')}`);
		}
		return dependencies.loadCorpus(manifestPath, {
			enforceLocalParticipantCustody: false,
		});
	};
}

export async function runLockedPublicCampaign(parsed, dependencyOverrides = {}) {
	const dependencies = {
		acquirePublicCorpusLock,
		releasePublicCorpusLock,
		runCorpusBenchmarkCampaign,
		...dependencyOverrides,
	};
	const lock = dependencies.acquirePublicCorpusLock(parsed.workspace);
	let campaignError;
	try {
		return await dependencies.runCorpusBenchmarkCampaign(parsed.campaignOptions, {
			loadCorpus: createPublicCampaignCorpusLoader(parsed, dependencyOverrides),
			onProgress: (event) => console.log(formatCorpusBenchmarkProgress(event)),
		});
	} catch (error) {
		campaignError = error;
		throw error;
	} finally {
		try {
			if (!dependencies.releasePublicCorpusLock(lock)) {
				throw new Error('failed to release the public corpus campaign lock');
			}
		} catch (releaseError) {
			if (campaignError) {
				throw new AggregateError(
					[campaignError, releaseError],
					'public corpus campaign and lock release both failed',
				);
			}
			throw releaseError;
		}
	}
}

async function main() {
	try {
		const parsed = parsePublicCampaignArgs(process.argv.slice(2));
		const result = await runLockedPublicCampaign(parsed);
		console.log(`${parsed.suite}: ${formatCorpusBenchmarkSummary(result)}`);
		if (result.failedQualityTasks > 0) process.exitCode = 1;
	} catch (error) {
		console.error(error.message);
		process.exitCode = corpusBenchmarkErrorExitCode(error);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	await main();
}
