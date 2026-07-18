import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateCoverageTargets } from './corpus-targets.ts';
import { fileSha256, PUBLIC_REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { CATALOG_AUDIT_MODELS, POLICY_MODELS } from './model-prepare.ts';
import {
	createPublicCampaignCorpusLoader,
	parsePublicCampaignArgs,
	PUBLIC_CAMPAIGN_SUITES,
	runLockedPublicCampaign,
} from './public-corpus-campaign.ts';
import { expectedPublicSampleIds, loadPublicCorpusConfig } from './public-corpus.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const targetPaths = {
	'automatic-policy': path.join(here, 'public-corpus-targets-automatic-policy.json'),
	'catalog-audit': path.join(here, 'public-corpus-targets-catalog-audit.json'),
	performance: path.join(here, 'public-corpus-targets-performance.json'),
};
const fixedSubset = [
	'en-ami-en2001a-natural-office',
	'en-earnings21-4320211-natural-remote-call',
	'es-fleurs-01-clean-read',
	'es-fleurs-02-synthetic-office',
	'pt-fleurs-01-clean-read',
	'pt-fleurs-02-synthetic-remote-call',
	'fr-fleurs-01-clean-read',
	'fr-fleurs-02-synthetic-overlap',
	'de-fleurs-01-clean-read',
	'de-fleurs-02-synthetic-office',
];

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function variantKey(variant) {
	return `${variant.provider}/${variant.model}/${variant.backend}`;
}

function policyVariantKeys() {
	return [
		...POLICY_MODELS.filter((candidate) => candidate.provider === 'whisper').flatMap(
			(candidate) => {
				if (candidate.model === 'large-v3-turbo-q5_0') {
					return [
						`whisper/${candidate.model}/cpu`,
						`whisper/${candidate.model}/metal`,
					];
				}
				return [
					`whisper/${candidate.model}/${candidate.model === 'large-v3-q5_0' ? 'metal' : 'cpu'}`,
				];
			},
		),
		...POLICY_MODELS.filter((candidate) => candidate.provider === 'parakeet').map(
			(candidate) => `parakeet/${candidate.model}/onnx-cpu`,
		),
	];
}

test('all committed public benchmark suites satisfy the strict target contract', () => {
	const bindings = [];
	for (const [suite, targetPath] of Object.entries(targetPaths)) {
		const targets = readJson(targetPath);
		assert.deepEqual(validateCoverageTargets(targets), [], suite);
		assert.equal(targets.schema_version, 4, suite);
		assert.equal(targets.reference_protocol_id, PUBLIC_REFERENCE_PROTOCOL_ID, suite);
		bindings.push({
			corpus_id: targets.corpus_id,
			corpus_fingerprint: targets.corpus_fingerprint,
			source_catalog_sha256: targets.source_catalog_sha256,
			selection_sha256: targets.selection_sha256,
		});
	}
	assert(bindings.every((binding) => JSON.stringify(binding) === JSON.stringify(bindings[0])));
	assert.equal(bindings[0].corpus_id, 'muesly-public-asr-v2');
	assert.equal(
		bindings[0].corpus_fingerprint,
		'74fbd0bc89435defd0ac630d85ef2e588d2bcf565ab08b4689f3934eb6ea6ddb',
	);
	assert.equal(
		bindings[0].source_catalog_sha256,
		fileSha256(path.join(here, 'public-corpus-sources.json')),
	);
	assert.equal(
		bindings[0].selection_sha256,
		fileSha256(path.join(here, 'public-corpus-selection.json')),
	);
});

test('automatic-policy qualifies every public sample against the product candidate matrix', () => {
	const targets = readJson(targetPaths['automatic-policy']);
	const { selection } = loadPublicCorpusConfig(
		path.join(here, 'public-corpus-sources.json'),
		path.join(here, 'public-corpus-selection.json'),
	);
	assert.equal(targets.sample_ids.length, 66);
	assert.deepEqual([...targets.sample_ids].sort(), expectedPublicSampleIds(selection));
	assert.deepEqual(targets.benchmark_variants.map(variantKey), policyVariantKeys());
	assert.equal(targets.repetitions ?? 1, 1);
});

test('catalog audit is a fixed ten-sample multilingual and natural-speech slice', () => {
	const targets = readJson(targetPaths['catalog-audit']);
	assert.deepEqual(targets.sample_ids, fixedSubset);
	assert.deepEqual(
		targets.benchmark_variants.map(variantKey),
		CATALOG_AUDIT_MODELS.map((candidate) => `whisper/${candidate.model}/cpu`),
	);
	assert.equal(new Set(targets.sample_ids.map((sampleId) => sampleId.slice(0, 2))).size, 5);
	assert(targets.sample_ids.some((sampleId) => sampleId.includes('-ami-')));
	assert(targets.sample_ids.some((sampleId) => sampleId.includes('-earnings21-')));
	for (const condition of ['clean-read', 'synthetic-office', 'synthetic-remote-call', 'synthetic-overlap']) {
		assert(targets.sample_ids.some((sampleId) => sampleId.endsWith(condition)), condition);
	}
	const sourceSessions = targets.sample_ids.map((sampleId) => {
		const fleurs = sampleId.match(/^([a-z]{2}-fleurs-\d{2})-/);
		return fleurs?.[1] ?? sampleId;
	});
	assert.equal(new Set(sourceSessions).size, targets.sample_ids.length);
});

test('performance qualification repeats the same fixed slice and policy matrix three times', () => {
	const performance = readJson(targetPaths.performance);
	const automaticPolicy = readJson(targetPaths['automatic-policy']);
	assert.deepEqual(performance.sample_ids, fixedSubset);
	assert.deepEqual(performance.benchmark_variants, automaticPolicy.benchmark_variants);
	assert.equal(performance.repetitions, 3);
	assert.equal(
		performance.sample_ids.length *
			performance.benchmark_variants.length *
			performance.repetitions,
		210,
	);
});

test('public campaign fixes the manifest and target suite while forwarding benchmark controls', () => {
	const parsed = parsePublicCampaignArgs([
		'--suite',
		'performance',
		'--workspace',
		'/tmp/muesly public campaign',
		'--models-dir',
		'/models with spaces',
		'--run',
	]);
	assert.equal(parsed.suite, 'performance');
	assert.equal(parsed.campaignOptions.manifestPath, '/tmp/muesly public campaign/corpus-local.json');
	assert.equal(parsed.campaignOptions.targetsPath, PUBLIC_CAMPAIGN_SUITES.performance);
	assert.equal(parsed.campaignOptions.modelsDir, '/models with spaces');
	assert.equal(parsed.campaignOptions.run, true);
	assert.throws(
		() => parsePublicCampaignArgs(['--manifest', '/tmp/unbound.json']),
		/manifest is fixed/,
	);
	assert.throws(() => parsePublicCampaignArgs(['--suite', 'unknown']), /suite must be/);
});

test('public campaign revalidates licensed provenance before every corpus load', () => {
	const workspace = '/tmp/muesly-public-loader';
	const expectedCorpus = { corpus_id: 'fixture' };
	let workspaceChecks = 0;
	let provenanceChecks = 0;
	let corpusLoads = 0;
	const loader = createPublicCampaignCorpusLoader(
		{
			workspace,
			catalogPath: '/catalog.json',
			selectionPath: '/selection.json',
		},
		{
			assertWorkspaceIsUntracked(candidate) {
				workspaceChecks += 1;
				assert.equal(candidate, workspace);
			},
			validateFinalizedPublicCorpus(options) {
				provenanceChecks += 1;
				assert.equal(options.workspace, workspace);
				return [];
			},
			loadCorpus(manifestPath, options) {
				corpusLoads += 1;
				assert.equal(manifestPath, `${workspace}/corpus-local.json`);
				assert.equal(options.enforceLocalParticipantCustody, false);
				return expectedCorpus;
			},
		},
	);
	assert.equal(loader(`${workspace}/corpus-local.json`), expectedCorpus);
	assert.equal(loader(`${workspace}/corpus-local.json`), expectedCorpus);
	assert.deepEqual([workspaceChecks, provenanceChecks, corpusLoads], [2, 2, 2]);
	assert.throws(() => loader('/tmp/another/corpus-local.json'), /does not match/);

	const rejectingLoader = createPublicCampaignCorpusLoader(
		{
			workspace,
			catalogPath: '/catalog.json',
			selectionPath: '/selection.json',
		},
		{
			assertWorkspaceIsUntracked() {},
			validateFinalizedPublicCorpus: () => ['catalog digest changed'],
			loadCorpus: () => assert.fail('invalid provenance must not reach corpus loading'),
		},
	);
	assert.throws(
		() => rejectingLoader(`${workspace}/corpus-local.json`),
		/catalog digest changed/,
	);
});

test('public campaign holds the workspace lock through validation and the full run', async () => {
	const workspace = '/tmp/muesly-public-locked-campaign';
	const events = [];
	const parsed = {
		workspace,
		catalogPath: '/catalog.json',
		selectionPath: '/selection.json',
		campaignOptions: {
			manifestPath: `${workspace}/corpus-local.json`,
		},
	};
	const expected = { failedQualityTasks: 0 };
	const result = await runLockedPublicCampaign(parsed, {
		acquirePublicCorpusLock(candidate) {
			events.push('acquire');
			assert.equal(candidate, workspace);
			return { token: 'fixture' };
		},
		releasePublicCorpusLock(lock) {
			events.push('release');
			assert.equal(lock.token, 'fixture');
			return true;
		},
		assertWorkspaceIsUntracked() {
			events.push('workspace');
		},
		validateFinalizedPublicCorpus() {
			events.push('validate');
			return [];
		},
		loadCorpus() {
			events.push('load');
			return { corpus_id: 'fixture' };
		},
		async runCorpusBenchmarkCampaign(options, dependencies) {
			events.push('run-start');
			dependencies.loadCorpus(options.manifestPath);
			events.push('run-end');
			return expected;
		},
	});
	assert.equal(result, expected);
	assert.deepEqual(events, [
		'acquire',
		'run-start',
		'workspace',
		'validate',
		'load',
		'run-end',
		'release',
	]);
});

test('public campaign releases the workspace lock when the run fails', async () => {
	const events = [];
	await assert.rejects(
		runLockedPublicCampaign(
			{
				workspace: '/tmp/muesly-public-failed-campaign',
				campaignOptions: {},
			},
			{
				acquirePublicCorpusLock() {
					events.push('acquire');
					return { token: 'fixture' };
				},
				releasePublicCorpusLock() {
					events.push('release');
					return true;
				},
				async runCorpusBenchmarkCampaign() {
					events.push('run');
					throw new Error('fixture campaign failure');
				},
			},
		),
		/fixture campaign failure/,
	);
	assert.deepEqual(events, ['acquire', 'run', 'release']);
});

test('public campaign reports both campaign and lock-release failures', async () => {
	await assert.rejects(
		runLockedPublicCampaign(
			{
				workspace: '/tmp/muesly-public-double-failure',
				campaignOptions: {},
			},
			{
				acquirePublicCorpusLock: () => ({ token: 'fixture' }),
				releasePublicCorpusLock: () => false,
				runCorpusBenchmarkCampaign: async () => {
					throw new Error('fixture campaign failure');
				},
			},
		),
		(error) => {
			assert(error instanceof AggregateError);
			assert.match(error.message, /campaign and lock release both failed/);
			assert.match(error.errors[0].message, /fixture campaign failure/);
			assert.match(error.errors[1].message, /failed to release/);
			return true;
		},
	);
});
