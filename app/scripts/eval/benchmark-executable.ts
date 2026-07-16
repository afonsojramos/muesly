import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { copyAttestedFileSnapshot } from './artifact-snapshot.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_LIBRARY_PATTERN = /(?:\.dll|\.dylib|\.so(?:\.[^/\\]+)*)$/i;
const HARDWARE_PROBE_FIELDS = new Set([
	'schema_version',
	'backend',
	'operating_system',
	'architecture',
	'hardware_profile',
	'accelerator',
	'benchmark_executable_sha256',
]);
const MODEL_PREPARATION_FIELDS = new Set(['schema_version', 'provider', 'model']);
const BENCHMARK_RUNTIME_ENVIRONMENT_NAMES = new Set([
	'ALL_PROXY',
	'APPDATA',
	'CUDA_DEVICE_ORDER',
	'CUDA_HOME',
	'CUDA_PATH',
	'CUDA_VISIBLE_DEVICES',
	'DYLD_FALLBACK_LIBRARY_PATH',
	'DYLD_LIBRARY_PATH',
	'HOME',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'LANG',
	'LC_ALL',
	'LOCALAPPDATA',
	'NO_PROXY',
	'PATH',
	'Path',
	'PATHEXT',
	'ROCM_PATH',
	'SSL_CERT_DIR',
	'SSL_CERT_FILE',
	'SystemRoot',
	'TEMP',
	'TMP',
	'TMPDIR',
	'USERPROFILE',
	'VULKAN_SDK',
	'WINDIR',
	'XDG_CACHE_HOME',
	'all_proxy',
	'http_proxy',
	'https_proxy',
	'no_proxy',
]);
const BENCHMARK_RUNTIME_ENVIRONMENT_PREFIXES = [
	'BLIS_',
	'COREML_',
	'CUDA_',
	'GGML_',
	'GOMP_',
	'GPU_',
	'HIP_',
	'HSA_',
	'KMP_',
	'METAL_',
	'MKL_',
	'NVIDIA_',
	'OMP_',
	'OPENBLAS_',
	'ORT_',
	'RAYON_',
	'ROCM_',
	'ROCR_',
	'VECLIB_',
	'VK_',
	'WHISPER_',
];
const BENCHMARK_DEFINITIONS = new Map([
	[
		'whisper/cpu',
		{
			realRunBackend: 'cpu',
			cargoFeatures: [],
			platforms: ['macos/aarch64', 'macos/x86_64', 'linux/x86_64', 'windows/x86_64'],
		},
	],
	[
		'whisper/metal',
		{
			realRunBackend: 'metal',
			cargoFeatures: ['metal'],
			platforms: ['macos/aarch64', 'macos/x86_64'],
		},
	],
	[
		'whisper/coreml-metal',
		{
			realRunBackend: 'coreml',
			cargoFeatures: ['coreml'],
			platforms: ['macos/aarch64', 'macos/x86_64'],
		},
	],
	[
		'whisper/cuda',
		{
			realRunBackend: 'cuda',
			cargoFeatures: ['cuda'],
			platforms: ['linux/x86_64', 'windows/x86_64'],
		},
	],
	[
		'whisper/vulkan',
		{
			realRunBackend: 'vulkan',
			cargoFeatures: ['vulkan'],
			platforms: ['linux/x86_64', 'windows/x86_64'],
		},
	],
	[
		'whisper/openblas-cpu',
		{
			realRunBackend: 'openblas',
			cargoFeatures: ['openblas'],
			platforms: ['macos/aarch64', 'macos/x86_64', 'linux/x86_64', 'windows/x86_64'],
		},
	],
	[
		'whisper/hipblas',
		{
			realRunBackend: 'hipblas',
			cargoFeatures: ['hipblas'],
			platforms: ['linux/x86_64'],
		},
	],
	[
		'parakeet/onnx-cpu',
		{
			realRunBackend: 'cpu',
			cargoFeatures: [],
			platforms: ['macos/aarch64', 'macos/x86_64', 'linux/x86_64', 'windows/x86_64'],
		},
	],
]);
const TARGET_TRIPLE_PLATFORMS = new Map([
	[
		'aarch64-apple-darwin',
		{
			operatingSystem: 'macos',
			architecture: 'aarch64',
		},
	],
	[
		'x86_64-apple-darwin',
		{
			operatingSystem: 'macos',
			architecture: 'x86_64',
		},
	],
	[
		'x86_64-unknown-linux-gnu',
		{
			operatingSystem: 'linux',
			architecture: 'x86_64',
		},
	],
	[
		'x86_64-pc-windows-msvc',
		{
			operatingSystem: 'windows',
			architecture: 'x86_64',
		},
	],
]);

function requiredString(value, field) {
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
		throw new Error(`${field} must be a non-empty trimmed string`);
	}
	if (
		[...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint < 0x20 || codePoint === 0x7f;
		})
	) {
		throw new Error(`${field} cannot contain control characters`);
	}
	return value;
}

function isGpuReportedBackend(backend) {
	return ['metal', 'coreml-metal', 'cuda', 'vulkan', 'hipblas'].includes(backend);
}

export function validateHardwareProfile(value, field = 'hardware profile') {
	const profile = requiredString(value, field);
	if (
		!/^cpu=[^;]+;logical_cpus=[1-9][0-9]*;memory_bytes=[1-9][0-9]*;runtime_env_sha256=[a-f0-9]{64}$/.test(
			profile,
		)
	) {
		throw new Error(
			`${field} must contain cpu, positive logical_cpus/memory_bytes, and runtime_env_sha256`,
		);
	}
	return profile;
}

function canonicalEnvironmentSha256(environment) {
	const entries = Object.entries(environment).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function benchmarkRuntimeEnvironment(
	baseEnvironment,
	{ accelerator, forceWhisperCpu, requireWhisperAcceleration },
) {
	if (baseEnvironment === null || typeof baseEnvironment !== 'object') {
		throw new Error('benchmark runtime base environment must be an object');
	}
	const environment = {};
	for (const [name, value] of Object.entries(baseEnvironment)) {
		if (typeof value !== 'string') continue;
		if (
			BENCHMARK_RUNTIME_ENVIRONMENT_NAMES.has(name) ||
			BENCHMARK_RUNTIME_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
		) {
			environment[name] = value;
		}
	}
	// MEMORY_GB changes the adaptive decoding policy and must never override
	// the actual system-memory observation in a benchmark process.
	delete environment.MEMORY_GB;
	// Engine logs can contain operational details and are not needed for the
	// transcript-free benchmark protocol.
	delete environment.RUST_LOG;
	// Hash only the allowlisted ambient runtime inputs. The three MUESLY policy
	// values below are already bound independently by the reported backend and
	// accelerator identity; including them here would make the same machine's
	// CPU and GPU runs appear to have different hardware profiles.
	const runtimeEnvironmentSha256 = canonicalEnvironmentSha256(environment);
	environment.MUESLY_EVAL_ACCELERATOR_ID = accelerator ?? '';
	environment.MUESLY_WHISPER_FORCE_CPU = forceWhisperCpu ? '1' : '0';
	environment.MUESLY_WHISPER_REQUIRE_ACCELERATION = requireWhisperAcceleration ? '1' : '0';
	environment.MUESLY_EVAL_RUNTIME_ENV_SHA256 = runtimeEnvironmentSha256;
	return environment;
}

export function benchmarkDefinitionForReportedBackend(provider, backend) {
	const normalizedProvider = requiredString(provider, 'benchmark provider');
	const normalizedBackend = requiredString(backend, 'reported benchmark backend');
	const definition = BENCHMARK_DEFINITIONS.get(`${normalizedProvider}/${normalizedBackend}`);
	if (!definition) {
		throw new Error(
			`unsupported reported benchmark backend '${normalizedProvider}/${normalizedBackend}'`,
		);
	}
	return {
		provider: normalizedProvider,
		reportedBackend: normalizedBackend,
		realRunBackend: definition.realRunBackend,
		cargoFeatures: [...definition.cargoFeatures],
		platforms: [...definition.platforms],
	};
}

export function evaluatorPlatformForTargetTriple(targetTriple) {
	const normalizedTargetTriple = requiredString(targetTriple, 'evaluator revision target triple');
	const platform = TARGET_TRIPLE_PLATFORMS.get(normalizedTargetTriple);
	if (!platform) {
		throw new Error(`unsupported evaluator revision target triple '${normalizedTargetTriple}'`);
	}
	return { ...platform };
}

export function assertBenchmarkPlatform(provider, backend, operatingSystem, architecture) {
	const definition = benchmarkDefinitionForReportedBackend(provider, backend);
	const normalizedOperatingSystem = requiredString(operatingSystem, 'benchmark operating system');
	const normalizedArchitecture = requiredString(architecture, 'benchmark architecture');
	const platform = `${normalizedOperatingSystem}/${normalizedArchitecture}`;
	if (!definition.platforms.includes(platform)) {
		throw new Error(
			`${definition.provider}/${definition.reportedBackend} is not supported on ${platform}`,
		);
	}
	return {
		operatingSystem: normalizedOperatingSystem,
		architecture: normalizedArchitecture,
	};
}

function expectedReportedBackend(provider, backend) {
	const normalizedProvider = requiredString(provider, 'benchmark provider');
	const normalizedBackend = requiredString(backend, 'benchmark backend');
	for (const [key, definition] of BENCHMARK_DEFINITIONS) {
		const [definitionProvider, reportedBackend] = key.split('/');
		if (
			definitionProvider === normalizedProvider &&
			definition.realRunBackend === normalizedBackend
		) {
			return reportedBackend;
		}
	}
	if (normalizedProvider === 'parakeet') {
		throw new Error('Parakeet benchmark builds require the cpu backend');
	}
	if (normalizedProvider !== 'whisper') {
		throw new Error(`unsupported benchmark provider '${normalizedProvider}'`);
	}
	throw new Error(`unsupported Whisper benchmark backend '${normalizedBackend}'`);
}

export function cargoFeaturesForBenchmark(provider, backend) {
	const reportedBackend = expectedReportedBackend(provider, backend);
	return benchmarkDefinitionForReportedBackend(provider, reportedBackend).cargoFeatures;
}

function executableFromCargoMessages(stdout, repositoryRoot) {
	const executablePaths = new Set();
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			message?.reason === 'compiler-artifact' &&
			message.target?.name === 'transcribe-fixture' &&
			Array.isArray(message.target.kind) &&
			message.target.kind.includes('example') &&
			typeof message.executable === 'string'
		) {
			executablePaths.add(path.resolve(repositoryRoot, message.executable));
		}
	}
	if (executablePaths.size !== 1) {
		throw new Error(
			`cargo did not identify exactly one transcribe-fixture executable (found ${executablePaths.size})`,
		);
	}
	const [reportedPath] = executablePaths;
	let status;
	let canonicalPath;
	try {
		status = fs.lstatSync(reportedPath, { bigint: true });
		canonicalPath = fs.realpathSync(reportedPath);
	} catch {
		throw new Error('cargo reported an unreadable transcribe-fixture executable');
	}
	if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1n) {
		throw new Error('cargo reported a non-regular transcribe-fixture executable');
	}
	return canonicalPath;
}

function sameFileSnapshot(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function runtimeLibraryRecords(executablePath) {
	const executableDirectory = path.dirname(executablePath);
	const initialDirectory = fs.lstatSync(executableDirectory, { bigint: true });
	if (!initialDirectory.isDirectory() || initialDirectory.isSymbolicLink()) {
		throw new Error('benchmark executable directory is not a real directory');
	}
	const records = [];
	for (const filename of fs.readdirSync(executableDirectory).sort()) {
		if (!RUNTIME_LIBRARY_PATTERN.test(filename)) continue;
		const libraryPath = path.join(executableDirectory, filename);
		const status = fs.lstatSync(libraryPath, { bigint: true, throwIfNoEntry: false });
		if (status?.isSymbolicLink()) {
			const linkTarget = fs.readlinkSync(libraryPath);
			let resolvedPath;
			try {
				resolvedPath = fs.realpathSync(libraryPath);
			} catch {
				throw new Error('benchmark runtime library link cannot be resolved safely');
			}
			const targetStatus = fs.lstatSync(resolvedPath, { bigint: true });
			if (!targetStatus.isFile() || targetStatus.isSymbolicLink() || targetStatus.nlink !== 1n) {
				throw new Error('benchmark runtime library links must resolve to unaliased files');
			}
			const sha256 = benchmarkExecutableSha256(resolvedPath);
			const finalStatus = fs.lstatSync(libraryPath, { bigint: true });
			if (
				!finalStatus.isSymbolicLink() ||
				!sameFileSnapshot(status, finalStatus) ||
				fs.readlinkSync(libraryPath) !== linkTarget
			) {
				throw new Error('benchmark runtime library link changed while it was being hashed');
			}
			records.push({ filename, sha256, sourcePath: resolvedPath });
			continue;
		}
		if (!status?.isFile() || status.nlink !== 1n) {
			throw new Error('benchmark runtime libraries must be regular unaliased files');
		}
		records.push({
			filename,
			sha256: benchmarkExecutableSha256(libraryPath),
			sourcePath: libraryPath,
		});
	}
	const finalDirectory = fs.lstatSync(executableDirectory, { bigint: true });
	if (
		!finalDirectory.isDirectory() ||
		finalDirectory.isSymbolicLink() ||
		!sameFileSnapshot(initialDirectory, finalDirectory)
	) {
		throw new Error('benchmark runtime library set changed while it was being hashed');
	}
	return records;
}

function runtimeLibraryManifest(records) {
	return records.map(({ filename, sha256 }) => ({ filename, sha256 }));
}

export function benchmarkRuntimeDependenciesSha256(executablePath) {
	return createHash('sha256')
		.update(
			JSON.stringify({
				schema_version: 1,
				libraries: runtimeLibraryManifest(runtimeLibraryRecords(executablePath)),
			}),
		)
		.digest('hex');
}

export function bindBenchmarkRuntimeDependencies(
	environment,
	runtimeDependenciesSha256,
	executablePath,
	{ platform = process.platform } = {},
) {
	if (environment === null || typeof environment !== 'object') {
		throw new Error('benchmark runtime environment must be an object');
	}
	if (!SHA256_PATTERN.test(runtimeDependenciesSha256)) {
		throw new Error('benchmark runtime dependency SHA-256 is invalid');
	}
	const normalizedExecutablePath = requiredString(
		executablePath,
		'benchmark runtime executable path',
	);
	const runtimeLibraryDirectory =
		platform === 'linux' ? path.dirname(path.resolve(normalizedExecutablePath)) : null;
	const currentDependenciesSha256 = environment.MUESLY_EVAL_RUNTIME_DEPENDENCIES_SHA256;
	if (currentDependenciesSha256 !== undefined) {
		if (currentDependenciesSha256 !== runtimeDependenciesSha256) {
			throw new Error('benchmark runtime environment is bound to different dependencies');
		}
		if (
			runtimeLibraryDirectory !== null &&
			environment.LD_LIBRARY_PATH !== runtimeLibraryDirectory
		) {
			throw new Error('benchmark runtime environment is bound to a different library directory');
		}
		return { ...environment };
	}
	const runtimeEnvironmentSha256 = environment.MUESLY_EVAL_RUNTIME_ENV_SHA256;
	if (!SHA256_PATTERN.test(runtimeEnvironmentSha256 ?? '')) {
		throw new Error('benchmark runtime environment SHA-256 is missing or invalid');
	}
	const boundEnvironment = {
		...environment,
		MUESLY_EVAL_RUNTIME_DEPENDENCIES_SHA256: runtimeDependenciesSha256,
		MUESLY_EVAL_RUNTIME_ENV_SHA256: createHash('sha256')
			.update(
				JSON.stringify({
					schema_version: 1,
					runtime_environment_sha256: runtimeEnvironmentSha256,
					runtime_dependencies_sha256: runtimeDependenciesSha256,
					runtime_library_binding:
						runtimeLibraryDirectory === null
							? 'platform-default'
							: 'LD_LIBRARY_PATH=benchmark-executable-directory-only',
				}),
			)
			.digest('hex'),
	};
	if (runtimeLibraryDirectory !== null) {
		boundEnvironment.LD_LIBRARY_PATH = runtimeLibraryDirectory;
	}
	return boundEnvironment;
}

export function benchmarkExecutableSha256(executablePath) {
	let descriptor;
	try {
		const pathBefore = fs.lstatSync(executablePath, { bigint: true });
		if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n) {
			throw new Error('probed benchmark executable is not a regular unaliased file');
		}
		descriptor = fs.openSync(
			executablePath,
			fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
		);
		const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
		if (
			!descriptorBefore.isFile() ||
			descriptorBefore.nlink !== 1n ||
			!sameFileSnapshot(pathBefore, descriptorBefore)
		) {
			throw new Error('probed benchmark executable changed while it was being opened');
		}
		const hash = createHash('sha256');
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
		const pathAfter = fs.lstatSync(executablePath, { bigint: true });
		if (
			!descriptorAfter.isFile() ||
			descriptorAfter.nlink !== 1n ||
			!pathAfter.isFile() ||
			pathAfter.nlink !== 1n ||
			!sameFileSnapshot(descriptorBefore, descriptorAfter) ||
			!sameFileSnapshot(descriptorAfter, pathAfter)
		) {
			throw new Error('probed benchmark executable changed while it was being hashed');
		}
		return hash.digest('hex');
	} catch {
		throw new Error('probed benchmark executable is unreadable');
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

export function stageBenchmarkExecutableSnapshot(
	executablePath,
	snapshotDirectory,
	expectedSha256,
	{ copyFileSnapshotImpl = copyAttestedFileSnapshot } = {},
) {
	if (!SHA256_PATTERN.test(expectedSha256)) {
		throw new Error('expected benchmark executable SHA-256 is invalid');
	}
	if (fs.lstatSync(snapshotDirectory, { throwIfNoEntry: false }) !== undefined) {
		throw new Error('benchmark executable snapshot destination already exists');
	}
	const snapshotPath = path.join(snapshotDirectory, path.basename(executablePath));
	try {
		fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
		const runtimeLibraries = runtimeLibraryRecords(executablePath);
		copyFileSnapshotImpl(executablePath, snapshotPath, {
			expectedSha256,
			label: 'benchmark executable snapshot',
			mode: 0o700,
		});
		for (const library of runtimeLibraries) {
			copyFileSnapshotImpl(library.sourcePath, path.join(snapshotDirectory, library.filename), {
				expectedSha256: library.sha256,
				label: 'benchmark runtime library snapshot',
				mode: 0o600,
			});
		}
		const snapshotSha256 = benchmarkExecutableSha256(snapshotPath);
		if (snapshotSha256 !== expectedSha256) {
			throw new Error('benchmark executable snapshot does not match the expected SHA-256');
		}
		const sourceRuntimeDependenciesSha256 = createHash('sha256')
			.update(
				JSON.stringify({
					schema_version: 1,
					libraries: runtimeLibraryManifest(runtimeLibraries),
				}),
			)
			.digest('hex');
		const snapshotRuntimeDependenciesSha256 = benchmarkRuntimeDependenciesSha256(snapshotPath);
		if (snapshotRuntimeDependenciesSha256 !== sourceRuntimeDependenciesSha256) {
			throw new Error('benchmark runtime library snapshot does not match the expected SHA-256');
		}
		return {
			executablePath: snapshotPath,
			sha256: snapshotSha256,
			runtimeDependenciesSha256: snapshotRuntimeDependenciesSha256,
		};
	} catch (error) {
		fs.rmSync(snapshotDirectory, { recursive: true, force: true });
		throw error;
	}
}

export function buildBenchmarkExecutable(
	repositoryRoot,
	{
		provider,
		backend,
		buildEnv = process.env,
		cargoExecutable = 'cargo',
		spawnSyncImpl = spawnSync,
	} = {},
) {
	const cargoFeatures = cargoFeaturesForBenchmark(provider, backend);
	const args = [
		'build',
		'--release',
		'-p',
		'muesly',
		'--no-default-features',
		...(cargoFeatures.length > 0 ? ['--features', cargoFeatures.join(',')] : []),
		'--example',
		'transcribe-fixture',
		'--message-format=json-render-diagnostics',
		'--color=never',
	];
	const build = spawnSyncImpl(cargoExecutable, args, {
		cwd: repositoryRoot,
		env: buildEnv,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		maxBuffer: 64 * 1024 * 1024,
	});
	if (build.error || build.status !== 0) {
		throw new Error(
			`failed to build transcribe-fixture for ${provider}/${backend} (exit ${
				build.status ?? 'signal'
			})`,
		);
	}
	return {
		cargoFeatures,
		executablePath: executableFromCargoMessages(build.stdout ?? '', repositoryRoot),
	};
}

export function validateHardwareProbe(probe, { provider, backend } = {}) {
	if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) {
		throw new Error('hardware probe must be a JSON object');
	}
	for (const field of Object.keys(probe)) {
		if (!HARDWARE_PROBE_FIELDS.has(field)) {
			throw new Error(`hardware probe field '${field}' is not allowed`);
		}
	}
	for (const field of HARDWARE_PROBE_FIELDS) {
		if (!Object.hasOwn(probe, field)) throw new Error(`hardware probe.${field} is required`);
	}
	if (probe.schema_version !== 1) throw new Error('hardware probe.schema_version must be 1');
	const expectedBackend = expectedReportedBackend(provider, backend);
	if (probe.backend !== expectedBackend) {
		throw new Error(
			`hardware probe backend '${probe.backend}' does not match requested '${expectedBackend}'`,
		);
	}
	for (const field of ['backend', 'operating_system', 'architecture', 'accelerator']) {
		requiredString(probe[field], `hardware probe.${field}`);
	}
	validateHardwareProfile(probe.hardware_profile, 'hardware probe.hardware_profile');
	assertBenchmarkPlatform(provider, probe.backend, probe.operating_system, probe.architecture);
	if (probe.accelerator.includes(';')) {
		throw new Error('hardware probe.accelerator cannot contain semicolons');
	}
	if (isGpuReportedBackend(probe.backend) && probe.accelerator.toLowerCase() === 'none') {
		throw new Error('hardware probe.accelerator must identify the measured GPU');
	}
	if (!isGpuReportedBackend(probe.backend) && probe.accelerator !== 'none') {
		throw new Error(`hardware probe.accelerator must be 'none' for ${probe.backend}`);
	}
	if (!SHA256_PATTERN.test(probe.benchmark_executable_sha256)) {
		throw new Error(
			'hardware probe.benchmark_executable_sha256 must be a lowercase SHA-256 digest',
		);
	}
	return probe;
}

export function probeBenchmarkExecutable(
	executablePath,
	{
		provider,
		backend,
		environment = process.env,
		platform = process.platform,
		spawnSyncImpl = spawnSync,
	} = {},
) {
	const executableSha256Before = benchmarkExecutableSha256(executablePath);
	const runtimeDependenciesSha256Before = benchmarkRuntimeDependenciesSha256(executablePath);
	const boundEnvironment = bindBenchmarkRuntimeDependencies(
		environment,
		runtimeDependenciesSha256Before,
		executablePath,
		{ platform },
	);
	const run = spawnSyncImpl(executablePath, ['--provider', provider, '--hardware-json'], {
		env: boundEnvironment,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		maxBuffer: 1024 * 1024,
	});
	const executableSha256After = benchmarkExecutableSha256(executablePath);
	if (executableSha256After !== executableSha256Before) {
		throw new Error('benchmark executable changed while the hardware probe was running');
	}
	if (benchmarkRuntimeDependenciesSha256(executablePath) !== runtimeDependenciesSha256Before) {
		throw new Error('benchmark runtime libraries changed while the hardware probe was running');
	}
	if (run.error || run.status !== 0) {
		throw new Error(
			`transcribe-fixture hardware probe failed for ${provider}/${backend} (exit ${
				run.status ?? 'signal'
			})`,
		);
	}
	let probe;
	try {
		probe = JSON.parse((run.stdout ?? '').trim());
	} catch {
		throw new Error('transcribe-fixture hardware probe returned invalid JSON');
	}
	const validatedProbe = validateHardwareProbe(probe, { provider, backend });
	if (validatedProbe.benchmark_executable_sha256 !== executableSha256Before) {
		throw new Error(
			'hardware probe benchmark executable digest does not match the exact probed executable',
		);
	}
	return validatedProbe;
}

export function prepareBenchmarkModel(
	executablePath,
	{
		provider,
		model,
		modelsDirectory,
		environment = process.env,
		platform = process.platform,
		spawnSyncImpl = spawnSync,
	} = {},
) {
	const normalizedProvider = requiredString(provider, 'benchmark provider');
	const normalizedModel = requiredString(model, 'benchmark model');
	const normalizedModelsDirectory = requiredString(modelsDirectory, 'benchmark models directory');
	const executableSha256Before = benchmarkExecutableSha256(executablePath);
	const runtimeDependenciesSha256Before = benchmarkRuntimeDependenciesSha256(executablePath);
	const boundEnvironment = bindBenchmarkRuntimeDependencies(
		environment,
		runtimeDependenciesSha256Before,
		executablePath,
		{ platform },
	);
	const run = spawnSyncImpl(
		executablePath,
		[
			'--provider',
			normalizedProvider,
			'--prepare-model-json',
			'--model',
			normalizedModel,
			'--models-dir',
			normalizedModelsDirectory,
		],
		{
			env: boundEnvironment,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit'],
			maxBuffer: 1024 * 1024,
		},
	);
	const executableSha256After = benchmarkExecutableSha256(executablePath);
	if (executableSha256After !== executableSha256Before) {
		throw new Error('benchmark executable changed while model preparation was running');
	}
	if (benchmarkRuntimeDependenciesSha256(executablePath) !== runtimeDependenciesSha256Before) {
		throw new Error('benchmark runtime libraries changed while model preparation was running');
	}
	if (run.error || run.status !== 0) {
		throw new Error(
			`transcribe-fixture model preparation failed for ${normalizedProvider}/${normalizedModel} ` +
				`(exit ${run.status ?? 'signal'})`,
		);
	}
	let result;
	try {
		result = JSON.parse((run.stdout ?? '').trim());
	} catch {
		throw new Error('transcribe-fixture model preparation returned invalid JSON');
	}
	if (result === null || typeof result !== 'object' || Array.isArray(result)) {
		throw new Error('transcribe-fixture model preparation must return a JSON object');
	}
	for (const field of Object.keys(result)) {
		if (!MODEL_PREPARATION_FIELDS.has(field)) {
			throw new Error(`model preparation field '${field}' is not allowed`);
		}
	}
	for (const field of MODEL_PREPARATION_FIELDS) {
		if (!Object.hasOwn(result, field)) throw new Error(`model preparation.${field} is required`);
	}
	if (result.schema_version !== 1) throw new Error('model preparation.schema_version must be 1');
	if (result.provider !== normalizedProvider) {
		throw new Error('model preparation.provider does not match the requested provider');
	}
	if (result.model !== normalizedModel) {
		throw new Error('model preparation.model does not match the requested model');
	}
	return result;
}
