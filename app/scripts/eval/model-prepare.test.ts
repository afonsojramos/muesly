import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	CATALOG_AUDIT_MODELS,
	MODEL_PREPARATION_RESERVE_BYTES,
	POLICY_MODELS,
	assertModelPreparationDiskSpace,
	availableDiskBytes,
	downloadModelWithProductPath,
	modelsForSet,
	parseModelPreparationArgs,
	prepareModelSet,
	resolveExplicitModelsDirectory,
	verifyCanonicalModel,
} from './model-prepare.ts';

const DIGEST = 'a'.repeat(64);

test('locks the policy and catalog-audit model sets', () => {
	assert.deepEqual(
		POLICY_MODELS.map(({ provider, model }) => `${provider}/${model}`),
		[
			'whisper/base-q5_1',
			'whisper/small-q5_1',
			'whisper/medium-q5_0',
			'whisper/large-v3-turbo-q5_0',
			'whisper/large-v3-q5_0',
			'parakeet/parakeet-tdt-0.6b-v3-int8',
		],
	);
	assert.deepEqual(
		CATALOG_AUDIT_MODELS.map(({ provider, model }) => `${provider}/${model}`),
		[
			'whisper/tiny-q5_1',
			'whisper/tiny',
			'whisper/base',
			'whisper/small',
			'whisper/medium',
			'whisper/large-v3-turbo',
			'whisper/large-v3',
		],
	);
	assert.deepEqual(modelsForSet('all'), [...POLICY_MODELS, ...CATALOG_AUDIT_MODELS]);
	assert.throws(() => modelsForSet('legacy'), /unknown model preparation set/);
});

test('requires an explicit models directory and validates the selected set', () => {
	assert.deepEqual(parseModelPreparationArgs(['--models-dir', '/models']), {
		modelsDirectory: '/models',
		modelSet: 'all',
	});
	assert.deepEqual(
		parseModelPreparationArgs(['--set', 'policy', '--models-dir', '/models with spaces']),
		{ modelsDirectory: '/models with spaces', modelSet: 'policy' },
	);
	assert.throws(() => parseModelPreparationArgs([]), /--models-dir is required/);
	assert.throws(
		() => parseModelPreparationArgs(['--models-dir', '/models', '--set', 'unknown']),
		/--set must be one of/,
	);
	assert.throws(
		() => parseModelPreparationArgs(['--models-dir', '/one', '--models-dir', '/two']),
		/may only be provided once/,
	);
	assert.throws(
		() => parseModelPreparationArgs(['--models-dir', '/models', '--download']),
		/unknown option/,
	);
});

test('rejects relative and repository-local model directories', () => {
	const repositoryRoot = path.join(path.parse(process.cwd()).root, 'workspace', 'muesly');
	assert.throws(
		() => resolveExplicitModelsDirectory('models', repositoryRoot),
		/explicit absolute path/,
	);
	assert.throws(
		() => resolveExplicitModelsDirectory(repositoryRoot, repositoryRoot),
		/outside the repository/,
	);
	assert.throws(
		() => resolveExplicitModelsDirectory(path.join(repositoryRoot, 'models'), repositoryRoot),
		/outside the repository/,
	);
	assert.equal(
		resolveExplicitModelsDirectory(
			path.join(path.dirname(repositoryRoot), 'muesly-models'),
			repositoryRoot,
		),
		path.join(path.dirname(repositoryRoot), 'muesly-models'),
	);
});

test('checks the nearest existing directory for available disk space', (t) => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-space-'));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const requested = path.join(parent, 'not-created', 'models');
	let probedPath;
	const available = availableDiskBytes(requested, {
		statfsSyncImpl: (target, options) => {
			probedPath = target;
			assert.deepEqual(options, { bigint: true });
			return { bavail: 7n, bsize: 4096n };
		},
	});
	assert.equal(probedPath, parent);
	assert.equal(available, 28_672n);
});

test('requires model bytes in addition to the 20 GiB safety reserve', () => {
	const models = [{ downloadBytes: 512 * 1024 ** 2 }];
	const enough = BigInt(MODEL_PREPARATION_RESERVE_BYTES + 512 * 1024 ** 2);
	assert.deepEqual(assertModelPreparationDiskSpace(models, enough), {
		availableBytes: enough,
		downloadBytes: BigInt(512 * 1024 ** 2),
		requiredBytes: enough,
	});
	assert.throws(
		() => assertModelPreparationDiskSpace(models, enough - 1n),
		/insufficient disk space.*20 GiB reserve/,
	);
	assert.throws(
		() => assertModelPreparationDiskSpace(models, Number(enough)),
		/non-negative bigint/,
	);
});

test('verifies the read-only preparation digest against local model bytes', () => {
	let preparationOptions;
	let artifactOptions;
	const result = verifyCanonicalModel('/bin/transcribe-fixture', POLICY_MODELS[0], '/models', {
		prepareModelImpl: (_executable, options) => {
			preparationOptions = options;
			return {
				schema_version: 3,
				provider: 'whisper',
				model: 'base-q5_1',
				model_artifact_sha256: DIGEST,
				primary_model_artifact_sha256: null,
			};
		},
		modelArtifactSha256Impl: (...args) => {
			artifactOptions = args;
			return DIGEST;
		},
	});
	assert.equal(result.canonicalDigest, DIGEST);
	assert.equal(preparationOptions.reportedBackend, 'cpu');
	assert.equal(preparationOptions.modelsDirectory, '/models');
	assert.deepEqual(artifactOptions, ['whisper', 'base-q5_1', '/models', 'cpu']);

	assert.throws(
		() =>
			verifyCanonicalModel('/bin/transcribe-fixture', POLICY_MODELS[0], '/models', {
				prepareModelImpl: () => ({ model_artifact_sha256: DIGEST }),
				modelArtifactSha256Impl: () => 'b'.repeat(64),
			}),
		/local artifact digest does not match its canonical pin/,
	);
});

test('uses the product downloader through VAD-on-silence with explicit models directory', () => {
	let invocation;
	downloadModelWithProductPath('/bin/transcribe-fixture', POLICY_MODELS[0], '/models with spaces', {
		repositoryRoot: '/repo',
		silenceFixture: '/repo/silence.wav',
		environment: { MUESLY_EVAL_RUNTIME_ENV_SHA256: DIGEST },
		benchmarkRuntimeDependenciesSha256Impl: () => 'b'.repeat(64),
		bindBenchmarkRuntimeDependenciesImpl: (environment, digest, executable, options) => {
			assert.equal(digest, 'b'.repeat(64));
			assert.equal(executable, '/bin/transcribe-fixture');
			assert.deepEqual(options, { platform: process.platform });
			return { ...environment, BOUND: '1' };
		},
		spawnSyncImpl: (command, args, options) => {
			invocation = { command, args, options };
			return { status: 0 };
		},
	});
	assert.equal(invocation.command, '/bin/transcribe-fixture');
	assert.deepEqual(invocation.args, [
		'--provider',
		'whisper',
		'--language',
		'en',
		'--vad',
		'/repo/silence.wav',
		'base-q5_1',
		'/models with spaces',
	]);
	assert.equal(invocation.options.cwd, '/repo');
	assert.equal(invocation.options.env.BOUND, '1');
	assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'inherit']);

	assert.throws(
		() =>
			downloadModelWithProductPath('/bin/transcribe-fixture', POLICY_MODELS[0], '/models', {
				benchmarkRuntimeDependenciesSha256Impl: () => DIGEST,
				bindBenchmarkRuntimeDependenciesImpl: (environment) => environment,
				spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM' }),
			}),
		/product model download failed.*signal/,
	);
});

test('prepares missing models one at a time and verifies each download before continuing', () => {
	const repositoryRoot = path.join(path.parse(process.cwd()).root, 'repo');
	const modelsDirectory = path.join(path.parse(process.cwd()).root, 'app-data', 'models');
	const events = [];
	const verificationAttempts = new Map();
	const result = prepareModelSet(
		{ modelsDirectory, modelSet: 'policy' },
		{
			repositoryRoot,
			availableDiskBytesImpl: () => 100n * 1024n ** 3n,
			buildExecutableImpl: (_root, options) => {
				events.push(`build:${options.provider}/${options.backend}`);
				return { executablePath: '/bin/transcribe-fixture' };
			},
			verifyModelImpl: (_executable, model) => {
				const key = `${model.provider}/${model.model}`;
				const attempt = (verificationAttempts.get(key) ?? 0) + 1;
				verificationAttempts.set(key, attempt);
				events.push(`verify:${key}:${attempt}`);
				if (attempt === 1) throw new Error('missing');
				return { canonicalDigest: DIGEST };
			},
			downloadModelImpl: (_executable, model) => {
				events.push(`download:${model.provider}/${model.model}`);
			},
			onProgress: ({ phase, model }) => {
				if (phase === 'ready') events.push(`ready:${model.provider}/${model.model}`);
			},
		},
	);

	assert.equal(result.models.length, POLICY_MODELS.length);
	assert(result.models.every((model) => model.status === 'downloaded'));
	assert.equal(events[0], 'build:whisper/cpu');
	for (const model of POLICY_MODELS) {
		const key = `${model.provider}/${model.model}`;
		const firstVerification = events.indexOf(`verify:${key}:1`);
		const download = events.indexOf(`download:${key}`);
		const secondVerification = events.indexOf(`verify:${key}:2`);
		const ready = events.indexOf(`ready:${key}`);
		assert(firstVerification < download);
		assert(download < secondVerification);
		assert(secondVerification < ready);
	}
	for (let index = 1; index < POLICY_MODELS.length; index += 1) {
		const previous = POLICY_MODELS[index - 1];
		const current = POLICY_MODELS[index];
		assert(
			events.indexOf(`ready:${previous.provider}/${previous.model}`) <
				events.indexOf(`verify:${current.provider}/${current.model}:1`),
		);
	}
});

test('is idempotent when every selected model already verifies', () => {
	const repositoryRoot = path.join(path.parse(process.cwd()).root, 'repo');
	const modelsDirectory = path.join(path.parse(process.cwd()).root, 'app-data', 'models');
	let downloads = 0;
	const result = prepareModelSet(
		{ modelsDirectory, modelSet: 'catalog-audit' },
		{
			repositoryRoot,
			availableDiskBytesImpl: () => 100n * 1024n ** 3n,
			buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
			verifyModelImpl: () => ({ canonicalDigest: DIGEST }),
			downloadModelImpl: () => {
				downloads += 1;
			},
		},
	);
	assert.equal(downloads, 0);
	assert.equal(result.models.length, CATALOG_AUDIT_MODELS.length);
	assert(result.models.every((model) => model.status === 'already-ready'));
});

test('fails disk preflight before building or downloading', () => {
	let built = false;
	assert.throws(
		() =>
			prepareModelSet(
				{
					modelsDirectory: path.join(path.parse(process.cwd()).root, 'app-data', 'models'),
					modelSet: 'policy',
				},
				{
					repositoryRoot: path.join(path.parse(process.cwd()).root, 'repo'),
					availableDiskBytesImpl: () => 1n,
					buildExecutableImpl: () => {
						built = true;
					},
				},
			),
		/insufficient disk space/,
	);
	assert.equal(built, false);
});

test('never continues to another model after post-download verification fails', () => {
	const verified = [];
	const downloaded = [];
	assert.throws(
		() =>
			prepareModelSet(
				{
					modelsDirectory: path.join(path.parse(process.cwd()).root, 'app-data', 'models'),
					modelSet: 'policy',
				},
				{
					repositoryRoot: path.join(path.parse(process.cwd()).root, 'repo'),
					availableDiskBytesImpl: () => 100n * 1024n ** 3n,
					buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
					verifyModelImpl: (_executable, model) => {
						verified.push(model.model);
						throw new Error('canonical verification failed');
					},
					downloadModelImpl: (_executable, model) => downloaded.push(model.model),
				},
			),
		/canonical verification failed/,
	);
	assert.deepEqual(verified, ['base-q5_1', 'base-q5_1']);
	assert.deepEqual(downloaded, ['base-q5_1']);
});
