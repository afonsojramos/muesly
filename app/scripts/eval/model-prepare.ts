#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
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

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(here, '../../..');
export const SILENCE_FIXTURE = path.join(here, 'fixtures', 'silence.wav');

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
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

export function modelsForSet(modelSet) {
	const models = MODEL_SETS.get(modelSet);
	if (models === undefined) {
		throw new Error(`unknown model preparation set: ${modelSet}`);
	}
	return [...models];
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
	const modelsDirectory = resolveExplicitModelsDirectory(options.modelsDirectory, repositoryRoot);
	const models = modelsForSet(options.modelSet);
	const disk = assertModelPreparationDiskSpace(models, availableDiskBytesImpl(modelsDirectory));
	const firstModel = models[0];
	const build = buildExecutableImpl(repositoryRoot, {
		provider: firstModel.provider,
		backend: 'cpu',
		buildEnv,
		spawnSyncImpl,
	});
	const results = [];

	for (const [index, model] of models.entries()) {
		onProgress({ phase: 'checking', index, total: models.length, model });
		let verification;
		let status = 'already-ready';
		try {
			verification = verifyModelImpl(build.executablePath, model, modelsDirectory, {
				environment: runtimeEnvironment,
				spawnSyncImpl,
			});
		} catch {
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
		}
		results.push({
			provider: model.provider,
			model: model.model,
			status,
			model_artifact_sha256: verification.canonicalDigest,
		});
		onProgress({ phase: 'ready', index, total: models.length, model });
	}

	return {
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
