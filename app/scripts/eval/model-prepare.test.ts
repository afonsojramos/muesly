import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	CATALOG_AUDIT_MODELS,
	MODEL_PREPARATION_RESERVE_BYTES,
	ModelUnavailableError,
	POLICY_MODELS,
	acquireModelPreparationLock,
	assertModelPreparationDiskSpace,
	availableDiskBytes,
	downloadModelWithProductPath,
	modelArtifactAvailability,
	modelsForSet,
	parseModelPreparationArgs,
	prepareExternalModelsDirectory,
	prepareModelSet,
	releaseModelPreparationLock,
	resolveExplicitModelsDirectory,
	verifyCanonicalModel,
} from './model-prepare.ts';

const DIGEST = 'a'.repeat(64);

function isolatedOrchestration(overrides = {}) {
	return {
		prepareModelsDirectoryImpl: (modelsDirectory) => modelsDirectory,
		acquirePreparationLockImpl: () => ({ token: 'test-lock' }),
		releasePreparationLockImpl: () => {},
		attestModelStorageImpl: () => {},
		...overrides,
	};
}

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

test('canonicalizes an external models directory and rejects symlink escape into the repository', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-path-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = path.join(root, 'repository');
	const externalRoot = path.join(root, 'external');
	fs.mkdirSync(path.join(repositoryRoot, 'models'), { recursive: true });
	fs.mkdirSync(externalRoot);

	const modelsDirectory = path.join(externalRoot, 'app-data', 'models');
	assert.equal(
		prepareExternalModelsDirectory(modelsDirectory, repositoryRoot),
		fs.realpathSync(modelsDirectory),
	);

	const escape = path.join(externalRoot, 'repository-link');
	fs.symlinkSync(repositoryRoot, escape, process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(
		() => prepareExternalModelsDirectory(path.join(escape, 'models'), repositoryRoot),
		/resolves inside the repository through a symlink or directory junction/,
	);
});

test('re-attests the canonical destination after mkdir', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-race-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = path.join(root, 'repository');
	const externalRoot = path.join(root, 'external');
	const requested = path.join(externalRoot, 'models');
	fs.mkdirSync(repositoryRoot);
	fs.mkdirSync(externalRoot);
	assert.throws(
		() =>
			prepareExternalModelsDirectory(requested, repositoryRoot, {
				mkdirSyncImpl: (target) =>
					fs.symlinkSync(repositoryRoot, target, process.platform === 'win32' ? 'junction' : 'dir'),
			}),
		/changed or escaped through a symlink or directory junction/,
	);
});

test('holds an exclusive owner-attested model preparation lock', (t) => {
	const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-lock-'));
	t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));
	const first = acquireModelPreparationLock(modelsDirectory, {
		currentIdentity: 'test:first',
		isOwnedByLiveProcess: () => true,
	});
	assert.throws(
		() =>
			acquireModelPreparationLock(modelsDirectory, {
				currentIdentity: 'test:second',
				isOwnedByLiveProcess: () => true,
			}),
		/already running/,
	);
	releaseModelPreparationLock(first);
	const second = acquireModelPreparationLock(modelsDirectory, {
		currentIdentity: 'test:second',
		isOwnedByLiveProcess: () => true,
	});
	releaseModelPreparationLock(second);
});

test('serializes lock replacement behind a fail-closed transition directory', (t) => {
	const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-transition-'));
	t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));
	const first = acquireModelPreparationLock(modelsDirectory, {
		currentIdentity: 'test:first',
		isOwnedByLiveProcess: () => true,
	});
	const ownerPath = path.join(first.lockPath, 'owner.json');
	const ownerBefore = fs.readFileSync(ownerPath, 'utf8');
	const transitionPath = path.join(modelsDirectory, '.muesly-eval-model-prepare.transition');
	fs.mkdirSync(transitionPath, { mode: 0o700 });

	assert.throws(
		() =>
			acquireModelPreparationLock(modelsDirectory, {
				currentIdentity: 'test:contender',
				isOwnedByLiveProcess: () => false,
			}),
		/ownership is already transitioning/,
	);
	assert.equal(fs.readFileSync(ownerPath, 'utf8'), ownerBefore);
	fs.rmdirSync(transitionPath);
	releaseModelPreparationLock(first);
});

test('recovers only a valid stale model preparation lock and fails closed on malformed state', (t) => {
	const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-stale-lock-'));
	t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));
	acquireModelPreparationLock(modelsDirectory, {
		currentIdentity: 'test:stale',
		isOwnedByLiveProcess: () => true,
	});
	const recovered = acquireModelPreparationLock(modelsDirectory, {
		currentIdentity: 'test:current',
		isOwnedByLiveProcess: () => false,
	});
	releaseModelPreparationLock(recovered);

	const malformedPath = path.join(modelsDirectory, '.muesly-eval-model-prepare.lock');
	fs.mkdirSync(malformedPath, { mode: 0o700 });
	fs.writeFileSync(path.join(malformedPath, 'owner.json'), 'not json\n', { mode: 0o600 });
	assert.throws(
		() =>
			acquireModelPreparationLock(modelsDirectory, {
				currentIdentity: 'test:blocked',
				isOwnedByLiveProcess: () => false,
			}),
		/not valid JSON/,
	);
	assert(fs.existsSync(malformedPath));
});

test('classifies only structurally missing model artifacts as unavailable', (t) => {
	const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-available-'));
	t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));
	const whisper = POLICY_MODELS[0];
	assert.deepEqual(modelArtifactAvailability(whisper, modelsDirectory), {
		available: false,
		reason: 'model file is missing',
	});
	fs.writeFileSync(path.join(modelsDirectory, 'ggml-base-q5_1.bin'), 'model');
	assert.deepEqual(modelArtifactAvailability(whisper, modelsDirectory), { available: true });

	const parakeet = POLICY_MODELS.at(-1);
	const parakeetDirectory = path.join(modelsDirectory, 'parakeet', parakeet.model);
	fs.mkdirSync(parakeetDirectory, { recursive: true });
	assert.match(modelArtifactAvailability(parakeet, modelsDirectory).reason, /required files/);
	for (const filename of [
		'encoder-model.int8.onnx',
		'decoder_joint-model.int8.onnx',
		'nemo128.onnx',
		'vocab.txt',
	]) {
		fs.writeFileSync(path.join(parakeetDirectory, filename), filename);
	}
	assert.deepEqual(modelArtifactAvailability(parakeet, modelsDirectory), { available: true });
});

test('rejects hardlinked artifacts, partial aliases, and escaped provider directories', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-aliases-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const modelsDirectory = path.join(root, 'models');
	const outside = path.join(root, 'outside');
	fs.mkdirSync(modelsDirectory);
	fs.mkdirSync(outside);
	const whisper = POLICY_MODELS[0];
	const whisperPath = path.join(modelsDirectory, 'ggml-base-q5_1.bin');
	fs.writeFileSync(whisperPath, 'model');
	fs.linkSync(whisperPath, path.join(outside, 'model-alias.bin'));
	assert.throws(
		() => modelArtifactAvailability(whisper, modelsDirectory),
		/regular single-link file/,
	);
	fs.unlinkSync(path.join(outside, 'model-alias.bin'));
	fs.unlinkSync(whisperPath);
	fs.symlinkSync(path.join(outside, 'partial.bin'), `${whisperPath}.part`);
	assert.throws(
		() => modelArtifactAvailability(whisper, modelsDirectory),
		/regular single-link file/,
	);
	fs.unlinkSync(`${whisperPath}.part`);

	fs.symlinkSync(
		outside,
		path.join(modelsDirectory, 'parakeet'),
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	assert.throws(
		() => modelArtifactAvailability(POLICY_MODELS.at(-1), modelsDirectory),
		/Parakeet provider directory must be a real directory/,
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

test('verifies the read-only preparation digest against local model bytes', (t) => {
	const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-verify-'));
	t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(modelsDirectory, 'ggml-base-q5_1.bin'), 'model');
	let preparationOptions;
	let artifactOptions;
	const result = verifyCanonicalModel(
		'/bin/transcribe-fixture',
		POLICY_MODELS[0],
		modelsDirectory,
		{
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
		},
	);
	assert.equal(result.canonicalDigest, DIGEST);
	assert.equal(preparationOptions.reportedBackend, 'cpu');
	assert.equal(preparationOptions.modelsDirectory, modelsDirectory);
	assert.deepEqual(artifactOptions, ['whisper', 'base-q5_1', modelsDirectory, 'cpu']);

	assert.throws(
		() =>
			verifyCanonicalModel('/bin/transcribe-fixture', POLICY_MODELS[0], modelsDirectory, {
				prepareModelImpl: () => ({ model_artifact_sha256: DIGEST }),
				modelArtifactSha256Impl: () => 'b'.repeat(64),
			}),
		/local artifact digest does not match its canonical pin/,
	);
});

test('re-attests model storage after an external verifier mutates an artifact', (t) => {
	const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-post-attest-'));
	t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));
	const modelPath = path.join(modelsDirectory, 'ggml-base-q5_1.bin');
	fs.writeFileSync(modelPath, 'model');

	assert.throws(
		() =>
			verifyCanonicalModel('/bin/transcribe-fixture', POLICY_MODELS[0], modelsDirectory, {
				prepareModelImpl: () => {
					fs.linkSync(modelPath, path.join(modelsDirectory, 'unexpected-hardlink.bin'));
					return { model_artifact_sha256: DIGEST };
				},
				modelArtifactSha256Impl: () => DIGEST,
			}),
		/regular single-link file/,
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
		attestModelStorageImpl: () => {},
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
				attestModelStorageImpl: () => {},
				spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM' }),
			}),
		/product model download failed.*signal/,
	);
});

test('prepares missing models one at a time and verifies each download before continuing', () => {
	const repositoryRoot = path.join(path.parse(process.cwd()).root, 'repo');
	const modelsDirectory = path.join(path.parse(process.cwd()).root, 'app-data', 'models');
	const events = [];
	const result = prepareModelSet(
		{ modelsDirectory, modelSet: 'policy' },
		isolatedOrchestration({
			repositoryRoot,
			modelArtifactAvailabilityImpl: () => ({ available: false, reason: 'missing' }),
			availableDiskBytesImpl: () => 100n * 1024n ** 3n,
			buildExecutableImpl: (_root, options) => {
				events.push(`build:${options.provider}/${options.backend}`);
				return { executablePath: '/bin/transcribe-fixture' };
			},
			verifyModelImpl: (_executable, model) => {
				const key = `${model.provider}/${model.model}`;
				events.push(`verify:${key}`);
				return { canonicalDigest: DIGEST };
			},
			downloadModelImpl: (_executable, model) => {
				events.push(`download:${model.provider}/${model.model}`);
			},
			onProgress: ({ phase, model }) => {
				if (phase === 'ready') events.push(`ready:${model.provider}/${model.model}`);
			},
		}),
	);

	assert.equal(result.models.length, POLICY_MODELS.length);
	assert(result.models.every((model) => model.status === 'downloaded'));
	assert.equal(events[0], 'build:whisper/cpu');
	for (const model of POLICY_MODELS) {
		const key = `${model.provider}/${model.model}`;
		const download = events.indexOf(`download:${key}`);
		const verification = events.indexOf(`verify:${key}`);
		const ready = events.indexOf(`ready:${key}`);
		assert(download < verification);
		assert(verification < ready);
	}
	for (let index = 1; index < POLICY_MODELS.length; index += 1) {
		const previous = POLICY_MODELS[index - 1];
		const current = POLICY_MODELS[index];
		assert(
			events.indexOf(`ready:${previous.provider}/${previous.model}`) <
				events.indexOf(`download:${current.provider}/${current.model}`),
		);
	}
});

test('is idempotent when every selected model already verifies', () => {
	const repositoryRoot = path.join(path.parse(process.cwd()).root, 'repo');
	const modelsDirectory = path.join(path.parse(process.cwd()).root, 'app-data', 'models');
	let downloads = 0;
	let diskProbes = 0;
	const result = prepareModelSet(
		{ modelsDirectory, modelSet: 'catalog-audit' },
		isolatedOrchestration({
			repositoryRoot,
			modelArtifactAvailabilityImpl: () => ({ available: true }),
			availableDiskBytesImpl: () => {
				diskProbes += 1;
				throw new Error('read-only verification must not probe disk capacity');
			},
			buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
			verifyModelImpl: () => ({ canonicalDigest: DIGEST }),
			downloadModelImpl: () => {
				downloads += 1;
			},
		}),
	);
	assert.equal(downloads, 0);
	assert.equal(diskProbes, 0);
	assert.equal(result.models.length, CATALOG_AUDIT_MODELS.length);
	assert(result.models.every((model) => model.status === 'already-ready'));
	assert.deepEqual(result.disk_preflight, {
		available_bytes: null,
		required_bytes: '0',
		reserve_bytes: '0',
	});
});

test('charges disk space only for the structurally missing model set', () => {
	const repositoryRoot = path.join(path.parse(process.cwd()).root, 'repo');
	const modelsDirectory = path.join(path.parse(process.cwd()).root, 'app-data', 'models');
	const missingModel = POLICY_MODELS[0];
	const requiredBytes = BigInt(MODEL_PREPARATION_RESERVE_BYTES + missingModel.downloadBytes);
	const result = prepareModelSet(
		{ modelsDirectory, modelSet: 'policy' },
		isolatedOrchestration({
			repositoryRoot,
			modelArtifactAvailabilityImpl: (model) => ({
				available: model.model !== missingModel.model,
				reason: 'missing',
			}),
			availableDiskBytesImpl: () => requiredBytes,
			buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
			verifyModelImpl: () => ({ canonicalDigest: DIGEST }),
			downloadModelImpl: () => {},
		}),
	);
	assert.equal(result.disk_preflight.required_bytes, requiredBytes.toString());
	assert.equal(result.models.filter((model) => model.status === 'downloaded').length, 1);
});

test('preserves non-availability verification failures without downloading', () => {
	let downloads = 0;
	const failure = new Error('runtime attestation changed');
	assert.throws(
		() =>
			prepareModelSet(
				{
					modelsDirectory: path.join(path.parse(process.cwd()).root, 'app-data', 'models'),
					modelSet: 'policy',
				},
				isolatedOrchestration({
					repositoryRoot: path.join(path.parse(process.cwd()).root, 'repo'),
					modelArtifactAvailabilityImpl: () => ({ available: true }),
					availableDiskBytesImpl: () => 100n * 1024n ** 3n,
					buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
					verifyModelImpl: () => {
						throw failure;
					},
					downloadModelImpl: () => {
						downloads += 1;
					},
				}),
			),
		(error) => error === failure,
	);
	assert.equal(downloads, 0);
});

test('downloads a model that explicitly becomes unavailable after inventory', () => {
	let attempts = 0;
	let downloads = 0;
	const result = prepareModelSet(
		{
			modelsDirectory: path.join(path.parse(process.cwd()).root, 'app-data', 'models'),
			modelSet: 'policy',
		},
		isolatedOrchestration({
			repositoryRoot: path.join(path.parse(process.cwd()).root, 'repo'),
			modelArtifactAvailabilityImpl: () => ({ available: true }),
			availableDiskBytesImpl: () => 100n * 1024n ** 3n,
			buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
			verifyModelImpl: (_executable, model) => {
				attempts += 1;
				if (model.model === POLICY_MODELS[0].model && attempts === 1) {
					throw new ModelUnavailableError(model, 'model file disappeared');
				}
				return { canonicalDigest: DIGEST };
			},
			downloadModelImpl: () => {
				downloads += 1;
			},
		}),
	);
	assert.equal(downloads, 1);
	assert.equal(result.models[0].status, 'downloaded');
});

test('releases the exclusive preparation lock after an orchestration failure', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-model-release-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repositoryRoot = path.join(root, 'repository');
	const modelsDirectory = path.join(root, 'app-data', 'models');
	fs.mkdirSync(repositoryRoot);
	assert.throws(
		() =>
			prepareModelSet(
				{ modelsDirectory, modelSet: 'policy' },
				{
					repositoryRoot,
					modelArtifactAvailabilityImpl: () => ({ available: true }),
					availableDiskBytesImpl: () => 100n * 1024n ** 3n,
					buildExecutableImpl: () => {
						throw new Error('build failed');
					},
				},
			),
		/build failed/,
	);
	assert.equal(fs.existsSync(path.join(modelsDirectory, '.muesly-eval-model-prepare.lock')), false);
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
				isolatedOrchestration({
					repositoryRoot: path.join(path.parse(process.cwd()).root, 'repo'),
					modelArtifactAvailabilityImpl: () => ({ available: false, reason: 'missing' }),
					availableDiskBytesImpl: () => 1n,
					buildExecutableImpl: () => {
						built = true;
					},
				}),
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
				isolatedOrchestration({
					repositoryRoot: path.join(path.parse(process.cwd()).root, 'repo'),
					modelArtifactAvailabilityImpl: () => ({ available: false, reason: 'missing' }),
					availableDiskBytesImpl: () => 100n * 1024n ** 3n,
					buildExecutableImpl: () => ({ executablePath: '/bin/transcribe-fixture' }),
					verifyModelImpl: (_executable, model) => {
						verified.push(model.model);
						throw new Error('canonical verification failed');
					},
					downloadModelImpl: (_executable, model) => downloaded.push(model.model),
				}),
			),
		/canonical verification failed/,
	);
	assert.deepEqual(verified, ['base-q5_1']);
	assert.deepEqual(downloaded, ['base-q5_1']);
});
