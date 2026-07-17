#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	benchmarkRuntimeDependenciesSha256,
	benchmarkRuntimeEnvironment,
	bindBenchmarkRuntimeDependencies,
	buildBenchmarkExecutable,
	prepareBenchmarkModel,
} from './benchmark-executable.ts';
import { modelArtifactSha256 } from './model-artifact.ts';
import { processIdentity, processOwnsState } from './process-identity.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(here, '../../..');
export const SILENCE_FIXTURE = path.join(here, 'fixtures', 'silence.wav');

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const PREPARATION_LOCK_DIRECTORY = '.muesly-eval-model-prepare.lock';
const PREPARATION_LOCK_OWNER = 'owner.json';
const PREPARATION_LOCK_SCHEMA_VERSION = 1;
const MAX_LOCK_OWNER_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_OWNER_FIELDS = new Set([
	'schema_version',
	'pid',
	'process_identity',
	'token',
	'created_at',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MODEL_PREPARATION_RESERVE_BYTES = 20 * GIB;

export const POLICY_MODELS = Object.freeze([
	{ provider: 'whisper', model: 'base-q5_1', downloadBytes: 57 * MIB },
	{ provider: 'whisper', model: 'small-q5_1', downloadBytes: 181 * MIB },
	{ provider: 'whisper', model: 'medium-q5_0', downloadBytes: 514 * MIB },
	{ provider: 'whisper', model: 'large-v3-turbo-q5_0', downloadBytes: 547 * MIB },
	{ provider: 'whisper', model: 'large-v3-q5_0', downloadBytes: 1_031 * MIB },
	{
		provider: 'parakeet',
		model: 'parakeet-tdt-0.6b-v3-int8',
		downloadBytes: 641 * MIB,
	},
]);

export const CATALOG_AUDIT_MODELS = Object.freeze([
	{ provider: 'whisper', model: 'tiny-q5_1', downloadBytes: 31 * MIB },
	{ provider: 'whisper', model: 'tiny', downloadBytes: 75 * MIB },
	{ provider: 'whisper', model: 'base', downloadBytes: 142 * MIB },
	{ provider: 'whisper', model: 'small', downloadBytes: 466 * MIB },
	{ provider: 'whisper', model: 'medium', downloadBytes: 1_463 * MIB },
	{ provider: 'whisper', model: 'large-v3-turbo', downloadBytes: 1_549 * MIB },
	{ provider: 'whisper', model: 'large-v3', downloadBytes: 2_951 * MIB },
]);

const MODEL_SETS = new Map([
	['policy', POLICY_MODELS],
	['catalog-audit', CATALOG_AUDIT_MODELS],
	['all', Object.freeze([...POLICY_MODELS, ...CATALOG_AUDIT_MODELS])],
]);

const PARAKEET_ARTIFACT_FILES = Object.freeze([
	'encoder-model.int8.onnx',
	'decoder_joint-model.int8.onnx',
	'nemo128.onnx',
	'vocab.txt',
]);

function requiredOptionValue(args, index, option) {
	const value = args[index + 1];
	if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
		throw new Error(`${option} requires a value`);
	}
	return value;
}

export function parseModelPreparationArgs(args) {
	let modelsDirectory = null;
	let modelSet = 'all';
	const seen = new Set();

	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (option !== '--models-dir' && option !== '--set') {
			throw new Error(`unknown option: ${option}`);
		}
		if (seen.has(option)) throw new Error(`${option} may only be provided once`);
		seen.add(option);
		const value = requiredOptionValue(args, index, option);
		index += 1;
		if (option === '--models-dir') modelsDirectory = value;
		else modelSet = value;
	}

	if (modelsDirectory === null) {
		throw new Error('--models-dir is required; pass the explicit muesly app-data model directory');
	}
	if (!MODEL_SETS.has(modelSet)) {
		throw new Error("--set must be one of 'policy', 'catalog-audit', or 'all'");
	}
	return { modelsDirectory, modelSet };
}

export function resolveExplicitModelsDirectory(modelsDirectory, repositoryRoot = REPOSITORY_ROOT) {
	if (
		typeof modelsDirectory !== 'string' ||
		modelsDirectory.trim().length === 0 ||
		!path.isAbsolute(modelsDirectory)
	) {
		throw new Error('--models-dir must be an explicit absolute path');
	}
	const resolved = path.resolve(modelsDirectory);
	const relativeToRepository = path.relative(path.resolve(repositoryRoot), resolved);
	if (
		relativeToRepository === '' ||
		(!relativeToRepository.startsWith(`..${path.sep}`) &&
			relativeToRepository !== '..' &&
			!path.isAbsolute(relativeToRepository))
	) {
		throw new Error('--models-dir must be outside the repository; model binaries are local-only');
	}
	return resolved;
}

function entryAt(filePath) {
	return fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
}

function followedDirectoryAt(filePath, label) {
	let canonicalPath;
	try {
		canonicalPath = fs.realpathSync(filePath);
	} catch {
		throw new Error(`${label} must resolve to an existing directory: ${filePath}`);
	}
	const status = fs.lstatSync(canonicalPath, { bigint: true });
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`${label} must resolve to a real directory: ${filePath}`);
	}
	return { canonicalPath, status };
}

function directoryIdentity(status) {
	return { dev: status.dev.toString(), ino: status.ino.toString() };
}

function sameDirectoryIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameCanonicalPath(left, right) {
	return path.relative(left, right) === '';
}

function isWithinOrEqual(directory, candidate) {
	const relative = path.relative(directory, candidate);
	return (
		relative === '' ||
		(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

function nearestExistingAncestor(targetPath) {
	let candidate = path.resolve(targetPath);
	const missingParts = [];
	for (;;) {
		if (entryAt(candidate) !== undefined) {
			const followed = followedDirectoryAt(candidate, 'models directory ancestor');
			return {
				inputPath: candidate,
				canonicalPath: followed.canonicalPath,
				identity: directoryIdentity(followed.status),
				missingParts,
			};
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) {
			throw new Error(`could not find an existing parent for --models-dir: ${targetPath}`);
		}
		missingParts.unshift(path.basename(candidate));
		candidate = parent;
	}
}

function assertDirectorySnapshotUnchanged(snapshot, label) {
	const current = followedDirectoryAt(snapshot.inputPath, label);
	if (
		!sameCanonicalPath(snapshot.canonicalPath, current.canonicalPath) ||
		!sameDirectoryIdentity(snapshot.identity, directoryIdentity(current.status))
	) {
		throw new Error(`${label} changed while the models directory was prepared`);
	}
}

/**
 * Create and canonicalize the local-only model directory without allowing an
 * outside lexical path to escape through a symlink or Windows junction into
 * the repository.
 */
export function prepareExternalModelsDirectory(
	modelsDirectory,
	repositoryRoot = REPOSITORY_ROOT,
	{ mkdirSyncImpl = fs.mkdirSync } = {},
) {
	const resolved = resolveExplicitModelsDirectory(modelsDirectory, repositoryRoot);
	const repository = followedDirectoryAt(repositoryRoot, 'repository root');
	const repositorySnapshot = {
		inputPath: path.resolve(repositoryRoot),
		canonicalPath: repository.canonicalPath,
		identity: directoryIdentity(repository.status),
	};
	const ancestor = nearestExistingAncestor(resolved);
	const expectedCanonicalPath = path.resolve(ancestor.canonicalPath, ...ancestor.missingParts);
	if (isWithinOrEqual(repository.canonicalPath, expectedCanonicalPath)) {
		throw new Error(
			'--models-dir resolves inside the repository through a symlink or directory junction',
		);
	}
	if (expectedCanonicalPath === path.parse(expectedCanonicalPath).root) {
		throw new Error('--models-dir cannot be a filesystem root');
	}

	mkdirSyncImpl(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	assertDirectorySnapshotUnchanged(repositorySnapshot, 'repository root');
	assertDirectorySnapshotUnchanged(ancestor, 'models directory ancestor');
	const installed = followedDirectoryAt(resolved, 'models directory');
	if (
		!sameCanonicalPath(expectedCanonicalPath, installed.canonicalPath) ||
		isWithinOrEqual(repository.canonicalPath, installed.canonicalPath)
	) {
		throw new Error(
			'--models-dir changed or escaped through a symlink or directory junction while it was created',
		);
	}
	return installed.canonicalPath;
}

function lockEntryMetadata(status) {
	return {
		dev: status.dev.toString(),
		ino: status.ino.toString(),
		mode: status.mode.toString(),
		nlink: status.nlink.toString(),
		size: status.size.toString(),
		mtimeNs: status.mtimeNs.toString(),
		ctimeNs: status.ctimeNs.toString(),
	};
}

function sameLockEntry(left, right) {
	return Object.keys(left).every((field) => left[field] === right[field]);
}

function sameLockIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function readLockOwnerFile(ownerPath) {
	const before = fs.lstatSync(ownerPath, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
		throw new Error(
			`model preparation lock owner must be a regular single-link file: ${ownerPath}`,
		);
	}
	if (process.platform !== 'win32' && Number(before.mode & 0o777n) !== PRIVATE_FILE_MODE) {
		throw new Error(`model preparation lock owner must have private permissions: ${ownerPath}`);
	}
	if (before.size > BigInt(MAX_LOCK_OWNER_BYTES)) {
		throw new Error(`model preparation lock owner is too large: ${ownerPath}`);
	}
	const descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const openedBefore = fs.fstatSync(descriptor, { bigint: true });
		if (!sameLockEntry(lockEntryMetadata(before), lockEntryMetadata(openedBefore))) {
			throw new Error(`model preparation lock owner changed while it was opened: ${ownerPath}`);
		}
		const contents = fs.readFileSync(descriptor, 'utf8');
		const openedAfter = fs.fstatSync(descriptor, { bigint: true });
		const after = fs.lstatSync(ownerPath, { bigint: true, throwIfNoEntry: false });
		if (
			!after?.isFile() ||
			after.isSymbolicLink() ||
			!sameLockEntry(lockEntryMetadata(openedBefore), lockEntryMetadata(openedAfter)) ||
			!sameLockEntry(lockEntryMetadata(openedAfter), lockEntryMetadata(after))
		) {
			throw new Error(`model preparation lock owner changed while it was read: ${ownerPath}`);
		}
		return { contents, metadata: lockEntryMetadata(after) };
	} finally {
		fs.closeSync(descriptor);
	}
}

function validateLockOwner(owner, ownerPath) {
	if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
		throw new Error(`model preparation lock owner is invalid: ${ownerPath}`);
	}
	for (const field of Object.keys(owner)) {
		if (!LOCK_OWNER_FIELDS.has(field)) {
			throw new Error(`model preparation lock owner has an unknown field '${field}': ${ownerPath}`);
		}
	}
	const timestamp = Date.parse(owner.created_at);
	if (
		owner.schema_version !== PREPARATION_LOCK_SCHEMA_VERSION ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid < 1 ||
		(owner.process_identity !== null &&
			(typeof owner.process_identity !== 'string' || owner.process_identity.length === 0)) ||
		typeof owner.token !== 'string' ||
		!UUID_PATTERN.test(owner.token) ||
		!Number.isFinite(timestamp) ||
		new Date(timestamp).toISOString() !== owner.created_at
	) {
		throw new Error(`model preparation lock owner is invalid: ${ownerPath}`);
	}
	return owner;
}

function readPreparationLock(lockPath) {
	const lockStatus = fs.lstatSync(lockPath, { bigint: true });
	if (!lockStatus.isDirectory() || lockStatus.isSymbolicLink()) {
		throw new Error(`model preparation lock must be a real directory: ${lockPath}`);
	}
	if (process.platform !== 'win32' && Number(lockStatus.mode & 0o777n) !== PRIVATE_DIRECTORY_MODE) {
		throw new Error(`model preparation lock must have private permissions: ${lockPath}`);
	}
	const ownerPath = path.join(lockPath, PREPARATION_LOCK_OWNER);
	const ownerFile = readLockOwnerFile(ownerPath);
	let parsed;
	try {
		parsed = JSON.parse(ownerFile.contents);
	} catch {
		throw new Error(`model preparation lock owner is not valid JSON: ${ownerPath}`);
	}
	return {
		lockMetadata: lockEntryMetadata(lockStatus),
		ownerMetadata: ownerFile.metadata,
		owner: validateLockOwner(parsed, ownerPath),
	};
}

function sameOwner(left, right) {
	return (
		left.pid === right.pid &&
		left.process_identity === right.process_identity &&
		left.token === right.token &&
		left.created_at === right.created_at
	);
}

function moveOwnedLockAside(lockPath, snapshot, suffix) {
	const tombstone = `${lockPath}.${suffix}-${randomUUID()}`;
	fs.renameSync(lockPath, tombstone);
	const moved = readPreparationLock(tombstone);
	if (
		!sameLockIdentity(snapshot.lockMetadata, moved.lockMetadata) ||
		!sameLockEntry(snapshot.ownerMetadata, moved.ownerMetadata) ||
		!sameOwner(snapshot.owner, moved.owner)
	) {
		throw new Error('model preparation lock changed while ownership was recovered');
	}
	return tombstone;
}

function standardLockSnapshotMatches(left, right) {
	return (
		sameLockEntry(left.lockMetadata, right.lockMetadata) &&
		sameLockEntry(left.ownerMetadata, right.ownerMetadata)
	);
}

export function acquireModelPreparationLock(
	modelsDirectory,
	{ currentIdentity = processIdentity(process.pid), isOwnedByLiveProcess = processOwnsState } = {},
) {
	const lockPath = path.join(modelsDirectory, PREPARATION_LOCK_DIRECTORY);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			fs.mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
			const owner = {
				schema_version: PREPARATION_LOCK_SCHEMA_VERSION,
				pid: process.pid,
				process_identity: currentIdentity,
				token: randomUUID(),
				created_at: new Date().toISOString(),
			};
			try {
				fs.writeFileSync(
					path.join(lockPath, PREPARATION_LOCK_OWNER),
					`${JSON.stringify(owner)}\n`,
					{ flag: 'wx', mode: PRIVATE_FILE_MODE },
				);
				return { lockPath, owner, snapshot: readPreparationLock(lockPath) };
			} catch (error) {
				fs.rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
			const existing = readPreparationLock(lockPath);
			if (isOwnedByLiveProcess(existing.owner)) {
				throw new Error(
					`model preparation is already running for this models directory (pid ${existing.owner.pid})`,
				);
			}
			const stalePath = moveOwnedLockAside(lockPath, existing, 'stale');
			fs.rmSync(stalePath, { recursive: true, force: true });
		}
	}
	throw new Error('could not acquire the model preparation lock');
}

export function releaseModelPreparationLock(lock) {
	const current = readPreparationLock(lock.lockPath);
	if (
		!standardLockSnapshotMatches(lock.snapshot, current) ||
		!sameOwner(lock.owner, current.owner) ||
		current.owner.pid !== process.pid
	) {
		throw new Error('the current process no longer owns the model preparation lock');
	}
	const releasedPath = moveOwnedLockAside(lock.lockPath, current, 'released');
	fs.rmSync(releasedPath, { recursive: true, force: true });
}

export function modelsForSet(modelSet) {
	const models = MODEL_SETS.get(modelSet);
	if (models === undefined) {
		throw new Error(`unknown model preparation set: ${modelSet}`);
	}
	return [...models];
}

export class ModelUnavailableError extends Error {
	constructor(model, message) {
		super(`${model.provider}/${model.model} is unavailable: ${message}`);
		this.name = 'ModelUnavailableError';
		this.code = 'MUESLY_MODEL_UNAVAILABLE';
	}
}

export function modelArtifactAvailability(model, modelsDirectory) {
	if (model.provider === 'whisper') {
		const modelPath = path.join(modelsDirectory, `ggml-${model.model}.bin`);
		const status = entryAt(modelPath);
		if (status === undefined) return { available: false, reason: 'model file is missing' };
		if (!status.isFile() || status.isSymbolicLink()) {
			throw new Error(`${model.provider}/${model.model} artifact must be a regular file`);
		}
		return { available: true };
	}
	if (model.provider !== 'parakeet') {
		throw new Error(`unsupported model provider: ${model.provider}`);
	}
	const modelDirectory = path.join(modelsDirectory, 'parakeet', model.model);
	const directoryStatus = entryAt(modelDirectory);
	if (directoryStatus === undefined) {
		return { available: false, reason: 'model directory is missing' };
	}
	if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
		throw new Error(`${model.provider}/${model.model} artifact must be a real directory`);
	}
	const missingFiles = [];
	for (const filename of PARAKEET_ARTIFACT_FILES) {
		const fileStatus = entryAt(path.join(modelDirectory, filename));
		if (fileStatus === undefined) {
			missingFiles.push(filename);
			continue;
		}
		if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
			throw new Error(
				`${model.provider}/${model.model} artifact file must be regular: ${filename}`,
			);
		}
	}
	return missingFiles.length === 0
		? { available: true }
		: { available: false, reason: `required files are missing: ${missingFiles.join(', ')}` };
}

function requireModelArtifactAvailable(model, modelsDirectory) {
	const availability = modelArtifactAvailability(model, modelsDirectory);
	if (!availability.available) {
		throw new ModelUnavailableError(model, availability.reason);
	}
	return availability;
}

function isModelUnavailableError(error) {
	return error instanceof ModelUnavailableError && error.code === 'MUESLY_MODEL_UNAVAILABLE';
}

function nearestExistingDirectory(targetPath) {
	let candidate = path.resolve(targetPath);
	for (;;) {
		const status = fs.lstatSync(candidate, { throwIfNoEntry: false });
		if (status !== undefined) {
			if (!status.isDirectory() || status.isSymbolicLink()) {
				throw new Error(
					`disk-space probe path must resolve through a real directory: ${candidate}`,
				);
			}
			return candidate;
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) {
			throw new Error(`could not find an existing parent for --models-dir: ${targetPath}`);
		}
		candidate = parent;
	}
}

export function availableDiskBytes(targetPath, { statfsSyncImpl = fs.statfsSync } = {}) {
	const probeDirectory = nearestExistingDirectory(targetPath);
	const status = statfsSyncImpl(probeDirectory, { bigint: true });
	return status.bavail * status.bsize;
}

function formatGiB(bytes) {
	return (Number(bytes) / GIB).toFixed(1);
}

export function assertModelPreparationDiskSpace(
	models,
	availableBytes,
	{ reserveBytes = MODEL_PREPARATION_RESERVE_BYTES } = {},
) {
	if (typeof availableBytes !== 'bigint' || availableBytes < 0n) {
		throw new Error('available disk space must be a non-negative bigint');
	}
	const downloadBytes = models.reduce((total, model) => total + model.downloadBytes, 0);
	const requiredBytes = BigInt(downloadBytes + reserveBytes);
	if (availableBytes < requiredBytes) {
		throw new Error(
			`insufficient disk space for model preparation: need ${formatGiB(
				requiredBytes,
			)} GiB including the 20 GiB reserve, but ${formatGiB(availableBytes)} GiB is available`,
		);
	}
	return { availableBytes, downloadBytes: BigInt(downloadBytes), requiredBytes };
}

function reportedBackendFor(model) {
	return model.provider === 'parakeet' ? 'onnx-cpu' : 'cpu';
}

export function verifyCanonicalModel(
	executablePath,
	model,
	modelsDirectory,
	{
		prepareModelImpl = prepareBenchmarkModel,
		modelArtifactSha256Impl = modelArtifactSha256,
		environment = process.env,
		platform = process.platform,
		spawnSyncImpl = spawnSync,
	} = {},
) {
	requireModelArtifactAvailable(model, modelsDirectory);
	const reportedBackend = reportedBackendFor(model);
	const prepared = prepareModelImpl(executablePath, {
		provider: model.provider,
		model: model.model,
		modelsDirectory,
		reportedBackend,
		environment,
		platform,
		spawnSyncImpl,
	});
	const canonicalDigest = prepared.model_artifact_sha256;
	if (typeof canonicalDigest !== 'string') {
		throw new Error(`${model.provider}/${model.model} did not report a canonical artifact digest`);
	}
	const localDigest = modelArtifactSha256Impl(
		model.provider,
		model.model,
		modelsDirectory,
		reportedBackend,
	);
	if (localDigest !== canonicalDigest) {
		throw new Error(
			`${model.provider}/${model.model} local artifact digest does not match its canonical pin`,
		);
	}
	return { canonicalDigest, prepared };
}

export function downloadModelWithProductPath(
	executablePath,
	model,
	modelsDirectory,
	{
		repositoryRoot = REPOSITORY_ROOT,
		silenceFixture = SILENCE_FIXTURE,
		environment = process.env,
		platform = process.platform,
		benchmarkRuntimeDependenciesSha256Impl = benchmarkRuntimeDependenciesSha256,
		bindBenchmarkRuntimeDependenciesImpl = bindBenchmarkRuntimeDependencies,
		spawnSyncImpl = spawnSync,
	} = {},
) {
	const runtimeDependenciesSha256 = benchmarkRuntimeDependenciesSha256Impl(executablePath, {
		platform,
	});
	const boundEnvironment = bindBenchmarkRuntimeDependenciesImpl(
		environment,
		runtimeDependenciesSha256,
		executablePath,
		{ platform },
	);
	const args = [
		'--provider',
		model.provider,
		...(model.provider === 'whisper' ? ['--language', 'en'] : []),
		'--vad',
		silenceFixture,
		model.model,
		modelsDirectory,
	];
	const run = spawnSyncImpl(executablePath, args, {
		cwd: repositoryRoot,
		env: boundEnvironment,
		encoding: 'utf8',
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	if (run.error || run.status !== 0) {
		throw new Error(
			`product model download failed for ${model.provider}/${model.model} (exit ${
				run.status ?? 'signal'
			})`,
		);
	}
}

export function prepareModelSet(
	options,
	{
		repositoryRoot = REPOSITORY_ROOT,
		prepareModelsDirectoryImpl = prepareExternalModelsDirectory,
		acquirePreparationLockImpl = acquireModelPreparationLock,
		releasePreparationLockImpl = releaseModelPreparationLock,
		modelArtifactAvailabilityImpl = modelArtifactAvailability,
		availableDiskBytesImpl = availableDiskBytes,
		buildExecutableImpl = buildBenchmarkExecutable,
		verifyModelImpl = verifyCanonicalModel,
		downloadModelImpl = downloadModelWithProductPath,
		onProgress = () => {},
		buildEnv = process.env,
		runtimeEnvironment = benchmarkRuntimeEnvironment(process.env, {
			accelerator: null,
			forceWhisperCpu: true,
			requireWhisperAcceleration: false,
		}),
		spawnSyncImpl = spawnSync,
	} = {},
) {
	const modelsDirectory = prepareModelsDirectoryImpl(options.modelsDirectory, repositoryRoot);
	const models = modelsForSet(options.modelSet);
	const lock = acquirePreparationLockImpl(modelsDirectory);
	let result;
	let primaryError;
	try {
		const pendingDownloads = new Map();
		for (const model of models) {
			const availability = modelArtifactAvailabilityImpl(model, modelsDirectory);
			if (!availability.available) {
				pendingDownloads.set(`${model.provider}/${model.model}`, model);
			}
		}
		let disk = assertModelPreparationDiskSpace(
			[...pendingDownloads.values()],
			availableDiskBytesImpl(modelsDirectory),
		);
		const firstModel = models[0];
		const build = buildExecutableImpl(repositoryRoot, {
			provider: firstModel.provider,
			backend: 'cpu',
			buildEnv,
			spawnSyncImpl,
		});
		const results = [];

		for (const [index, model] of models.entries()) {
			const key = `${model.provider}/${model.model}`;
			onProgress({ phase: 'checking', index, total: models.length, model });
			let verification;
			let status = 'already-ready';
			if (!pendingDownloads.has(key)) {
				try {
					verification = verifyModelImpl(build.executablePath, model, modelsDirectory, {
						environment: runtimeEnvironment,
						spawnSyncImpl,
					});
				} catch (error) {
					if (!isModelUnavailableError(error)) throw error;
					pendingDownloads.set(key, model);
					disk = assertModelPreparationDiskSpace(
						[...pendingDownloads.values()],
						availableDiskBytesImpl(modelsDirectory),
					);
				}
			}
			if (pendingDownloads.has(key)) {
				status = 'downloaded';
				onProgress({ phase: 'downloading', index, total: models.length, model });
				downloadModelImpl(build.executablePath, model, modelsDirectory, {
					repositoryRoot,
					environment: runtimeEnvironment,
					spawnSyncImpl,
				});
				onProgress({ phase: 'verifying', index, total: models.length, model });
				verification = verifyModelImpl(build.executablePath, model, modelsDirectory, {
					environment: runtimeEnvironment,
					spawnSyncImpl,
				});
				pendingDownloads.delete(key);
			}
			results.push({
				provider: model.provider,
				model: model.model,
				status,
				model_artifact_sha256: verification.canonicalDigest,
			});
			onProgress({ phase: 'ready', index, total: models.length, model });
		}

		result = {
			schema_version: 1,
			model_set: options.modelSet,
			models_directory: modelsDirectory,
			disk_preflight: {
				available_bytes: disk.availableBytes.toString(),
				required_bytes: disk.requiredBytes.toString(),
				reserve_bytes: MODEL_PREPARATION_RESERVE_BYTES.toString(),
			},
			models: results,
		};
	} catch (error) {
		primaryError = error;
	}
	try {
		releasePreparationLockImpl(lock);
	} catch (releaseError) {
		if (primaryError !== undefined) {
			throw new AggregateError(
				[primaryError, releaseError],
				primaryError instanceof Error ? primaryError.message : 'model preparation failed',
			);
		}
		throw releaseError;
	}
	if (primaryError !== undefined) throw primaryError;
	return result;
}

export function main(args = process.argv.slice(2)) {
	const options = parseModelPreparationArgs(args);
	const result = prepareModelSet(options, {
		onProgress: ({ phase, index, total, model }) => {
			process.stderr.write(`[${index + 1}/${total}] ${phase} ${model.provider}/${model.model}\n`);
		},
	});
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
