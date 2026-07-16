import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactTreeRevision } from './artifact-revision.ts';
import { createPrivateArtifactSnapshotDirectory } from './artifact-snapshot.ts';
import {
	benchmarkExecutableSha256,
	benchmarkRuntimeDependenciesSha256,
	stageBenchmarkExecutableSnapshot,
} from './benchmark-executable.ts';
import { evaluatorRevisionSha256 } from './evaluator-revision.ts';
import { modelArtifactSha256, stageModelArtifactSnapshot } from './model-artifact.ts';
import {
	prepareRealRunSession,
	runRealRunCli,
	runRealRunSample,
	runRealRunSampleUnreported,
	signalRealRunProcessTree,
} from './real-run-session.ts';

const RUSTC_VV = [
	'rustc 1.88.0 (6b00bc388 2025-06-23)',
	'binary: rustc',
	'commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc',
	'commit-date: 2025-06-23',
	'host: x86_64-unknown-linux-gnu',
	'release: 1.88.0',
	'LLVM version: 20.1.5',
].join('\n');

function evaluatorIdentity(cargoFeatures = []) {
	const revision = {
		schema_version: 1,
		protocol_id: 'muesly-real-run-v1',
		git_commit: 'a'.repeat(40),
		cargo_lock_sha256: 'b'.repeat(64),
		rustc_vv: RUSTC_VV,
		build_profile: 'release',
		target_triple: 'x86_64-unknown-linux-gnu',
		cargo_features: cargoFeatures,
		build_env_sha256: 'c'.repeat(64),
	};
	return { revision, sha256: evaluatorRevisionSha256(revision) };
}

function metricsFor(command, overrides = {}) {
	return {
		schema_version: 6,
		provider: 'whisper',
		model: 'tiny',
		backend: 'cpu',
		operating_system: 'linux',
		architecture: 'x86_64',
		hardware_profile: `cpu=test;logical_cpus=1;memory_bytes=1;runtime_env_sha256=${'d'.repeat(64)}`,
		accelerator: 'none',
		benchmark_executable_sha256: benchmarkExecutableSha256(command),
		audio_sha256: 'a'.repeat(64),
		audio_duration_seconds: 2,
		decode_seconds: 0.1,
		vad_seconds: 0.1,
		model_download_seconds: 0,
		model_load_seconds: 0.2,
		inference_seconds: 0.5,
		inference_rtf: 0.25,
		measured_total_seconds: 0.9,
		baseline_rss_mb: 10,
		peak_rss_mb: 12,
		peak_rss_delta_mb: 2,
		...overrides,
	};
}

function writeMetrics(command, args, overrides) {
	const metricsPath = args[args.indexOf('--metrics-json') + 1];
	const audioSha256 = args[args.indexOf('--expected-audio-sha256') + 1];
	fs.writeFileSync(
		metricsPath,
		`${JSON.stringify(metricsFor(command, { audio_sha256: audioSha256, ...overrides }))}\n`,
		{
			mode: 0o600,
		},
	);
}

function sampleFiles(root, id, referenceText = 'hello world') {
	const audioFile = path.join(root, `${id}.wav`);
	const referenceFile = path.join(root, `${id}.txt`);
	fs.writeFileSync(audioFile, `audio-${id}`);
	fs.writeFileSync(referenceFile, referenceText);
	return {
		id,
		audio_sha256: createHash('sha256').update(fs.readFileSync(audioFile)).digest('hex'),
		audio_file: audioFile,
		reference_file: referenceFile,
		language: 'en',
		whisper_language: 'en',
		noise_condition: 'clean',
		scenario: 'read-speech',
		speakers: 1,
		provenance: { basis: 'synthetic' },
		corpus_id: 'test-corpus-v1',
		corpus_fingerprint: 'e'.repeat(64),
	};
}

function createHarness(t, options = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-real-run-session-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const privateParent = path.join(root, 'private');
	const modelsDirectory = path.join(root, 'models');
	const executablePath = path.join(root, 'transcribe-fixture');
	fs.mkdirSync(privateParent);
	fs.mkdirSync(modelsDirectory);
	fs.writeFileSync(executablePath, options.executableSource ?? '#!/bin/sh\nexit 0\n', {
		mode: 0o700,
	});
	fs.writeFileSync(path.join(modelsDirectory, 'ggml-tiny.bin'), 'prepared whisper model');
	const counts = {
		build: 0,
		probe: 0,
		prepare: 0,
		executableSnapshot: 0,
		modelSnapshot: 0,
		privateDirectory: 0,
		evaluator: 0,
		executableDigest: 0,
		runtimeDigest: 0,
		modelDigest: 0,
	};
	let clockTick = 0;
	const revision = evaluatorIdentity();
	const dependencies = {
		benchmarkExecutableSha256(executable) {
			counts.executableDigest += 1;
			return benchmarkExecutableSha256(executable);
		},
		benchmarkRuntimeDependenciesSha256(executable) {
			counts.runtimeDigest += 1;
			return benchmarkRuntimeDependenciesSha256(executable);
		},
		modelArtifactSha256(...args) {
			counts.modelDigest += 1;
			return modelArtifactSha256(...args);
		},
		buildBenchmarkExecutable() {
			counts.build += 1;
			options.onBuild?.(counts.build, executablePath);
			return { cargoFeatures: [], executablePath };
		},
		probeBenchmarkExecutable(command) {
			counts.probe += 1;
			return {
				schema_version: 1,
				backend: 'cpu',
				operating_system: 'linux',
				architecture: 'x86_64',
				hardware_profile: `cpu=test;logical_cpus=1;memory_bytes=1;runtime_env_sha256=${'d'.repeat(64)}`,
				accelerator: 'none',
				benchmark_executable_sha256:
					options.probeExecutableSha256 ?? benchmarkExecutableSha256(command),
			};
		},
		prepareBenchmarkModel() {
			counts.prepare += 1;
		},
		evaluatorRevision() {
			counts.evaluator += 1;
			return revision;
		},
		createPrivateArtifactSnapshotDirectory() {
			counts.privateDirectory += 1;
			return createPrivateArtifactSnapshotDirectory(privateParent);
		},
		stageBenchmarkExecutableSnapshot(...args) {
			counts.executableSnapshot += 1;
			return stageBenchmarkExecutableSnapshot(...args);
		},
		stageModelArtifactSnapshot(...args) {
			counts.modelSnapshot += 1;
			return stageModelArtifactSnapshot(...args);
		},
		now() {
			return new Date(Date.UTC(2026, 0, 1, 0, 0, clockTick++));
		},
	};
	const session = prepareRealRunSession(
		{
			provider: 'whisper',
			model: 'tiny',
			backend: 'cpu',
			accelerator: null,
			modelsDirectory,
			repoRoot: root,
			buildEnvironment: { PATH: path.dirname(process.execPath) },
			runtimeEnvironment: { PATH: path.dirname(process.execPath) },
			evaluatorRevision: options.unreported ? null : undefined,
		},
		dependencies,
	);
	return {
		root,
		privateParent,
		modelsDirectory,
		executablePath,
		counts,
		dependencies,
		session,
	};
}

test('artifact revisions reject aliases and change with exact tree metadata', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-artifact-revision-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const artifact = path.join(root, 'artifact.bin');
	fs.writeFileSync(artifact, 'first');
	const fixedTimestamp = new Date('2026-01-01T00:00:00.000Z');
	fs.utimesSync(artifact, fixedTimestamp, fixedTimestamp);
	const metadataBefore = fs.statSync(artifact, { bigint: true });
	const initial = artifactTreeRevision(root);
	assert.equal(artifactTreeRevision(root), initial);

	fs.writeFileSync(artifact, 'later');
	fs.utimesSync(artifact, fixedTimestamp, fixedTimestamp);
	const metadataAfter = fs.statSync(artifact, { bigint: true });
	assert.equal(metadataAfter.size, metadataBefore.size);
	assert.equal(metadataAfter.mtimeNs, metadataBefore.mtimeNs);
	assert.notEqual(metadataAfter.ctimeNs, metadataBefore.ctimeNs);
	assert.notEqual(artifactTreeRevision(root), initial);

	const alias = path.join(root, 'artifact-hardlink.bin');
	fs.linkSync(artifact, alias);
	assert.throws(() => artifactTreeRevision(root), /exactly one hard link|alias/);
	fs.unlinkSync(alias);

	const symlink = path.join(root, 'artifact-symlink.bin');
	try {
		fs.symlinkSync(artifact, symlink);
		assert.throws(() => artifactTreeRevision(root), /without symbolic links/);
	} catch (error) {
		if (error?.code !== 'EPERM') throw error;
	}
});

test('rejects a hardware probe that does not identify the staged executable', (t) => {
	assert.throws(
		() => createHarness(t, { probeExecutableSha256: 'f'.repeat(64) }),
		/hardware probe does not identify the staged benchmark executable/,
	);
});

test('prepares once and runs three samples in three fresh exact processes', async (t) => {
	const harness = createHarness(t);
	t.after(() => harness.session.close());
	const processCalls = [];
	const reports = [];
	for (const [index, id] of ['one', 'two', 'three'].entries()) {
		const sample = sampleFiles(harness.root, id);
		reports.push(
			await runRealRunSample(harness.session, sample, {
				thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
				runProcess(command, args, options) {
					const pid = 10_000 + index;
					processCalls.push({ command, args, options, pid });
					writeMetrics(command, args);
					return { status: 0, signal: null, stdout: 'hello world', pid };
				},
			}),
		);
	}
	assert.deepEqual(harness.counts, {
		build: 1,
		probe: 1,
		prepare: 1,
		executableSnapshot: 1,
		modelSnapshot: 1,
		privateDirectory: 3,
		evaluator: 1,
		executableDigest: 2,
		runtimeDigest: 1,
		modelDigest: 2,
	});
	assert.equal(new Set(processCalls.map((call) => call.pid)).size, 3);
	assert.equal(new Set(processCalls.map((call) => call.command)).size, 1);
	assert.notEqual(processCalls[0].command, harness.executablePath);
	assert.notEqual(processCalls[0].args.at(-1), harness.modelsDirectory);
	assert.equal(
		fs.statSync(path.dirname(path.dirname(processCalls[0].command))).mode & 0o777,
		0o700,
	);
	assert.equal(
		fs.statSync(path.dirname(path.dirname(processCalls[0].args.at(-1)))).mode & 0o777,
		0o700,
	);
	for (const [index, report] of reports.entries()) {
		assert.equal(report.schema_version, 9);
		assert.equal(report.results.length, 1);
		assert.equal(report.results[0].sample_id, ['one', 'two', 'three'][index]);
		assert.equal(report.results[0].passed, true);
		assert.equal(report.started_at, `2026-01-01T00:00:0${index * 2}.000Z`);
		assert.equal(report.completed_at, `2026-01-01T00:00:0${index * 2 + 1}.000Z`);
	}
	assert.equal(Object.isFrozen(harness.session), true);
	assert.equal(Object.isFrozen(harness.session.identity), true);
	const fullDigestCounts = {
		executable: harness.counts.executableDigest,
		runtime: harness.counts.runtimeDigest,
		model: harness.counts.modelDigest,
	};
	await harness.session.revalidate();
	assert.deepEqual(
		{
			executable: harness.counts.executableDigest,
			runtime: harness.counts.runtimeDigest,
			model: harness.counts.modelDigest,
		},
		{
			executable: fullDigestCounts.executable + 2,
			runtime: fullDigestCounts.runtime + 2,
			model: fullDigestCounts.model + 2,
		},
	);
});

test('preserves WER, empty-transcript, and hallucination failure semantics', async (t) => {
	const harness = createHarness(t);
	t.after(() => harness.session.close());
	const cases = [
		{
			sample: sampleFiles(harness.root, 'wer-fail', 'hello world'),
			stdout: 'completely different words',
			field: 'wer_percent',
		},
		{
			sample: sampleFiles(harness.root, 'empty-fail', 'hello world'),
			stdout: '',
			field: 'wer_percent',
		},
		{
			sample: sampleFiles(harness.root, 'hallucination-fail', ''),
			stdout: 'one two three',
			field: 'hallucinated_words',
		},
	];
	for (const entry of cases) {
		const report = await runRealRunSample(harness.session, entry.sample, {
			thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
			runProcess(command, args) {
				writeMetrics(command, args);
				return { status: 0, signal: null, stdout: entry.stdout, pid: process.pid };
			},
		});
		assert.equal(report.passed, false);
		assert.equal(report.results[0].passed, false);
		assert.equal(typeof report.results[0][entry.field], 'number');
	}
});

test('scores an in-memory reference without reopening its corpus path', async (t) => {
	const harness = createHarness(t);
	t.after(() => harness.session.close());
	const sample = sampleFiles(harness.root, 'in-memory-reference');
	sample.reference_text = 'hello world';
	sample.reference_file = path.join(harness.root, 'missing-reference.txt');
	const report = await runRealRunSample(harness.session, sample, {
		thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
		runProcess(command, args) {
			writeMetrics(command, args);
			return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
		},
	});
	assert.equal(report.passed, true);
	assert.equal(Object.hasOwn(report.results[0], 'reference_text'), false);
	assert.equal(Object.hasOwn(report.results[0], 'hypothesis'), false);
});

test('rejects metrics that attest a different audio digest', async (t) => {
	const harness = createHarness(t);
	t.after(() => harness.session.close());
	const sample = sampleFiles(harness.root, 'wrong-audio-digest');
	await assert.rejects(
		runRealRunSample(harness.session, sample, {
			thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
			runProcess(command, args) {
				writeMetrics(command, args, { audio_sha256: 'f'.repeat(64) });
				return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
			},
		}),
		/audio_sha256 does not match the prepared sample/,
	);
});

test('rejects staged artifact drift during a sample', async (t) => {
	const harness = createHarness(t);
	t.after(() => harness.session.close());
	const sample = sampleFiles(harness.root, 'drift');
	await assert.rejects(
		runRealRunSample(harness.session, sample, {
			thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
			runProcess(command, args) {
				writeMetrics(command, args);
				fs.writeFileSync(command, 'replaced benchmark executable', { mode: 0o700 });
				return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
			},
		}),
		/benchmark executable changed during transcription/,
	);
});

test('revalidation remains valid after another variant overwrites the shared Cargo output', async (t) => {
	let variant = 0;
	const harness = createHarness(t, {
		onBuild(_count, executablePath) {
			variant += 1;
			fs.writeFileSync(executablePath, `benchmark variant ${variant}`, { mode: 0o700 });
		},
	});
	const first = harness.session;
	const second = prepareRealRunSession(
		{
			provider: 'whisper',
			model: 'tiny',
			backend: 'cpu',
			accelerator: null,
			modelsDirectory: harness.modelsDirectory,
			repoRoot: harness.root,
			buildEnvironment: { PATH: path.dirname(process.execPath) },
			runtimeEnvironment: { PATH: path.dirname(process.execPath) },
		},
		harness.dependencies,
	);
	t.after(() => {
		first.close();
		second.close();
	});
	assert.notEqual(
		first.identity.benchmark_executable_sha256,
		second.identity.benchmark_executable_sha256,
	);
	await first.revalidate();
	await second.revalidate();
	const observed = [];
	for (const [session, expected] of [
		[first, 'benchmark variant 1'],
		[second, 'benchmark variant 2'],
	]) {
		await runRealRunSample(session, sampleFiles(harness.root, `variant-${observed.length}`), {
			thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
			runProcess(command, args) {
				observed.push(fs.readFileSync(command, 'utf8'));
				writeMetrics(command, args);
				return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
			},
		});
		assert.equal(observed.at(-1), expected);
	}
});

test('serializes active samples and defers close until cancellation completes', async (t) => {
	const harness = createHarness(t);
	const sample = sampleFiles(harness.root, 'active');
	const controller = new AbortController();
	let started;
	const startedPromise = new Promise((resolve) => {
		started = resolve;
	});
	const activeRun = runRealRunSample(harness.session, sample, {
		thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
		signal: controller.signal,
		runProcess(_command, _args, options) {
			started();
			return new Promise((_, reject) => {
				options.signal.addEventListener(
					'abort',
					() => {
						const error = new Error('cancelled');
						error.name = 'AbortError';
						reject(error);
					},
					{ once: true },
				);
			});
		},
	});
	await startedPromise;
	assert.throws(() => harness.session.close(), /while a sample is active/);
	await assert.rejects(harness.session.revalidate(), /while a sample is active/);
	await assert.rejects(
		runRealRunSample(harness.session, sample, {
			thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
			runProcess() {
				throw new Error('must not run');
			},
		}),
		/already has an active sample/,
	);
	controller.abort();
	await assert.rejects(activeRun, { name: 'AbortError' });
	harness.session.close();
	harness.session.close();
	assert.deepEqual(fs.readdirSync(harness.privateParent), []);
});

test('removes per-sample metrics after every reusable-session outcome', async (t) => {
	const harness = createHarness(t);
	t.after(() => harness.session.close());
	const thresholds = { maxWerPercent: 10, maxHallucinatedWords: 2 };
	const cases = [
		{
			id: 'process-error',
			expected: /process failed after writing metrics/,
			run(command, args) {
				writeMetrics(command, args);
				throw new Error('process failed after writing metrics');
			},
		},
		{
			id: 'nonzero-exit',
			expected: /real transcription failed \(exit 17\)/,
			run(command, args) {
				writeMetrics(command, args);
				return { status: 17, signal: null, stdout: '', pid: process.pid };
			},
		},
		{
			id: 'invalid-metrics',
			expected: /benchmark metrics are missing or invalid/,
			run(_command, args) {
				const metricsPath = args[args.indexOf('--metrics-json') + 1];
				fs.writeFileSync(metricsPath, '{invalid', { mode: 0o600 });
				return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
			},
		},
	];
	for (const entry of cases) {
		let metricsPath;
		await assert.rejects(
			runRealRunSample(harness.session, sampleFiles(harness.root, entry.id), {
				thresholds,
				runProcess(command, args) {
					metricsPath = args[args.indexOf('--metrics-json') + 1];
					return entry.run(command, args);
				},
			}),
			entry.expected,
		);
		assert.equal(fs.existsSync(metricsPath), false);
	}

	let successfulMetricsPath;
	const report = await runRealRunSample(
		harness.session,
		sampleFiles(harness.root, 'successful-cleanup'),
		{
			thresholds,
			runProcess(command, args) {
				successfulMetricsPath = args[args.indexOf('--metrics-json') + 1];
				writeMetrics(command, args);
				return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
			},
		},
	);
	assert.equal(report.passed, true);
	assert.equal(fs.existsSync(successfulMetricsPath), false);
});

async function waitForFile(filePath, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === 'ESRCH') return false;
		throw error;
	}
}

test('uses Windows taskkill for the complete inference process tree', () => {
	const calls = [];
	const environment = {
		Path: 'C:\\Windows\\System32',
		SystemRoot: 'C:\\Windows',
	};
	const taskkillExecutable = 'C:\\Windows\\System32\\taskkill.exe';
	assert.equal(
		signalRealRunProcessTree({ pid: 4321 }, 'SIGTERM', environment, {
			execFileSyncImpl(executable, args, options) {
				calls.push({ executable, args, options });
			},
			platform: 'win32',
			windowsTaskkillExecutableImpl(receivedEnvironment) {
				assert.equal(receivedEnvironment, environment);
				return taskkillExecutable;
			},
		}),
		true,
	);
	assert.deepEqual(calls, [
		{
			executable: taskkillExecutable,
			args: ['/PID', '4321', '/T', '/F'],
			options: {
				env: environment,
				stdio: 'ignore',
				timeout: 10_000,
				windowsHide: true,
			},
		},
	]);
});

test('cancellation force-kills a SIGTERM-resistant inference process tree', async (t) => {
	if (process.platform === 'win32') {
		return t.skip('the POSIX descendant check uses process signals');
	}
	const markerPath = path.join(
		os.tmpdir(),
		`muesly-real-run-resistant-${process.pid}-${Date.now()}.json`,
	);
	t.after(() => fs.rmSync(markerPath, { force: true }));
	const descendantSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
	const executableSource = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
	stdio: 'ignore',
});
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
	parent: process.pid,
	descendant: descendant.pid,
}));
setInterval(() => {}, 1000);
`;
	const harness = createHarness(t, { executableSource });
	const controller = new AbortController();
	const run = runRealRunSample(harness.session, sampleFiles(harness.root, 'resistant'), {
		thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
		signal: controller.signal,
	});
	await waitForFile(markerPath);
	const pids = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
	controller.abort();
	await assert.rejects(run, { name: 'AbortError' });
	assert.equal(processExists(pids.parent), false);
	assert.equal(processExists(pids.descendant), false);
	harness.session.close();
	assert.deepEqual(fs.readdirSync(harness.privateParent), []);
});

test('unreported standalone mode keeps transcript-free result behavior without evaluator Git work', async (t) => {
	const harness = createHarness(t, { unreported: true });
	t.after(() => harness.session.close());
	const sample = sampleFiles(harness.root, 'standalone');
	const run = await runRealRunSampleUnreported(harness.session, sample, {
		thresholds: { maxWerPercent: 10, maxHallucinatedWords: 2 },
		runProcess(command, args) {
			writeMetrics(command, args);
			return { status: 0, signal: null, stdout: 'hello world', pid: process.pid };
		},
	});
	assert.equal(run.result.passed, true);
	assert.equal(Object.hasOwn(run, 'transcript'), false);
	assert.equal(Object.hasOwn(run, 'hypothesis'), false);
	assert.equal(harness.counts.evaluator, 0);
});

test('the standalone CLI prepares once and aggregates three one-sample reports', async (t) => {
	const harness = createHarness(t);
	const samples = ['cli-one', 'cli-two', 'cli-three'].map((id) => sampleFiles(harness.root, id));
	const corpus = {
		corpus_id: 'test-corpus-v1',
		corpus_fingerprint: 'e'.repeat(64),
		samples,
	};
	let prepareCalls = 0;
	let processCalls = 0;
	let written;
	const originalLog = console.log;
	const originalError = console.error;
	const logs = [];
	const errors = [];
	console.log = (...values) => logs.push(values.join(' '));
	console.error = (...values) => errors.push(values.join(' '));
	try {
		const result = await runRealRunCli(
			[
				'--manifest',
				path.join(harness.root, 'manifest.json'),
				'--models-dir',
				harness.modelsDirectory,
				'--output',
				path.join(harness.root, 'report.json'),
			],
			{
				repoRoot: harness.root,
				defaultManifest: path.join(harness.root, 'default.json'),
				environment: { PATH: path.dirname(process.execPath) },
				loadCorpusImpl: () => corpus,
				attestedRustcVersionImpl: () => ({ hostTriple: 'x86_64-unknown-linux-gnu' }),
				evaluatorBuildEnvironmentImpl: (environment) => environment,
				ensureSidecarStubsImpl: () => {},
				prepareSession() {
					prepareCalls += 1;
					return harness.session;
				},
				runReportedSample(session, sample, options) {
					return runRealRunSample(session, sample, {
						...options,
						runProcess(command, args) {
							processCalls += 1;
							writeMetrics(command, args);
							return {
								status: 0,
								signal: null,
								stdout: 'hello world',
								pid: 20_000 + processCalls,
							};
						},
					});
				},
				writeCorpusBoundJsonImpl(input) {
					written = input;
				},
			},
		);
		assert.deepEqual(result, { exitCode: 0, signal: null });
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
	assert.equal(prepareCalls, 1);
	assert.equal(processCalls, 3);
	assert.equal(written.value.schema_version, 9);
	assert.equal(written.value.results.length, 3);
	assert.deepEqual(
		written.value.results.map((result) => result.sample_id),
		['cli-one', 'cli-two', 'cli-three'],
	);
	assert.equal(logs.filter((line) => line.includes(': WER ')).length, 3);
	assert.equal(logs.filter((line) => line.startsWith('wrote benchmark report:')).length, 1);
	assert.equal(errors.filter((line) => line.startsWith('running real whisper')).length, 1);
	assert.deepEqual(fs.readdirSync(harness.privateParent), []);
});
