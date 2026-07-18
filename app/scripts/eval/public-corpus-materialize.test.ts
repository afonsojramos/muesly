import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planCorpusBenchmarkTasks } from './corpus-benchmark-plan.ts';
import { corpusFingerprint, PUBLIC_PREPARATION_PROTOCOL_ID, PUBLIC_REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import {
	bindMaterializationCheckpoints,
	materializePublicCampaignEvidence,
	parsePublicMaterializeArgs,
} from './public-corpus-materialize.ts';
import { taskReportFilename, reportIdentityFromCheckpoint } from './corpus-benchmark-plan.ts';

const MODEL_ARTIFACT = 'b'.repeat(64);
const EXECUTABLE = 'c'.repeat(64);
const RUNTIME_ENVIRONMENT = 'd'.repeat(64);

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function evaluatorEntry(overrides = {}) {
	const revision = {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: '1'.repeat(40),
		cargo_lock_sha256: '2'.repeat(64),
		rustc_vv: [
			'rustc 1.88.0 (6b00bc388 2025-06-23)',
			'binary: rustc',
			'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc',
			'commit-date: 2025-06-23',
			'host: aarch64-apple-darwin',
			'release: 1.88.0',
			'LLVM version: 20.1.5',
		].join('\n'),
		build_profile: 'release',
		target_triple: 'aarch64-apple-darwin',
		cargo_features: [],
		build_env_sha256: '3'.repeat(64),
		...overrides,
	};
	return { revision, sha256: evaluatorRevisionSha256(revision) };
}

function currentIdentity(overrides = {}) {
	return {
		model_artifact_sha256: MODEL_ARTIFACT,
		operating_system: 'macos',
		architecture: 'aarch64',
		hardware_profile: `cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;runtime_env_sha256=${RUNTIME_ENVIRONMENT}`,
		accelerator: 'none',
		benchmark_executable_sha256: EXECUTABLE,
		...overrides,
	};
}

function reportForTask(task, identity = currentIdentity(), overrides = {}) {
	const result = {
		sample_id: task.sample_id,
		...(task.dataset === undefined ? {} : { dataset: task.dataset }),
		language: task.language,
		noise_condition: task.noise_condition,
		scenario: task.scenario,
		speakers: task.speakers,
		provenance_basis: task.provenance_basis,
		reference_words: 20,
		word_errors: 1,
		wer_percent: 5,
		hallucinated_words: null,
		passed: true,
		metrics: {
			schema_version: 7,
			provider: task.provider,
			model: task.model,
			backend: task.target_backend,
			operating_system: identity.operating_system,
			architecture: identity.architecture,
			hardware_profile: identity.hardware_profile,
			accelerator: identity.accelerator,
			benchmark_executable_sha256: identity.benchmark_executable_sha256,
			audio_sha256: task.audio_sha256,
			audio_duration_seconds: task.audio_duration_seconds,
			decode_seconds: 0.1,
			vad_seconds: 0.2,
			model_download_seconds: 0,
			model_load_seconds: 1,
			inference_seconds: 2,
			inference_rtf: 2 / task.audio_duration_seconds,
			inference_audio_seconds: task.audio_duration_seconds / 2,
			model_inference_rtf: 4 / task.audio_duration_seconds,
			measured_total_seconds: 3.3,
			baseline_rss_mb: 100,
			peak_rss_mb: 500,
			peak_rss_delta_mb: 400,
		},
		...overrides.result,
	};
	return {
		schema_version: 11,
		benchmark_task_id: task.task_id,
		corpus_id: task.corpus_id,
		corpus_fingerprint: task.corpus_fingerprint,
		reference_protocol_id: task.reference_protocol_id,
		started_at: '2026-07-16T00:00:00.000Z',
		completed_at: '2026-07-16T00:01:00.000Z',
		wer_scorer: task.wer_scorer,
		evaluator_revision: structuredClone(task.evaluator_revision),
		evaluator_revision_sha256: task.evaluator_revision_sha256,
		benchmark_executable_sha256: identity.benchmark_executable_sha256,
		provider: task.provider,
		model: task.model,
		repeat_index: task.repeat_index,
		model_artifact_sha256: identity.model_artifact_sha256,
		thresholds: { ...task.thresholds },
		passed: result.passed,
		results: [result],
		...overrides.report,
	};
}

function publicFixture(t, { sampleIds = ['sample-b', 'sample-a'] } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-materialize-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const localCorpusRoot = path.join(directory, 'local-corpus');
	const sessionDirectory = path.join(localCorpusRoot, 'session-a');
	fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
	const corpusSamples = sampleIds.map((sampleId, index) => {
		const audioName = `${sampleId}.wav`;
		const referenceName = `${sampleId}.txt`;
		const audio = Buffer.from(`audio-${index}`);
		const reference = `public upstream words ${index}\n`;
		fs.writeFileSync(path.join(sessionDirectory, audioName), audio, { mode: 0o600 });
		fs.writeFileSync(path.join(sessionDirectory, referenceName), reference, { mode: 0o600 });
		return {
			id: sampleId,
			session_id: `session-${sampleId}`,
			dataset: 'fleurs',
			audio_path: `local-corpus/session-a/${audioName}`,
			audio_sha256: sha256(audio),
			reference_path: `local-corpus/session-a/${referenceName}`,
			reference_sha256: sha256(reference),
			language: 'en',
			whisper_language: 'en',
			scenario: 'read-speech',
			noise_condition: 'clean-read',
			speakers: 1,
			duration_seconds: 20,
			provenance: {
				basis: 'public-license',
				redistribution: 'local-only',
				source_catalog_id: 'muesly-public-asr-sources-v3',
				source_item_ids: [`source-${sampleId}`],
				transform_id: 'deterministic-test-transform',
			},
		};
	});
	const document = {
		schema_version: 4,
		corpus_id: 'muesly-public-asr-v1',
		reference_protocol_id: PUBLIC_REFERENCE_PROTOCOL_ID,
		description: 'Public upstream-gold test corpus.',
		distribution: 'local',
		source_catalog_sha256: '9'.repeat(64),
		preparation: {
			protocol_id: PUBLIC_PREPARATION_PROTOCOL_ID,
			source_catalog_id: 'muesly-public-asr-sources-v3',
			selection_sha256: '8'.repeat(64),
			ffmpeg_id: 'ffmpeg-test',
			ffmpeg_sha256: '7'.repeat(64),
			ffmpeg_version: 'ffmpeg test version',
		},
		samples: corpusSamples,
	};
	const manifestPath = path.join(directory, 'corpus-local.json');
	fs.writeFileSync(manifestPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
	const corpus = {
		...document,
		corpus_fingerprint: corpusFingerprint(document),
		manifest_path: manifestPath,
		samples: document.samples.map((sample) => ({
			...sample,
			audio_file: path.join(directory, sample.audio_path),
			reference_file: path.join(directory, sample.reference_path),
		})),
	};
	const targets = {
		schema_version: 4,
		target_id: 'public-test-suite-v1',
		reference_protocol_id: PUBLIC_REFERENCE_PROTOCOL_ID,
		description: 'Test fixed public suite.',
		coverage_mode: 'explicit-samples',
		sample_ids: [...sampleIds],
		repetitions: 1,
		benchmark_variants: [{ provider: 'whisper', model: 'whisper-test', backend: 'cpu' }],
	};
	const siblingTargets = {
		...structuredClone(targets),
		target_id: 'public-test-sibling-v1',
	};
	const targetsPath = path.join(directory, 'suite-targets.json');
	fs.writeFileSync(targetsPath, `${JSON.stringify(targets)}\n`, { mode: 0o600 });
	return {
		directory,
		manifestPath,
		corpus,
		targets,
		siblingTargets,
		targetsPath,
		resultsDirectory: path.join(directory, 'results'),
	};
}

function planFixtureTasks(fixture, { maxWerPct = 10, maxHallucinatedWords = 2 } = {}) {
	return planCorpusBenchmarkTasks({
		corpus: fixture.corpus,
		targets: fixture.targets,
		thresholds: {
			max_wer_percent: maxWerPct,
			max_hallucinated_words: maxHallucinatedWords,
		},
		accelerators: {},
		evaluatorRevisions: { cpu: evaluatorEntry() },
	});
}

function writeCheckpoint(resultsDirectory, task, identity = currentIdentity(), overrides = {}) {
	const report = reportForTask(task, identity, overrides);
	const name = taskReportFilename(task, reportIdentityFromCheckpoint(report));
	fs.mkdirSync(resultsDirectory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(resultsDirectory, name), `${JSON.stringify(report)}\n`, {
		mode: 0o600,
	});
	return { name, report };
}

function readCheckpointEntries(resultsDirectory) {
	return fs
		.readdirSync(resultsDirectory)
		.filter((name) => name.endsWith('.run.json'))
		.sort()
		.map((name) => ({
			name,
			report: JSON.parse(fs.readFileSync(path.join(resultsDirectory, name), 'utf8')),
		}));
}

function parsedArgs(fixture, overrides = {}) {
	return {
		suite: 'automatic-policy',
		workspace: fixture.directory,
		catalogPath: path.join(fixture.directory, 'catalog.json'),
		selectionPath: path.join(fixture.directory, 'selection.json'),
		manifestPath: fixture.manifestPath,
		campaignOptions: {
			manifestPath: fixture.manifestPath,
			targetsPath: fixture.targetsPath,
			modelsDir: null,
			maxWerPct: 10,
			maxHallucinatedWords: 2,
			selectedVariants: [],
			accelerators: {},
			run: false,
			requireComplete: false,
		},
		...overrides,
	};
}

function planSiblingFixtureTasks(fixture, { maxWerPct = 10, maxHallucinatedWords = 2 } = {}) {
	return planCorpusBenchmarkTasks({
		corpus: fixture.corpus,
		targets: fixture.siblingTargets,
		thresholds: {
			max_wer_percent: maxWerPct,
			max_hallucinated_words: maxHallucinatedWords,
		},
		accelerators: {},
		evaluatorRevisions: { cpu: evaluatorEntry() },
	});
}

function materializeDependencies(fixture, overrides = {}) {
	return {
		loadCorpus: () => fixture.corpus,
		loadTargets: (targetsPath) => {
			const sibling = !String(targetsPath).includes('automatic-policy');
			const targets = sibling ? fixture.siblingTargets : fixture.targets;
			return {
				targets,
				targetsPath,
				targetsSha256: sha256(JSON.stringify(targets)),
			};
		},
		collectEvaluatorContext: () => ({
			buildEnvironment: {},
			hostTriple: 'aarch64-apple-darwin',
			revisions: { cpu: evaluatorEntry() },
			targetTriple: 'aarch64-apple-darwin',
		}),
		...overrides,
	};
}

test('parse defaults to the automatic-policy suite in the default workspace', () => {
	const parsed = parsePublicMaterializeArgs([]);
	assert.equal(parsed.suite, 'automatic-policy');
	assert.equal(parsed.workspace, path.resolve(path.join(process.cwd(), 'app/scripts/eval/public-corpus')));
	assert.equal(parsed.manifestPath, path.join(parsed.workspace, 'corpus-local.json'));
	assert.equal(parsed.campaignOptions.maxWerPct, 10);
	assert.equal(parsed.campaignOptions.maxHallucinatedWords, 2);
});

test('parse accepts a suite, workspace, and planning thresholds', () => {
	const parsed = parsePublicMaterializeArgs([
		'--suite',
		'performance',
		'--workspace',
		'/tmp/example-workspace',
		'--max-wer',
		'7.5',
		'--max-hallucinated-words',
		'3',
		'--accelerator',
		'metal=apple-m4-pro',
	]);
	assert.equal(parsed.suite, 'performance');
	assert.equal(parsed.workspace, '/tmp/example-workspace');
	assert.equal(parsed.campaignOptions.maxWerPct, 7.5);
	assert.equal(parsed.campaignOptions.maxHallucinatedWords, 3);
	assert.deepEqual(parsed.campaignOptions.accelerators, { metal: 'apple-m4-pro' });
});

test('parse rejects unknown suites and duplicate options', () => {
	assert.throws(() => parsePublicMaterializeArgs(['--suite', 'nightly']), /--suite must be/);
	assert.throws(
		() => parsePublicMaterializeArgs(['--suite', 'performance', '--suite', 'catalog-audit']),
		/--suite may only be provided once/,
	);
});

test('parse rejects campaign-only and foreign options', () => {
	for (const args of [
		['--run'],
		['--require-complete'],
		['--variant', 'whisper/whisper-test/cpu'],
		['--models-dir', '/tmp/models'],
		['--manifest', '/tmp/manifest.json'],
		['--targets', '/tmp/targets.json'],
		['--output-dir', '/tmp/out'],
	]) {
		assert.throws(() => parsePublicMaterializeArgs(args), Error, `expected rejection of ${args}`);
	}
	assert.throws(() => parsePublicMaterializeArgs(['--max-wer']), /--max-wer requires a value/);
	assert.throws(() => parsePublicMaterializeArgs(['--max-wer', '-1']), /non-negative number/);
});

test('binding returns one ordered checkpoint per planned task', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	const checkpoints = [];
	for (const task of tasks) checkpoints.push(writeCheckpoint(fixture.resultsDirectory, task));
	const records = bindMaterializationCheckpoints(
		readCheckpointEntries(fixture.resultsDirectory),
		tasks,
		'automatic-policy',
	);
	assert.equal(records.length, tasks.length);
	assert.deepEqual(
		records.map((record) => record.report.benchmark_task_id),
		tasks.map((task) => task.task_id),
	);
});

test('binding skips checkpoints that fully validate against a sibling fixed suite', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	const siblingTasks = planSiblingFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	writeCheckpoint(fixture.resultsDirectory, siblingTasks[0]);
	const records = bindMaterializationCheckpoints(
		readCheckpointEntries(fixture.resultsDirectory),
		tasks,
		'automatic-policy',
		[{ targets: fixture.siblingTargets, tasks: siblingTasks }],
	);
	assert.equal(records.length, tasks.length);
	assert.deepEqual(
		records.map((record) => record.report.benchmark_task_id),
		tasks.map((task) => task.task_id),
	);
});

test('binding rejects a checkpoint that fails validation against its sibling task', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	const siblingTasks = planSiblingFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	writeCheckpoint(fixture.resultsDirectory, siblingTasks[0], currentIdentity(), {
		report: { thresholds: { max_wer_percent: 99, max_hallucinated_words: 99 } },
	});
	assert.throws(
		() =>
			bindMaterializationCheckpoints(
				readCheckpointEntries(fixture.resultsDirectory),
				tasks,
				'automatic-policy',
				[{ targets: fixture.siblingTargets, tasks: siblingTasks }],
			),
		/belongs to no fixed public suite/,
	);
});

test('binding rejects a checkpoint that belongs to no planned task', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	const foreignTasks = planFixtureTasks(fixture, { maxWerPct: 5 });
	writeCheckpoint(fixture.resultsDirectory, foreignTasks[0]);
	assert.throws(
		() =>
			bindMaterializationCheckpoints(
				readCheckpointEntries(fixture.resultsDirectory),
				tasks,
				'automatic-policy',
			),
		/belongs to no fixed public suite/,
	);
});

test('binding rejects an incomplete campaign before any materialization', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	writeCheckpoint(fixture.resultsDirectory, tasks[0]);
	assert.throws(
		() =>
			bindMaterializationCheckpoints(
				readCheckpointEntries(fixture.resultsDirectory),
				tasks,
				'automatic-policy',
			),
		/'automatic-policy' campaign is incomplete: 1 of 2 planned task\(s\) have no checkpoint/,
	);
});

test('binding rejects multiple checkpoint identities for one task', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	writeCheckpoint(
		fixture.resultsDirectory,
		tasks[0],
		currentIdentity({
			hardware_profile: `cpu=Other Machine;logical_cpus=8;memory_bytes=16000000000;runtime_env_sha256=${RUNTIME_ENVIRONMENT}`,
		}),
	);
	assert.throws(
		() =>
			bindMaterializationCheckpoints(
				readCheckpointEntries(fixture.resultsDirectory),
				tasks,
				'automatic-policy',
			),
		/multiple checkpoint identities/,
	);
});

test('binding rejects a named checkpoint whose report fails task validation', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	const tampered = readCheckpointEntries(fixture.resultsDirectory);
	const victim = tampered[0];
	victim.report.thresholds = { max_wer_percent: 99, max_hallucinated_words: 99 };
	fs.writeFileSync(
		path.join(fixture.resultsDirectory, victim.name),
		`${JSON.stringify(victim.report)}\n`,
		{ mode: 0o600 },
	);
	assert.throws(
		() =>
			bindMaterializationCheckpoints(
				readCheckpointEntries(fixture.resultsDirectory),
				tasks,
				'automatic-policy',
			),
		/invalid benchmark checkpoint for the 'automatic-policy' campaign/,
	);
});

test('materialization writes suite aggregate and coverage evidence', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	const result = materializePublicCampaignEvidence(
		parsedArgs(fixture),
		materializeDependencies(fixture),
	);
	assert.equal(result.suite, 'automatic-policy');
	assert.equal(result.measurementCount, tasks.length);
	const aggregate = JSON.parse(fs.readFileSync(result.aggregatePath, 'utf8'));
	const coverage = JSON.parse(fs.readFileSync(result.coveragePath, 'utf8'));
	assert.equal(aggregate.schema_version, 12);
	assert.equal(aggregate.corpus_id, fixture.corpus.corpus_id);
	assert.equal(aggregate.corpus_fingerprint, fixture.corpus.corpus_fingerprint);
	assert.equal(aggregate.reference_protocol_id, PUBLIC_REFERENCE_PROTOCOL_ID);
	assert.equal(coverage.schema_version, 12);
	assert.equal(coverage.complete, true);
	assert.equal(coverage.measurements.covered_cells, coverage.measurements.required_cells);
	assert.equal(
		path.basename(result.aggregatePath),
		'automatic-policy-aggregate.json',
	);
	assert.equal(path.basename(result.coveragePath), 'automatic-policy-coverage.json');
});

test('materialization rejects an incomplete campaign without writing evidence', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	writeCheckpoint(fixture.resultsDirectory, tasks[0]);
	assert.throws(
		() => materializePublicCampaignEvidence(parsedArgs(fixture), materializeDependencies(fixture)),
		/campaign is incomplete/,
	);
	assert.equal(fs.existsSync(path.join(fixture.resultsDirectory, 'automatic-policy-aggregate.json')), false);
	assert.equal(fs.existsSync(path.join(fixture.resultsDirectory, 'automatic-policy-coverage.json')), false);
});

test('materialization tolerates sibling suite checkpoints in the shared results directory', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	for (const task of planSiblingFixtureTasks(fixture)) {
		writeCheckpoint(fixture.resultsDirectory, task);
	}
	const result = materializePublicCampaignEvidence(
		parsedArgs(fixture),
		materializeDependencies(fixture),
	);
	assert.equal(result.measurementCount, tasks.length);
	const aggregate = JSON.parse(fs.readFileSync(result.aggregatePath, 'utf8'));
	assert.equal(aggregate.corpus_fingerprint, fixture.corpus.corpus_fingerprint);
});

test('materialization rejects mixed campaigns with foreign checkpoints', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	const foreignTasks = planFixtureTasks(fixture, { maxWerPct: 5 });
	writeCheckpoint(fixture.resultsDirectory, foreignTasks[0]);
	assert.throws(
		() => materializePublicCampaignEvidence(parsedArgs(fixture), materializeDependencies(fixture)),
		/belongs to no fixed public suite/,
	);
	assert.equal(fs.existsSync(path.join(fixture.resultsDirectory, 'automatic-policy-aggregate.json')), false);
});

test('materialization rejects planning inputs that drifted from the campaign', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	for (const task of tasks) writeCheckpoint(fixture.resultsDirectory, task);
	const drifted = parsedArgs(fixture);
	drifted.campaignOptions = { ...drifted.campaignOptions, maxWerPct: 5 };
	assert.throws(
		() => materializePublicCampaignEvidence(drifted, materializeDependencies(fixture)),
		/belongs to no fixed public suite/,
	);
});

test('materialization rejects evidence without a complete hardware cohort', (t) => {
	const fixture = publicFixture(t);
	const tasks = planFixtureTasks(fixture);
	writeCheckpoint(fixture.resultsDirectory, tasks[0]);
	writeCheckpoint(
		fixture.resultsDirectory,
		tasks[1],
		currentIdentity({
			hardware_profile: `cpu=Other Machine;logical_cpus=8;memory_bytes=16000000000;runtime_env_sha256=${RUNTIME_ENVIRONMENT}`,
		}),
	);
	assert.throws(
		() => materializePublicCampaignEvidence(parsedArgs(fixture), materializeDependencies(fixture)),
		/cannot aggregate reports from different hardware profiles/,
	);
	assert.equal(fs.existsSync(path.join(fixture.resultsDirectory, 'automatic-policy-aggregate.json')), false);
});
