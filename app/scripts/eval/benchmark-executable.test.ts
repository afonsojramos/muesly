import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPrivateArtifactSnapshotDirectory } from './artifact-snapshot.ts';
import { BENCHMARK_RUSTC_WRAPPER_ERROR } from './evaluator-revision.ts';
import {
	assertBenchmarkPlatform,
	benchmarkDefinitionForReportedBackend,
	benchmarkExecutableSha256,
	benchmarkRuntimeEnvironment,
	benchmarkRuntimeDependenciesSha256,
	bindBenchmarkRuntimeDependencies,
	buildBenchmarkExecutable,
	cargoFeaturesForBenchmark,
	evaluatorPlatformForTargetTriple,
	prepareBenchmarkModel,
	probeBenchmarkExecutable,
	stageBenchmarkExecutableSnapshot,
	validateHardwareProbe,
} from './benchmark-executable.ts';

const RUNTIME_ENV_SHA256 = 'd'.repeat(64);

function attestedRuntimeEnvironment(overrides = {}) {
	return {
		MUESLY_EVAL_RUNTIME_ENV_SHA256: RUNTIME_ENV_SHA256,
		...overrides,
	};
}

function hardwareProbe(overrides = {}) {
	return {
		schema_version: 1,
		backend: 'metal',
		operating_system: 'macos',
		architecture: 'aarch64',
		hardware_profile: `cpu=Apple M5;logical_cpus=10;memory_bytes=17179869184;runtime_env_sha256=${'d'.repeat(64)}`,
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

test('reclaims only provably stale private artifact snapshots', (t) => {
	const parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-snapshot-recovery-'));
	t.after(() => fs.rmSync(parentDirectory, { recursive: true, force: true }));
	const staleDirectory = path.join(parentDirectory, '.muesly-eval-artifacts-2147483647-ABC123');
	const liveDirectory = path.join(parentDirectory, `.muesly-eval-artifacts-${process.pid}-ABC124`);
	for (const [directory, pid] of [
		[staleDirectory, 2147483647],
		[liveDirectory, process.pid],
	]) {
		fs.mkdirSync(directory, { mode: 0o700 });
		fs.writeFileSync(
			path.join(directory, 'owner.json'),
			`${JSON.stringify({ schema_version: 1, pid })}\n`,
			{ mode: 0o600 },
		);
	}
	const createdDirectory = createPrivateArtifactSnapshotDirectory(parentDirectory);
	assert(!fs.existsSync(staleDirectory));
	assert(fs.existsSync(liveDirectory));
	assert(fs.existsSync(path.join(createdDirectory, 'owner.json')));
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
	const commandDirectory = path.join(repositoryRoot, 'commands');
	const cargoExecutable = path.join(commandDirectory, 'cargo-test');
	const rustcExecutable = path.join(commandDirectory, 'rustc-test');
	fs.mkdirSync(commandDirectory);
	fs.writeFileSync(cargoExecutable, 'cargo', { mode: 0o700 });
	fs.writeFileSync(rustcExecutable, 'rustc', { mode: 0o700 });
	const hostileDirectory = path.join(repositoryRoot, 'hostile-current-directory');
	fs.mkdirSync(hostileDirectory);
	fs.writeFileSync(path.join(hostileDirectory, 'cargo-test'), 'hostile cargo', { mode: 0o700 });
	fs.writeFileSync(path.join(hostileDirectory, 'rustc-test'), 'hostile rustc', { mode: 0o700 });
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
	const originalDirectory = process.cwd();
	let built;
	try {
		process.chdir(hostileDirectory);
		built = buildBenchmarkExecutable(repositoryRoot, {
			provider: 'whisper',
			backend: 'metal',
			buildEnv: {
				CARGO: 'cargo-test',
				PATH: ['.', '', commandDirectory, 'relative-bin'].join(path.delimiter),
				TEST_ENV: '1',
			},
			rustcExecutable: 'rustc-test',
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
	} finally {
		process.chdir(originalDirectory);
	}

	assert.deepEqual(built, {
		cargoFeatures: ['metal'],
		executablePath: fs.realpathSync(executablePath),
	});
	assert.equal(invocation.command, fs.realpathSync(cargoExecutable));
	assert.equal(invocation.options.argv0, cargoExecutable);
	assert.deepEqual(invocation.options.env, {
		CARGO: cargoExecutable,
		PATH: commandDirectory,
		RUSTC: rustcExecutable,
		TEST_ENV: '1',
	});
	assert.deepEqual(invocation.args.slice(0, 5), [
		'build',
		'--config',
		'build.rustc-wrapper=""',
		'--config',
		'build.rustc-workspace-wrapper=""',
	]);
	assert(invocation.args.includes('--message-format=json-render-diagnostics'));
	assert.deepEqual(
		invocation.args.slice(
			invocation.args.indexOf('--features'),
			invocation.args.indexOf('--features') + 2,
		),
		['--features', 'metal'],
	);
});

test('rejects Cargo or rustc replacement during a benchmark build', async (t) => {
	await t.test('Cargo replacement', () => {
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-cargo-swap-'));
		t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
		const cargoExecutable = path.join(repositoryRoot, 'cargo');
		const rustcExecutable = path.join(repositoryRoot, 'rustc');
		fs.writeFileSync(cargoExecutable, 'cargo', { mode: 0o700 });
		fs.writeFileSync(rustcExecutable, 'rustc', { mode: 0o700 });

		assert.throws(
			() =>
				buildBenchmarkExecutable(repositoryRoot, {
					provider: 'whisper',
					backend: 'cpu',
					buildEnv: { PATH: repositoryRoot },
					spawnSyncImpl: () => {
						fs.rmSync(cargoExecutable);
						fs.writeFileSync(cargoExecutable, 'replacement cargo', { mode: 0o700 });
						return { status: 1, stdout: '' };
					},
				}),
			/Cargo executable changed while it was being executed/,
		);
	});

	await t.test('rustc replacement', () => {
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-rustc-swap-'));
		t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
		const cargoExecutable = path.join(repositoryRoot, 'cargo');
		const rustcExecutable = path.join(repositoryRoot, 'rustc');
		fs.writeFileSync(cargoExecutable, 'cargo', { mode: 0o700 });
		fs.writeFileSync(rustcExecutable, 'rustc', { mode: 0o700 });

		assert.throws(
			() =>
				buildBenchmarkExecutable(repositoryRoot, {
					provider: 'whisper',
					backend: 'cpu',
					buildEnv: { PATH: repositoryRoot },
					spawnSyncImpl: () => {
						fs.rmSync(rustcExecutable);
						fs.writeFileSync(rustcExecutable, 'replacement rustc', { mode: 0o700 });
						return { status: 1, stdout: '' };
					},
				}),
			/rustc executable changed while it was being executed/,
		);
	});
});

test('rejects compiler wrappers before Cargo can start', () => {
	for (const name of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) {
		let cargoStarts = 0;
		assert.throws(
			() =>
				buildBenchmarkExecutable('/benchmark-must-not-be-opened', {
					provider: 'whisper',
					backend: 'cpu',
					buildEnv: { [name]: '/private/compiler-wrapper' },
					spawnSyncImpl: () => {
						cargoStarts += 1;
						return { status: 1, stdout: '' };
					},
				}),
			(error) => {
				assert.equal(error.message, BENCHMARK_RUSTC_WRAPPER_ERROR);
				return true;
			},
		);
		assert.equal(cargoStarts, 0);
	}
});

test('overrides compiler wrapper traps from parent and Cargo home configuration', (t) => {
	if (process.platform === 'win32') {
		return t.skip('the adversarial wrapper fixture uses a POSIX executable script');
	}

	const parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-cargo-config-wrapper-'));
	t.after(() => fs.rmSync(parentDirectory, { recursive: true, force: true }));
	const repositoryRoot = path.join(parentDirectory, 'repository');
	const cargoHome = path.join(parentDirectory, 'cargo-home');
	const parentWrapperPath = path.join(parentDirectory, 'parent-compiler-wrapper');
	const cargoHomeWrapperPath = path.join(parentDirectory, 'cargo-home-compiler-wrapper');
	const markerPaths = [`${parentWrapperPath}.started`, `${cargoHomeWrapperPath}.started`];
	fs.mkdirSync(path.join(parentDirectory, '.cargo'), { recursive: true });
	fs.mkdirSync(cargoHome, { recursive: true });
	fs.mkdirSync(path.join(repositoryRoot, 'examples'), { recursive: true });
	for (const wrapperPath of [parentWrapperPath, cargoHomeWrapperPath]) {
		fs.writeFileSync(wrapperPath, '#!/bin/sh\nprintf invoked > \"$0.started\"\nexec \"$@\"\n', {
			mode: 0o700,
		});
	}
	fs.writeFileSync(
		path.join(parentDirectory, '.cargo', 'config.toml'),
		`[build]\nrustc-wrapper = ${JSON.stringify(parentWrapperPath)}\n`,
	);
	fs.writeFileSync(
		path.join(cargoHome, 'config.toml'),
		`[build]\nrustc-workspace-wrapper = ${JSON.stringify(cargoHomeWrapperPath)}\n`,
	);
	fs.writeFileSync(
		path.join(repositoryRoot, 'Cargo.toml'),
		'[package]\nname = "muesly"\nversion = "0.0.0"\nedition = "2024"\n',
	);
	fs.writeFileSync(
		path.join(repositoryRoot, 'examples', 'transcribe-fixture.rs'),
		'fn main() {}\n',
	);

	const buildEnv = { ...process.env, CARGO_HOME: cargoHome };
	delete buildEnv.CARGO_TARGET_DIR;
	delete buildEnv.RUSTC_WRAPPER;
	delete buildEnv.RUSTC_WORKSPACE_WRAPPER;
	const trapped = spawnSync(buildEnv.CARGO ?? 'cargo', ['check', '--quiet'], {
		cwd: repositoryRoot,
		env: buildEnv,
		encoding: 'utf8',
	});
	assert.equal(trapped.status, 0);
	for (const markerPath of markerPaths) {
		assert.equal(fs.readFileSync(markerPath, 'utf8'), 'invoked');
		fs.rmSync(markerPath);
	}
	fs.rmSync(path.join(repositoryRoot, 'target'), { recursive: true, force: true });

	const built = buildBenchmarkExecutable(repositoryRoot, {
		provider: 'whisper',
		backend: 'cpu',
		buildEnv,
	});
	for (const markerPath of markerPaths) {
		assert.equal(fs.existsSync(markerPath), false);
	}
	assert.equal(
		built.executablePath,
		fs.realpathSync(
			path.join(repositoryRoot, 'target', 'release', 'examples', 'transcribe-fixture'),
		),
	);
	assert.match(benchmarkExecutableSha256(built.executablePath), /^[a-f0-9]{64}$/);
});

test('snapshots only exact Cargo example hardlink pairs', async (t) => {
	const executableSuffix = process.platform === 'win32' ? '.exe' : '';
	const message = (executable) =>
		`${JSON.stringify({
			reason: 'compiler-artifact',
			target: { name: 'transcribe-fixture', kind: ['example'] },
			executable,
		})}\n`;
	const build = (repositoryRoot, executablePath) =>
		buildBenchmarkExecutable(repositoryRoot, {
			provider: 'whisper',
			backend: 'cpu',
			spawnSyncImpl: () => ({ status: 0, stdout: message(executablePath) }),
		});
	const createCargoPair = (
		t,
		{ hash = 'a'.repeat(16), content = 'Cargo-built executable' } = {},
	) => {
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-cargo-hardlink-'));
		t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
		const examplesDirectory = path.join(repositoryRoot, 'target', 'release', 'examples');
		const sourcePath = path.join(
			examplesDirectory,
			`transcribe_fixture-${hash}${executableSuffix}`,
		);
		const executablePath = path.join(examplesDirectory, `transcribe-fixture${executableSuffix}`);
		fs.mkdirSync(examplesDirectory, { recursive: true });
		fs.writeFileSync(sourcePath, content, { mode: 0o700 });
		fs.linkSync(sourcePath, executablePath);
		return { content, executablePath, repositoryRoot, sourcePath };
	};

	await t.test('Cargo hardlink pair', (t) => {
		const { content, executablePath, repositoryRoot, sourcePath } = createCargoPair(t);
		assert.equal(fs.lstatSync(executablePath, { bigint: true }).nlink, 2n);

		assert.deepEqual(build(repositoryRoot, executablePath), {
			cargoFeatures: [],
			executablePath: fs.realpathSync(executablePath),
		});
		const expectedSha256 = createHash('sha256').update(content).digest('hex');
		assert.equal(benchmarkExecutableSha256(executablePath), expectedSha256);
		const sourceStatus = fs.lstatSync(sourcePath, { bigint: true });
		const executableStatus = fs.lstatSync(executablePath, { bigint: true });
		assert.equal(sourceStatus.nlink, 2n);
		assert.equal(executableStatus.nlink, 2n);
		assert.deepEqual(
			[sourceStatus.dev, sourceStatus.ino],
			[executableStatus.dev, executableStatus.ino],
		);

		const snapshot = stageBenchmarkExecutableSnapshot(
			executablePath,
			path.join(repositoryRoot, 'private-snapshot'),
			expectedSha256,
		);
		const snapshotStatus = fs.lstatSync(snapshot.executablePath, { bigint: true });
		assert.equal(fs.lstatSync(sourcePath, { bigint: true }).nlink, 2n);
		assert.equal(fs.lstatSync(executablePath, { bigint: true }).nlink, 2n);
		assert.equal(snapshotStatus.nlink, 1n);
		assert.notDeepEqual(
			[executableStatus.dev, executableStatus.ino],
			[snapshotStatus.dev, snapshotStatus.ino],
		);
		assert.equal(fs.readFileSync(snapshot.executablePath, 'utf8'), content);
		if (process.platform !== 'win32') {
			assert.equal(snapshotStatus.mode & 0o777n, 0o700n);
		}
	});

	await t.test('source sibling replacement during hashing', (t) => {
		const { executablePath, sourcePath } = createCargoPair(t);
		const displacedSource = `${sourcePath}.displaced`;
		const readSync = fs.readSync;
		let replaced = false;
		t.mock.method(fs, 'readSync', (descriptor, ...args) => {
			const bytesRead = readSync(descriptor, ...args);
			if (!replaced && bytesRead > 0) {
				replaced = true;
				fs.renameSync(sourcePath, displacedSource);
				fs.writeFileSync(sourcePath, 'replacement executable');
			}
			return bytesRead;
		});

		assert.throws(() => benchmarkExecutableSha256(executablePath), /unreadable/);
		assert.equal(replaced, true);
	});

	await t.test('source sibling replacement during snapshot copy', (t) => {
		const { content, executablePath, repositoryRoot, sourcePath } = createCargoPair(t);
		const expectedSha256 = createHash('sha256').update(content).digest('hex');
		const snapshotDirectory = path.join(repositoryRoot, 'private-snapshot');
		const displacedSource = `${sourcePath}.displaced`;
		const writeSync = fs.writeSync;
		let replaced = false;
		t.mock.method(fs, 'writeSync', (descriptor, ...args) => {
			const bytesWritten = writeSync(descriptor, ...args);
			if (!replaced && bytesWritten > 0) {
				replaced = true;
				fs.renameSync(sourcePath, displacedSource);
				fs.writeFileSync(sourcePath, 'replacement executable');
			}
			return bytesWritten;
		});

		assert.throws(
			() => stageBenchmarkExecutableSnapshot(executablePath, snapshotDirectory, expectedSha256),
			/changed while it was being snapshotted/,
		);
		assert.equal(replaced, true);
		assert.equal(fs.existsSync(snapshotDirectory), false);
	});

	await t.test('destination content corruption', (t) => {
		const { content, executablePath, repositoryRoot } = createCargoPair(t);
		const expectedSha256 = createHash('sha256').update(content).digest('hex');
		const snapshotDirectory = path.join(repositoryRoot, 'private-snapshot');
		const fchmodSync = fs.fchmodSync;
		let corrupted = false;
		t.mock.method(fs, 'fchmodSync', (descriptor, mode) => {
			fchmodSync(descriptor, mode);
			if (!corrupted) {
				corrupted = true;
				fs.writeSync(descriptor, Buffer.from('X'), 0, 1, 0);
			}
		});

		assert.throws(
			() => stageBenchmarkExecutableSnapshot(executablePath, snapshotDirectory, expectedSha256),
			/does not match the expected SHA-256/,
		);
		assert.equal(corrupted, true);
		assert.equal(fs.existsSync(snapshotDirectory), false);
	});

	await t.test('destination path replacement', (t) => {
		const { content, executablePath, repositoryRoot } = createCargoPair(t);
		const expectedSha256 = createHash('sha256').update(content).digest('hex');
		const snapshotDirectory = path.join(repositoryRoot, 'private-snapshot');
		const snapshotPath = path.join(snapshotDirectory, path.basename(executablePath));
		const displacedSnapshot = `${snapshotPath}.displaced`;
		const fchmodSync = fs.fchmodSync;
		let replaced = false;
		t.mock.method(fs, 'fchmodSync', (descriptor, mode) => {
			fchmodSync(descriptor, mode);
			if (!replaced) {
				replaced = true;
				fs.renameSync(snapshotPath, displacedSnapshot);
				fs.writeFileSync(snapshotPath, content, { mode });
			}
		});

		assert.throws(
			() => stageBenchmarkExecutableSnapshot(executablePath, snapshotDirectory, expectedSha256),
			/changed while it was being snapshotted/,
		);
		assert.equal(replaced, true);
		assert.equal(fs.existsSync(snapshotDirectory), false);
	});

	await t.test('independent descriptor cleanup', (t) => {
		const { content, executablePath, repositoryRoot } = createCargoPair(t);
		const expectedSha256 = createHash('sha256').update(content).digest('hex');
		const snapshotDirectory = path.join(repositoryRoot, 'private-snapshot');
		const closeSync = fs.closeSync;
		let closeCalls = 0;
		t.mock.method(fs, 'closeSync', (descriptor) => {
			closeSync(descriptor);
			closeCalls += 1;
			if (closeCalls === 1) throw new Error('destination close trap');
		});

		assert.throws(
			() => stageBenchmarkExecutableSnapshot(executablePath, snapshotDirectory, expectedSha256),
			/destination close trap/,
		);
		assert.equal(closeCalls, 2);
		assert.equal(fs.existsSync(snapshotDirectory), false);
	});

	await t.test('arbitrary two-link executable', (t) => {
		const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-cargo-hardlink-'));
		t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
		const examplesDirectory = path.join(repositoryRoot, 'target', 'release', 'examples');
		const sourcePath = path.join(examplesDirectory, 'attacker-controlled');
		const executablePath = path.join(examplesDirectory, `transcribe-fixture${executableSuffix}`);
		fs.mkdirSync(examplesDirectory, { recursive: true });
		fs.writeFileSync(sourcePath, 'not a Cargo artifact');
		fs.linkSync(sourcePath, executablePath);

		assert.throws(() => build(repositoryRoot, executablePath), /non-regular/);
		assert.equal(fs.lstatSync(executablePath, { bigint: true }).nlink, 2n);
	});

	await t.test('Cargo-looking pair with an extra alias', (t) => {
		const { executablePath, repositoryRoot, sourcePath } = createCargoPair(t, {
			hash: 'b'.repeat(16),
		});
		fs.linkSync(sourcePath, path.join(repositoryRoot, 'external-alias'));

		assert.throws(() => build(repositoryRoot, executablePath), /non-regular/);
		assert.equal(fs.lstatSync(executablePath, { bigint: true }).nlink, 3n);
	});
});

test('stages the exact executable and rejects a transient swap-copy-restore', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-snapshot-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const executablePath = path.join(directory, 'transcribe-fixture');
	fs.writeFileSync(executablePath, 'exact benchmark executable', { mode: 0o700 });
	const runtimeLibraryPath = path.join(directory, 'onnxruntime.dll');
	fs.writeFileSync(runtimeLibraryPath, 'exact runtime library');
	const expectedSha256 = benchmarkExecutableSha256(executablePath);
	const expectedRuntimeDependenciesSha256 = benchmarkRuntimeDependenciesSha256(executablePath);

	const exactSnapshot = stageBenchmarkExecutableSnapshot(
		executablePath,
		path.join(directory, 'exact-snapshot'),
		expectedSha256,
	);
	assert.notEqual(exactSnapshot.executablePath, executablePath);
	assert.equal(exactSnapshot.sha256, expectedSha256);
	assert.equal(exactSnapshot.runtimeDependenciesSha256, expectedRuntimeDependenciesSha256);
	assert.equal(
		fs.readFileSync(
			path.join(path.dirname(exactSnapshot.executablePath), 'onnxruntime.dll'),
			'utf8',
		),
		'exact runtime library',
	);
	fs.writeFileSync(executablePath, 'later replacement', { mode: 0o700 });
	fs.writeFileSync(runtimeLibraryPath, 'later runtime replacement');
	assert.equal(benchmarkExecutableSha256(exactSnapshot.executablePath), expectedSha256);
	assert.equal(
		benchmarkRuntimeDependenciesSha256(exactSnapshot.executablePath),
		expectedRuntimeDependenciesSha256,
	);

	fs.writeFileSync(executablePath, 'exact benchmark executable', { mode: 0o700 });
	fs.writeFileSync(runtimeLibraryPath, 'exact runtime library');
	const heldPath = path.join(directory, 'held-executable');
	assert.throws(
		() =>
			stageBenchmarkExecutableSnapshot(
				executablePath,
				path.join(directory, 'attacked-snapshot'),
				expectedSha256,
				{
					copyFileSnapshotImpl: (sourcePath, destinationPath, options) => {
						fs.renameSync(sourcePath, heldPath);
						try {
							fs.writeFileSync(sourcePath, 'transient malicious executable', {
								mode: 0o700,
							});
							fs.copyFileSync(sourcePath, destinationPath);
							fs.chmodSync(destinationPath, options.mode);
						} finally {
							fs.rmSync(sourcePath, { force: true });
							fs.renameSync(heldPath, sourcePath);
						}
					},
				},
			),
		/snapshot does not match the expected SHA-256/,
	);
	assert.equal(benchmarkExecutableSha256(executablePath), expectedSha256);
	assert(!fs.existsSync(path.join(directory, 'attacked-snapshot')));
});

test('stages Windows example DLLs from the Cargo profile root with local precedence', (t) => {
	const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-windows-runtime-'));
	t.after(() => fs.rmSync(profileDirectory, { recursive: true, force: true }));
	const examplesDirectory = path.join(profileDirectory, 'examples');
	const executablePath = path.join(examplesDirectory, 'transcribe-fixture.exe');
	const fallbackLibraryPath = path.join(profileDirectory, 'onnxruntime.dll');
	const preferredLibraryName = 'onnxruntime_providers_shared.dll';
	const preferredLibraryPath = path.join(examplesDirectory, preferredLibraryName);
	fs.mkdirSync(examplesDirectory);
	fs.writeFileSync(executablePath, 'exact benchmark executable', { mode: 0o700 });
	fs.writeFileSync(fallbackLibraryPath, 'profile-root runtime library');
	fs.writeFileSync(
		path.join(profileDirectory, preferredLibraryName),
		'ignored profile-root library',
	);
	fs.writeFileSync(path.join(profileDirectory, 'unrelated.dll'), 'unrelated profile-root library');
	fs.writeFileSync(preferredLibraryPath, 'preferred example-directory library');

	const executableSha256 = benchmarkExecutableSha256(executablePath);
	const runtimeDependenciesSha256 = benchmarkRuntimeDependenciesSha256(executablePath, {
		platform: 'win32',
	});
	assert.notEqual(
		runtimeDependenciesSha256,
		benchmarkRuntimeDependenciesSha256(executablePath, { platform: 'linux' }),
	);
	const snapshot = stageBenchmarkExecutableSnapshot(
		executablePath,
		path.join(profileDirectory, 'snapshot'),
		executableSha256,
		{ platform: 'win32' },
	);
	assert.equal(snapshot.runtimeDependenciesSha256, runtimeDependenciesSha256);
	assert.equal(
		fs.readFileSync(path.join(path.dirname(snapshot.executablePath), 'onnxruntime.dll'), 'utf8'),
		'profile-root runtime library',
	);
	assert.equal(
		fs.readFileSync(path.join(path.dirname(snapshot.executablePath), preferredLibraryName), 'utf8'),
		'preferred example-directory library',
	);
	assert(!fs.existsSync(path.join(path.dirname(snapshot.executablePath), 'unrelated.dll')));

	fs.writeFileSync(path.join(profileDirectory, preferredLibraryName), 'later ignored replacement');
	fs.writeFileSync(path.join(profileDirectory, 'unrelated.dll'), 'later unrelated replacement');
	assert.equal(
		benchmarkRuntimeDependenciesSha256(executablePath, { platform: 'win32' }),
		runtimeDependenciesSha256,
	);
});

test('rejects a Windows example DLL set changed while its snapshot is copied', (t) => {
	const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-windows-runtime-race-'));
	t.after(() => fs.rmSync(profileDirectory, { recursive: true, force: true }));
	const examplesDirectory = path.join(profileDirectory, 'examples');
	const executablePath = path.join(examplesDirectory, 'transcribe-fixture.exe');
	fs.mkdirSync(examplesDirectory);
	fs.writeFileSync(executablePath, 'exact benchmark executable', { mode: 0o700 });
	fs.writeFileSync(path.join(profileDirectory, 'onnxruntime.dll'), 'profile-root runtime library');
	const snapshotDirectory = path.join(profileDirectory, 'snapshot');

	assert.throws(
		() =>
			stageBenchmarkExecutableSnapshot(
				executablePath,
				snapshotDirectory,
				benchmarkExecutableSha256(executablePath),
				{
					platform: 'win32',
					copyFileSnapshotImpl: (sourcePath, destinationPath, options) => {
						fs.copyFileSync(sourcePath, destinationPath);
						fs.chmodSync(destinationPath, options.mode);
						if (sourcePath === executablePath) {
							fs.writeFileSync(
								path.join(examplesDirectory, 'onnxruntime.dll'),
								'late preferred runtime library',
							);
						}
					},
				},
			),
		/runtime library set changed while it was being snapshotted/,
	);
	assert(!fs.existsSync(snapshotDirectory));
});

test('stages runtime-library aliases and rejects transient replacement', (t) => {
	if (process.platform === 'win32') {
		return t.skip('runtime-library symlink behavior is Unix-specific');
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-runtime-snapshot-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const executablePath = path.join(directory, 'transcribe-fixture');
	const versionedLibrary = path.join(directory, 'libonnxruntime.so.1');
	const aliasLibrary = path.join(directory, 'libonnxruntime.so');
	fs.writeFileSync(executablePath, 'exact benchmark executable', { mode: 0o700 });
	fs.writeFileSync(versionedLibrary, 'exact runtime library');
	fs.symlinkSync(path.basename(versionedLibrary), aliasLibrary);
	const executableSha256 = benchmarkExecutableSha256(executablePath);
	const runtimeDependenciesSha256 = benchmarkRuntimeDependenciesSha256(executablePath);
	const exactSnapshot = stageBenchmarkExecutableSnapshot(
		executablePath,
		path.join(directory, 'exact-snapshot'),
		executableSha256,
	);
	assert.equal(exactSnapshot.runtimeDependenciesSha256, runtimeDependenciesSha256);
	for (const filename of ['libonnxruntime.so', 'libonnxruntime.so.1']) {
		const snapshotLibrary = path.join(path.dirname(exactSnapshot.executablePath), filename);
		assert.equal(fs.lstatSync(snapshotLibrary).isSymbolicLink(), false);
		assert.equal(fs.readFileSync(snapshotLibrary, 'utf8'), 'exact runtime library');
	}

	const heldLibrary = path.join(directory, 'held-runtime-library');
	assert.throws(
		() =>
			stageBenchmarkExecutableSnapshot(
				executablePath,
				path.join(directory, 'attacked-snapshot'),
				executableSha256,
				{
					copyFileSnapshotImpl: (sourcePath, destinationPath, options) => {
						if (sourcePath === versionedLibrary) {
							fs.renameSync(sourcePath, heldLibrary);
							try {
								fs.writeFileSync(sourcePath, 'transient malicious runtime library');
								fs.copyFileSync(sourcePath, destinationPath);
								fs.chmodSync(destinationPath, options.mode);
							} finally {
								fs.rmSync(sourcePath, { force: true });
								fs.renameSync(heldLibrary, sourcePath);
							}
							return;
						}
						fs.copyFileSync(sourcePath, destinationPath);
						fs.chmodSync(destinationPath, options.mode);
					},
				},
			),
		/runtime library snapshot does not match the expected SHA-256/,
	);
	assert.equal(benchmarkRuntimeDependenciesSha256(executablePath), runtimeDependenciesSha256);

	const externalLibrary = path.join(path.dirname(directory), `${path.basename(directory)}.so`);
	t.after(() => fs.rmSync(externalLibrary, { force: true }));
	fs.writeFileSync(externalLibrary, 'external runtime library');
	fs.symlinkSync(externalLibrary, path.join(directory, 'escaped.so'));
	const externalDependenciesSha256 = benchmarkRuntimeDependenciesSha256(executablePath);
	const externalSnapshot = stageBenchmarkExecutableSnapshot(
		executablePath,
		path.join(directory, 'external-snapshot'),
		executableSha256,
	);
	assert.equal(externalSnapshot.runtimeDependenciesSha256, externalDependenciesSha256);
	assert.equal(
		fs.readFileSync(path.join(path.dirname(externalSnapshot.executablePath), 'escaped.so'), 'utf8'),
		'external runtime library',
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
			validateHardwareProbe(hardwareProbe({ backend: 'cpu', accelerator: 'unexpected GPU' }), {
				provider: 'whisper',
				backend: 'cpu',
			}),
		/must be 'none' for cpu/,
	);
});

test('sanitizes and fingerprints the exact runtime environment', () => {
	const environment = benchmarkRuntimeEnvironment(
		{
			DYLD_FALLBACK_LIBRARY_PATH: '/hostile/fallback-runtime-libraries',
			DYLD_LIBRARY_PATH: '/hostile/runtime-libraries',
			HOME: '/private/home',
			LD_LIBRARY_PATH: '/hostile/runtime-libraries',
			MEMORY_GB: '1',
			Path: 'C:\\Windows\\System32',
			RUST_LOG: 'debug',
			OMP_NUM_THREADS: '4',
			MUESLY_CORPUS_BENCHMARK_TOKEN: 'private campaign lock token',
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
	assert.equal(environment.DYLD_FALLBACK_LIBRARY_PATH, undefined);
	assert.equal(environment.DYLD_LIBRARY_PATH, undefined);
	assert.equal(environment.LD_LIBRARY_PATH, undefined);
	assert.equal(environment.MEMORY_GB, undefined);
	assert.equal(environment.RUST_LOG, undefined);
	assert.equal(environment.MUESLY_CORPUS_BENCHMARK_TOKEN, undefined);
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
	const runtimeDependenciesSha256 = 'a'.repeat(64);
	const executablePath = '/private/snapshot/transcribe-fixture';
	const bound = bindBenchmarkRuntimeDependencies(
		environment,
		runtimeDependenciesSha256,
		executablePath,
		{ platform: 'darwin' },
	);
	assert.equal(bound.MUESLY_EVAL_RUNTIME_DEPENDENCIES_SHA256, runtimeDependenciesSha256);
	assert.equal(bound.DYLD_FALLBACK_LIBRARY_PATH, '/private/snapshot');
	assert.equal(bound.DYLD_LIBRARY_PATH, '/private/snapshot');
	assert.notEqual(bound.MUESLY_EVAL_RUNTIME_ENV_SHA256, environment.MUESLY_EVAL_RUNTIME_ENV_SHA256);
	assert.deepEqual(
		bindBenchmarkRuntimeDependencies(bound, runtimeDependenciesSha256, executablePath, {
			platform: 'darwin',
		}),
		bound,
	);
	assert.throws(
		() =>
			bindBenchmarkRuntimeDependencies(bound, 'b'.repeat(64), executablePath, {
				platform: 'darwin',
			}),
		/bound to different dependencies/,
	);
	for (const name of ['DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
		assert.throws(
			() =>
				bindBenchmarkRuntimeDependencies(
					{ ...bound, [name]: '/hostile/runtime-libraries' },
					runtimeDependenciesSha256,
					executablePath,
					{ platform: 'darwin' },
				),
			/bound to a different library directory/,
		);
	}
	assert.throws(
		() =>
			bindBenchmarkRuntimeDependencies(
				bound,
				runtimeDependenciesSha256,
				'/different/private-snapshot/transcribe-fixture',
				{ platform: 'darwin' },
			),
		/bound to a different library directory/,
	);
	const differentDarwinBound = bindBenchmarkRuntimeDependencies(
		environment,
		runtimeDependenciesSha256,
		'/different/private-snapshot/transcribe-fixture',
		{ platform: 'darwin' },
	);
	assert.equal(
		differentDarwinBound.MUESLY_EVAL_RUNTIME_ENV_SHA256,
		bound.MUESLY_EVAL_RUNTIME_ENV_SHA256,
	);
	assert.equal(differentDarwinBound.DYLD_LIBRARY_PATH, '/different/private-snapshot');
	assert.equal(differentDarwinBound.DYLD_FALLBACK_LIBRARY_PATH, '/different/private-snapshot');
	const hostileEnvironment = {
		...environment,
		LD_LIBRARY_PATH: '/hostile/runtime-libraries',
	};
	const linuxBound = bindBenchmarkRuntimeDependencies(
		hostileEnvironment,
		runtimeDependenciesSha256,
		executablePath,
		{ platform: 'linux' },
	);
	assert.equal(linuxBound.LD_LIBRARY_PATH, '/private/snapshot');
	assert.notEqual(linuxBound.MUESLY_EVAL_RUNTIME_ENV_SHA256, bound.MUESLY_EVAL_RUNTIME_ENV_SHA256);
	assert.equal(
		bindBenchmarkRuntimeDependencies(
			hostileEnvironment,
			runtimeDependenciesSha256,
			'/different/private-snapshot/transcribe-fixture',
			{ platform: 'linux' },
		).MUESLY_EVAL_RUNTIME_ENV_SHA256,
		linuxBound.MUESLY_EVAL_RUNTIME_ENV_SHA256,
	);
	assert.throws(
		() =>
			bindBenchmarkRuntimeDependencies(
				{ ...linuxBound, LD_LIBRARY_PATH: '/hostile/runtime-libraries' },
				runtimeDependenciesSha256,
				executablePath,
				{ platform: 'linux' },
			),
		/bound to a different library directory/,
	);
	for (const platform of ['darwin', 'linux']) {
		assert.throws(
			() =>
				bindBenchmarkRuntimeDependencies(
					environment,
					runtimeDependenciesSha256,
					'/private/snap:shot/transcribe-fixture',
					{ platform },
				),
			/runtime search-list delimiter/,
		);
	}
});

test('forces macOS @rpath libraries to the attested executable snapshot', (t) => {
	if (process.platform !== 'darwin') {
		return t.skip('Mach-O @rpath loader behavior is macOS-specific');
	}
	const clang = spawnSync('xcrun', ['--find', 'clang'], { encoding: 'utf8' });
	if (clang.error || clang.status !== 0 || clang.stdout.trim().length === 0) {
		return t.skip('Xcode clang is required for the macOS loader regression');
	}
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-dyld-binding-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const originalDirectory = path.join(directory, 'original');
	const hostileDirectory = path.join(directory, 'hostile');
	fs.mkdirSync(originalDirectory);
	fs.mkdirSync(hostileDirectory);
	const sourcePath = path.join(directory, 'library.c');
	const probeSourcePath = path.join(directory, 'probe.c');
	const originalLibraryPath = path.join(originalDirectory, 'libchoice.dylib');
	const hostileLibraryPath = path.join(hostileDirectory, 'libchoice.dylib');
	const executablePath = path.join(originalDirectory, 'probe');
	fs.writeFileSync(sourcePath, 'const char *choice(void) { return CHOICE; }\n');
	fs.writeFileSync(
		probeSourcePath,
		'#include <stdio.h>\nconst char *choice(void);\n' +
			'int main(void) { puts(choice()); return 0; }\n',
	);
	const compile = (args) => {
		const result = spawnSync('xcrun', ['clang', ...args], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	};
	compile([
		'-dynamiclib',
		sourcePath,
		'-DCHOICE="attested"',
		'-Wl,-install_name,@rpath/libchoice.dylib',
		'-o',
		originalLibraryPath,
	]);
	compile([
		'-dynamiclib',
		sourcePath,
		'-DCHOICE="hostile"',
		'-Wl,-install_name,@rpath/libchoice.dylib',
		'-o',
		hostileLibraryPath,
	]);
	compile([
		probeSourcePath,
		'-L',
		originalDirectory,
		'-lchoice',
		'-Wl,-rpath,@executable_path',
		'-o',
		executablePath,
	]);
	const snapshot = stageBenchmarkExecutableSnapshot(
		executablePath,
		path.join(directory, 'snapshot'),
		benchmarkExecutableSha256(executablePath),
	);
	const hostileEnvironment = attestedRuntimeEnvironment({
		DYLD_FALLBACK_LIBRARY_PATH: hostileDirectory,
		DYLD_LIBRARY_PATH: hostileDirectory,
	});
	const unbound = spawnSync(snapshot.executablePath, [], {
		encoding: 'utf8',
		env: hostileEnvironment,
	});
	assert.equal(unbound.status, 0, unbound.stderr);
	assert.equal(unbound.stdout.trim(), 'hostile');

	const boundEnvironment = bindBenchmarkRuntimeDependencies(
		hostileEnvironment,
		snapshot.runtimeDependenciesSha256,
		snapshot.executablePath,
		{ platform: 'darwin' },
	);
	const bound = spawnSync(snapshot.executablePath, [], {
		encoding: 'utf8',
		env: boundEnvironment,
	});
	assert.equal(bound.status, 0, bound.stderr);
	assert.equal(bound.stdout.trim(), 'attested');
});

test('rejects macOS snapshot paths that split the loader search list', (t) => {
	if (process.platform !== 'darwin') {
		return t.skip('Mach-O @rpath loader behavior is macOS-specific');
	}
	const clang = spawnSync('xcrun', ['--find', 'clang'], { encoding: 'utf8' });
	if (clang.error || clang.status !== 0 || clang.stdout.trim().length === 0) {
		return t.skip('Xcode clang is required for the macOS loader regression');
	}
	const prefixDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-dyld-colon-'));
	const colonDirectory = `${prefixDirectory}:suffix`;
	t.after(() => {
		fs.rmSync(colonDirectory, { recursive: true, force: true });
		fs.rmSync(prefixDirectory, { recursive: true, force: true });
	});
	const originalDirectory = path.join(colonDirectory, 'original');
	fs.mkdirSync(originalDirectory, { recursive: true });
	const sourcePath = path.join(prefixDirectory, 'library.c');
	const probeSourcePath = path.join(prefixDirectory, 'probe.c');
	const originalLibraryPath = path.join(originalDirectory, 'libchoice.dylib');
	const hostileLibraryPath = path.join(prefixDirectory, 'libchoice.dylib');
	const executablePath = path.join(originalDirectory, 'probe');
	fs.writeFileSync(sourcePath, 'const char *choice(void) { return CHOICE; }\n');
	fs.writeFileSync(
		probeSourcePath,
		'#include <stdio.h>\nconst char *choice(void);\n' +
			'int main(void) { puts(choice()); return 0; }\n',
	);
	const compile = (args) => {
		const result = spawnSync('xcrun', ['clang', ...args], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	};
	compile([
		'-dynamiclib',
		sourcePath,
		'-DCHOICE="attested"',
		'-Wl,-install_name,@rpath/libchoice.dylib',
		'-o',
		originalLibraryPath,
	]);
	compile([
		'-dynamiclib',
		sourcePath,
		'-DCHOICE="hostile"',
		'-Wl,-install_name,@rpath/libchoice.dylib',
		'-o',
		hostileLibraryPath,
	]);
	compile([
		probeSourcePath,
		'-L',
		originalDirectory,
		'-lchoice',
		'-Wl,-rpath,@executable_path',
		'-o',
		executablePath,
	]);
	const snapshot = stageBenchmarkExecutableSnapshot(
		executablePath,
		path.join(colonDirectory, 'snapshot'),
		benchmarkExecutableSha256(executablePath),
		{ platform: 'darwin' },
	);
	const unsafeSearchPath = path.dirname(snapshot.executablePath);
	const unsafe = spawnSync(snapshot.executablePath, [], {
		encoding: 'utf8',
		env: attestedRuntimeEnvironment({
			DYLD_FALLBACK_LIBRARY_PATH: unsafeSearchPath,
			DYLD_LIBRARY_PATH: unsafeSearchPath,
		}),
	});
	assert.equal(unsafe.status, 0, unsafe.stderr);
	assert.equal(unsafe.stdout.trim(), 'hostile');
	assert.throws(
		() =>
			bindBenchmarkRuntimeDependencies(
				attestedRuntimeEnvironment(),
				snapshot.runtimeDependenciesSha256,
				snapshot.executablePath,
				{ platform: 'darwin' },
			),
		/runtime search-list delimiter/,
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
		environment: attestedRuntimeEnvironment({
			LD_LIBRARY_PATH: '/hostile/runtime-libraries',
			MUESLY_EVAL_ACCELERATOR_ID: 'Apple M5 integrated GPU',
		}),
		platform: 'linux',
		spawnSyncImpl: (command, args, options) => {
			invocation = { command, args, options };
			return { status: 0, stdout: `${JSON.stringify(expectedProbe)}\n` };
		},
	});
	assert.deepEqual(probe, expectedProbe);
	assert.equal(invocation.command, executablePath);
	assert.deepEqual(invocation.args, ['--provider', 'whisper', '--hardware-json']);
	assert.deepEqual(invocation.options.environment, undefined);
	assert.deepEqual(
		invocation.options.env,
		bindBenchmarkRuntimeDependencies(
			attestedRuntimeEnvironment({
				LD_LIBRARY_PATH: '/hostile/runtime-libraries',
				MUESLY_EVAL_ACCELERATOR_ID: 'Apple M5 integrated GPU',
			}),
			benchmarkRuntimeDependenciesSha256(executablePath),
			executablePath,
			{ platform: 'linux' },
		),
	);

	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => ({ status: 1, stdout: '' }),
			}),
		/hardware probe failed/,
	);
	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => ({ status: 0, stdout: 'not json' }),
			}),
		/invalid JSON/,
	);
	assert.throws(
		() =>
			probeBenchmarkExecutable(executablePath, {
				provider: 'whisper',
				backend: 'metal',
				environment: attestedRuntimeEnvironment(),
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
				environment: attestedRuntimeEnvironment(),
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
	const canonicalDigest = 'a'.repeat(64);
	fs.writeFileSync(executablePath, executableBytes, { mode: 0o700 });
	let invocation;
	const prepared = prepareBenchmarkModel(executablePath, {
		provider: 'parakeet',
		model: 'parakeet-test',
		modelsDirectory: '/private/models',
		reportedBackend: 'onnx-cpu',
		environment: attestedRuntimeEnvironment({
			HOME: '/private/home',
			LD_LIBRARY_PATH: '/hostile/runtime-libraries',
		}),
		platform: 'linux',
		spawnSyncImpl: (command, args, options) => {
			invocation = { command, args, options };
			return {
				status: 0,
				stdout: `${JSON.stringify({
					schema_version: 3,
					provider: 'parakeet',
					model: 'parakeet-test',
					model_artifact_sha256: canonicalDigest,
					primary_model_artifact_sha256: null,
				})}\n`,
			};
		},
	});
	assert.deepEqual(prepared, {
		schema_version: 3,
		provider: 'parakeet',
		model: 'parakeet-test',
		model_artifact_sha256: canonicalDigest,
		primary_model_artifact_sha256: null,
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
	assert.deepEqual(
		invocation.options.env,
		bindBenchmarkRuntimeDependencies(
			attestedRuntimeEnvironment({
				HOME: '/private/home',
				LD_LIBRARY_PATH: '/hostile/runtime-libraries',
			}),
			benchmarkRuntimeDependenciesSha256(executablePath),
			executablePath,
			{ platform: 'linux' },
		),
	);

	assert.throws(
		() =>
			prepareBenchmarkModel(executablePath, {
				provider: 'parakeet',
				model: 'parakeet-test',
				modelsDirectory: '/private/models',
				reportedBackend: 'onnx-cpu',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => ({
					status: 0,
					stdout: `${JSON.stringify({
						schema_version: 3,
						provider: 'parakeet',
						model: 'wrong',
						model_artifact_sha256: canonicalDigest,
						primary_model_artifact_sha256: null,
					})}\n`,
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
				reportedBackend: 'onnx-cpu',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => {
					fs.writeFileSync(executablePath, 'replacement benchmark executable');
					return {
						status: 0,
						stdout: `${JSON.stringify({
							schema_version: 3,
							provider: 'parakeet',
							model: 'parakeet-test',
							model_artifact_sha256: canonicalDigest,
							primary_model_artifact_sha256: null,
						})}\n`,
					};
				},
			}),
		/changed while model preparation was running/,
	);
	let invalidModelSpawned = false;
	assert.throws(
		() =>
			prepareBenchmarkModel(executablePath, {
				provider: 'parakeet',
				model: '../../escaped',
				modelsDirectory: '/private/models',
				reportedBackend: 'onnx-cpu',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => {
					invalidModelSpawned = true;
					return { status: 1, stdout: '' };
				},
			}),
		/bounded lowercase model slug/,
	);
	assert.equal(invalidModelSpawned, false);

	assert.throws(
		() =>
			prepareBenchmarkModel(executablePath, {
				provider: 'parakeet',
				model: 'parakeet-test',
				modelsDirectory: '/private/models',
				reportedBackend: 'onnx-cpu',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => ({
					status: 0,
					stdout: `${JSON.stringify({
						schema_version: 3,
						provider: 'parakeet',
						model: 'parakeet-test',
						model_artifact_sha256: null,
						primary_model_artifact_sha256: null,
					})}\n`,
				}),
			}),
		/Parakeet model preparation requires a canonical artifact digest/,
	);

	const coreml = prepareBenchmarkModel(executablePath, {
		provider: 'whisper',
		model: 'large-v3-turbo-q5_0',
		modelsDirectory: '/private/models',
		reportedBackend: 'coreml-metal',
		environment: attestedRuntimeEnvironment(),
		spawnSyncImpl: () => ({
			status: 0,
			stdout: `${JSON.stringify({
				schema_version: 3,
				provider: 'whisper',
				model: 'large-v3-turbo-q5_0',
				model_artifact_sha256: null,
				primary_model_artifact_sha256: canonicalDigest,
			})}\n`,
		}),
	});
	assert.equal(coreml.model_artifact_sha256, null);
	assert.equal(coreml.primary_model_artifact_sha256, canonicalDigest);

	assert.throws(
		() =>
			prepareBenchmarkModel(executablePath, {
				provider: 'whisper',
				model: 'large-v3-turbo-q5_0',
				modelsDirectory: '/private/models',
				reportedBackend: 'coreml-metal',
				environment: attestedRuntimeEnvironment(),
				spawnSyncImpl: () => ({
					status: 0,
					stdout: `${JSON.stringify({
						schema_version: 3,
						provider: 'whisper',
						model: 'large-v3-turbo-q5_0',
						model_artifact_sha256: null,
						primary_model_artifact_sha256: null,
					})}\n`,
				}),
			}),
		/Core ML model preparation requires the pinned primary GGML digest/,
	);
});
