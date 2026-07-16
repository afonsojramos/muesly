import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	assertBenchmarkPlatform,
	benchmarkDefinitionForReportedBackend,
	benchmarkRuntimeEnvironment,
	buildBenchmarkExecutable,
	cargoFeaturesForBenchmark,
	evaluatorPlatformForTargetTriple,
	prepareBenchmarkModel,
	probeBenchmarkExecutable,
	validateHardwareProbe,
} from './benchmark-executable.ts';

function hardwareProbe(overrides = {}) {
	return {
		schema_version: 1,
		backend: 'metal',
		operating_system: 'macos',
		architecture: 'aarch64',
			hardware_profile:
				`cpu=Apple M5;logical_cpus=10;memory_bytes=17179869184;runtime_env_sha256=${'d'.repeat(64)}`,
		accelerator: 'Apple M5 integrated GPU',
		benchmark_executable_sha256: 'a'.repeat(64),
		...overrides,
	};
}

test('maps every real-run backend to deterministic Cargo features', () => {
	assert.deepEqual(cargoFeaturesForBenchmark('whisper', 'cpu'), []);
	for (const backend of ['metal', 'coreml', 'cuda', 'vulkan', 'openblas', 'hipblas']) {
		assert.deepEqual(cargoFeaturesForBenchmark('whisper', backend), [backend]);
	}
	assert.deepEqual(cargoFeaturesForBenchmark('parakeet', 'cpu'), []);
	assert.throws(
		() => cargoFeaturesForBenchmark('parakeet', 'cuda'),
		/Parakeet benchmark builds require the cpu backend/,
	);
});

test('defines exact features and platforms for every canonical reported backend', () => {
	for (const [provider, backend, realRunBackend, cargoFeatures, platforms] of [
		[
			'whisper',
			'cpu',
			'cpu',
			[],
			['macos/aarch64', 'macos/x86_64', 'linux/x86_64', 'windows/x86_64'],
		],
		['whisper', 'metal', 'metal', ['metal'], ['macos/aarch64', 'macos/x86_64']],
		['whisper', 'coreml-metal', 'coreml', ['coreml'], ['macos/aarch64', 'macos/x86_64']],
		['whisper', 'cuda', 'cuda', ['cuda'], ['linux/x86_64', 'windows/x86_64']],
		['whisper', 'vulkan', 'vulkan', ['vulkan'], ['linux/x86_64', 'windows/x86_64']],
		[
			'whisper',
			'openblas-cpu',
			'openblas',
			['openblas'],
			['macos/aarch64', 'macos/x86_64', 'linux/x86_64', 'windows/x86_64'],
		],
		['whisper', 'hipblas', 'hipblas', ['hipblas'], ['linux/x86_64']],
		[
			'parakeet',
			'onnx-cpu',
			'cpu',
			[],
			['macos/aarch64', 'macos/x86_64', 'linux/x86_64', 'windows/x86_64'],
		],
	]) {
		assert.deepEqual(benchmarkDefinitionForReportedBackend(provider, backend), {
			provider,
			reportedBackend: backend,
			realRunBackend,
			cargoFeatures,
			platforms,
		});
	}
	for (const [provider, backend] of [
		['whisper', 'onnx-cpu'],
		['parakeet', 'cpu'],
		['parakeet', 'metal'],
		['unknown', 'cpu'],
	]) {
		assert.throws(
			() => benchmarkDefinitionForReportedBackend(provider, backend),
			new RegExp(`${provider}/${backend}`),
		);
	}
});

test('maps only explicitly supported Rust targets and backend platforms', () => {
	assert.deepEqual(evaluatorPlatformForTargetTriple('aarch64-apple-darwin'), {
		operatingSystem: 'macos',
		architecture: 'aarch64',
	});
	assert.deepEqual(evaluatorPlatformForTargetTriple('x86_64-apple-darwin'), {
		operatingSystem: 'macos',
		architecture: 'x86_64',
	});
	assert.deepEqual(evaluatorPlatformForTargetTriple('x86_64-unknown-linux-gnu'), {
		operatingSystem: 'linux',
		architecture: 'x86_64',
	});
	assert.deepEqual(evaluatorPlatformForTargetTriple('x86_64-pc-windows-msvc'), {
		operatingSystem: 'windows',
		architecture: 'x86_64',
	});
	assert.throws(
		() => evaluatorPlatformForTargetTriple('aarch64-unknown-linux-gnu'),
		/unsupported evaluator revision target triple/,
	);

	assert.deepEqual(assertBenchmarkPlatform('whisper', 'metal', 'macos', 'aarch64'), {
		operatingSystem: 'macos',
		architecture: 'aarch64',
	});
	assert.deepEqual(assertBenchmarkPlatform('whisper', 'openblas-cpu', 'macos', 'aarch64'), {
		operatingSystem: 'macos',
		architecture: 'aarch64',
	});
	assert.deepEqual(assertBenchmarkPlatform('whisper', 'cuda', 'windows', 'x86_64'), {
		operatingSystem: 'windows',
		architecture: 'x86_64',
	});
	assert.throws(
		() => assertBenchmarkPlatform('whisper', 'metal', 'linux', 'x86_64'),
		/not supported on linux\/x86_64/,
	);
	assert.throws(
		() => assertBenchmarkPlatform('whisper', 'hipblas', 'windows', 'x86_64'),
		/not supported on windows\/x86_64/,
	);
});

test('builds once and resolves the exact regular Cargo example executable', (t) => {
	const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-build-'));
	t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
	const executablePath = path.join(
		repositoryRoot,
		'target',
		'release',
		'examples',
		'transcribe-fixture',
	);
	fs.mkdirSync(path.dirname(executablePath), { recursive: true });
	fs.writeFileSync(executablePath, 'binary', { mode: 0o700 });
	let invocation;
	const built = buildBenchmarkExecutable(repositoryRoot, {
		provider: 'whisper',
		backend: 'metal',
		buildEnv: { TEST_ENV: '1' },
		spawnSyncImpl: (command, args, options) => {
			invocation = { command, args, options };
			return {
				status: 0,
				stdout: `${JSON.stringify({
					reason: 'compiler-artifact',
					target: { name: 'transcribe-fixture', kind: ['example'] },
					executable: executablePath,
				})}\n`,
			};
		},
	});

	assert.deepEqual(built, {
		cargoFeatures: ['metal'],
		executablePath: fs.realpathSync(executablePath),
	});
	assert.equal(invocation.command, 'cargo');
	assert.deepEqual(invocation.options.env, { TEST_ENV: '1' });
	assert(invocation.args.includes('--message-format=json-render-diagnostics'));
	assert.deepEqual(
		invocation.args.slice(
			invocation.args.indexOf('--features'),
			invocation.args.indexOf('--features') + 2,
		),
		['--features', 'metal'],
	);
});

test('rejects failed, missing, duplicate, and aliased Cargo executable results', async (t) => {
	const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-build-'));
	t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
	const executablePath = path.join(repositoryRoot, 'transcribe-fixture');
	fs.writeFileSync(executablePath, 'binary');
	const message = (executable) =>
		JSON.stringify({
			reason: 'compiler-artifact',
			target: { name: 'transcribe-fixture', kind: ['example'] },
			executable,
		});
	const options = {
		provider: 'whisper',
		backend: 'cpu',
	};

	assert.throws(
		() =>
			buildBenchmarkExecutable(repositoryRoot, {
				...options,
				spawnSyncImpl: () => ({ status: 1, stdout: '' }),
			}),
		/failed to build/,
	);
	assert.throws(
		() =>
			buildBenchmarkExecutable(repositoryRoot, {
				...options,
				spawnSyncImpl: () => ({ status: 0, stdout: '' }),
			}),
		/exactly one/,
	);
	assert.throws(
		() =>
			buildBenchmarkExecutable(repositoryRoot, {
				...options,
				spawnSyncImpl: () => ({
					status: 0,
					stdout: `${message(executablePath)}\n${message(`${executablePath}-other`)}\n`,
				}),
			}),
		/exactly one/,
	);

	if (process.platform !== 'win32') {
		await t.test('symbolic link', () => {
			const aliasPath = path.join(repositoryRoot, 'transcribe-fixture-alias');
			fs.symlinkSync(executablePath, aliasPath);
			assert.throws(
				() =>
					buildBenchmarkExecutable(repositoryRoot, {
						...options,
						spawnSyncImpl: () => ({ status: 0, stdout: `${message(aliasPath)}\n` }),
					}),
				/non-regular/,
			);
		});
	}
});

test('validates the strict public hardware probe schema', () => {
	assert.deepEqual(
		validateHardwareProbe(hardwareProbe(), { provider: 'whisper', backend: 'metal' }),
		hardwareProbe(),
	);
	assert.deepEqual(
		validateHardwareProbe(
			hardwareProbe({
				backend: 'openblas-cpu',
				operating_system: 'linux',
				architecture: 'x86_64',
				accelerator: 'none',
			}),
			{
				provider: 'whisper',
				backend: 'openblas',
			},
		),
		hardwareProbe({
			backend: 'openblas-cpu',
			operating_system: 'linux',
			architecture: 'x86_64',
			accelerator: 'none',
		}),
	);
	assert.deepEqual(
		validateHardwareProbe(
			hardwareProbe({
				backend: 'onnx-cpu',
				operating_system: 'windows',
				architecture: 'x86_64',
				accelerator: 'none',
			}),
			{
				provider: 'parakeet',
				backend: 'cpu',
			},
		),
		hardwareProbe({
			backend: 'onnx-cpu',
			operating_system: 'windows',
			architecture: 'x86_64',
			accelerator: 'none',
		}),
	);
	assert.throws(
		() =>
			validateHardwareProbe(
				{ ...hardwareProbe(), private_path: '/private/corpus/audio.wav' },
				{ provider: 'whisper', backend: 'metal' },
			),
		/not allowed/,
	);
	assert.throws(
		() =>
			validateHardwareProbe(hardwareProbe({ backend: 'cpu' }), {
				provider: 'whisper',
				backend: 'metal',
			}),
		/does not match requested/,
	);
	assert.throws(
		() =>
			validateHardwareProbe(hardwareProbe({ operating_system: 'linux', architecture: 'x86_64' }), {
				provider: 'whisper',
				backend: 'metal',
			}),
		/not supported on linux\/x86_64/,
	);
	assert.throws(
		() =>
			validateHardwareProbe(hardwareProbe({ accelerator: 'none' }), {
				provider: 'whisper',
				backend: 'metal',
			}),
		/must identify the measured GPU/,
	);
	assert.throws(
		() =>
			validateHardwareProbe(
				hardwareProbe({ backend: 'cpu', accelerator: 'unexpected GPU' }),
				{
					provider: 'whisper',
					backend: 'cpu',
				},
			),
		/must be 'none' for cpu/,
	);
});

test('sanitizes and fingerprints the exact runtime environment', () => {
	const environment = benchmarkRuntimeEnvironment(
		{
			HOME: '/private/home',
			MEMORY_GB: '1',
			Path: 'C:\\Windows\\System32',
			RUST_LOG: 'debug',
			OMP_NUM_THREADS: '4',
			UNRELATED_SECRET: 'do not forward',
		},
		{
			accelerator: 'GPU 0',
			forceWhisperCpu: false,
			requireWhisperAcceleration: true,
		},
	);
	assert.equal(environment.HOME, '/private/home');
	assert.equal(environment.Path, 'C:\\Windows\\System32');
	assert.equal(environment.OMP_NUM_THREADS, '4');
	assert.equal(environment.MEMORY_GB, undefined);
	assert.equal(environment.RUST_LOG, undefined);
	assert.equal(environment.UNRELATED_SECRET, undefined);
	assert.equal(environment.MUESLY_EVAL_ACCELERATOR_ID, 'GPU 0');
	assert.equal(environment.MUESLY_WHISPER_FORCE_CPU, '0');
	assert.equal(environment.MUESLY_WHISPER_REQUIRE_ACCELERATION, '1');
	assert.match(environment.MUESLY_EVAL_RUNTIME_ENV_SHA256, /^[a-f0-9]{64}$/);
	assert.equal(
		benchmarkRuntimeEnvironment(
			{
				OMP_NUM_THREADS: '4',
				HOME: '/private/home',
				Path: 'C:\\Windows\\System32',
			},
			{
				accelerator: 'GPU 0',
				forceWhisperCpu: false,
				requireWhisperAcceleration: true,
			},
		).MUESLY_EVAL_RUNTIME_ENV_SHA256,
		environment.MUESLY_EVAL_RUNTIME_ENV_SHA256,
	);
	assert.equal(
		benchmarkRuntimeEnvironment(
			{
				OMP_NUM_THREADS: '4',
				HOME: '/private/home',
				Path: 'C:\\Windows\\System32',
			},
			{
				accelerator: null,
				forceWhisperCpu: true,
				requireWhisperAcceleration: false,
			},
		).MUESLY_EVAL_RUNTIME_ENV_SHA256,
		environment.MUESLY_EVAL_RUNTIME_ENV_SHA256,
	);
});

test('probes the exact built executable and rejects invalid process output', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-probe-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const executablePath = path.join(directory, 'transcribe-fixture');
	const executableBytes = Buffer.from('exact benchmark executable');
	fs.writeFileSync(executablePath, executableBytes, { mode: 0o700 });
	const executableSha256 = createHash('sha256').update(executableBytes).digest('hex');
	const expectedProbe = hardwareProbe({
		benchmark_executable_sha256: executableSha256,
	});
	let invocation;
	const probe = probeBenchmarkExecutable(executablePath, {
		provider: 'whisper',
		backend: 'metal',
		environment: { MUESLY_EVAL_ACCELERATOR_ID: 'Apple M5 integrated GPU' },
		spawnSyncImpl: (command, args, options) => {
			invocation = { command, args, options };
			return { status: 0, stdout: `${JSON.stringify(expectedProbe)}\n` };
		},
	});
	assert.deepEqual(probe, expectedProbe);
	assert.equal(invocation.command, executablePath);
	assert.deepEqual(invocation.args, ['--provider', 'whisper', '--hardware-json']);
	assert.deepEqual(invocation.options.environment, undefined);
	assert.deepEqual(invocation.options.env, {
		MUESLY_EVAL_ACCELERATOR_ID: 'Apple M5 integrated GPU',
	});

	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				spawnSyncImpl: () => ({ status: 1, stdout: '' }),
			}),
		/hardware probe failed/,
	);
	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				spawnSyncImpl: () => ({ status: 0, stdout: 'not json' }),
			}),
		/invalid JSON/,
	);
	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				spawnSyncImpl: () => ({
					status: 0,
					stdout: `${JSON.stringify(
						hardwareProbe({ benchmark_executable_sha256: 'f'.repeat(64) }),
					)}\n`,
				}),
			}),
		/digest does not match the exact probed executable/,
	);
	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				spawnSyncImpl: () => {
					fs.writeFileSync(executablePath, 'replacement benchmark executable');
					return { status: 0, stdout: `${JSON.stringify(expectedProbe)}\n` };
				},
			}),
		/changed while the hardware probe was running/,
	);
});

test('prepares the selected model through the exact benchmark executable', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-prepare-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const executablePath = path.join(directory, 'transcribe-fixture');
	const executableBytes = Buffer.from('exact benchmark executable');
	fs.writeFileSync(executablePath, executableBytes, { mode: 0o700 });
	let invocation;
	const prepared = prepareBenchmarkModel(executablePath, {
		provider: 'parakeet',
		model: 'parakeet-test',
		modelsDirectory: '/private/models',
		environment: { HOME: '/private/home' },
		spawnSyncImpl: (command, args, options) => {
			invocation = { command, args, options };
			return {
				status: 0,
				stdout: `${JSON.stringify({
					schema_version: 1,
					provider: 'parakeet',
					model: 'parakeet-test',
				})}\n`,
			};
		},
	});
	assert.deepEqual(prepared, {
		schema_version: 1,
		provider: 'parakeet',
		model: 'parakeet-test',
	});
	assert.equal(invocation.command, executablePath);
	assert.deepEqual(invocation.args, [
		'--provider',
		'parakeet',
		'--prepare-model-json',
		'--model',
		'parakeet-test',
		'--models-dir',
		'/private/models',
	]);
	assert.deepEqual(invocation.options.env, { HOME: '/private/home' });

	assert.throws(
		() =>
			prepareBenchmarkModel(executablePath, {
				provider: 'parakeet',
				model: 'parakeet-test',
				modelsDirectory: '/private/models',
				spawnSyncImpl: () => ({
					status: 0,
					stdout: '{"schema_version":1,"provider":"parakeet","model":"wrong"}\n',
				}),
			}),
		/model does not match/,
	);
	assert.throws(
		() =>
			prepareBenchmarkModel(executablePath, {
				provider: 'parakeet',
				model: 'parakeet-test',
				modelsDirectory: '/private/models',
				spawnSyncImpl: () => {
					fs.writeFileSync(executablePath, 'replacement benchmark executable');
					return {
						status: 0,
						stdout: '{"schema_version":1,"provider":"parakeet","model":"parakeet-test"}\n',
					};
				},
			}),
		/changed while model preparation was running/,
	);
});
