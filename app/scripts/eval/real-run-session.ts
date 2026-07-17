import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { createPrivateArtifactSnapshotDirectory } from './artifact-snapshot.ts';
import { artifactTreeRevision } from './artifact-revision.ts';
import { forcesWhisperCpu, requiresWhisperGpu } from './backend.ts';
import {
	benchmarkExecutableSha256,
	benchmarkRuntimeDependenciesSha256,
	benchmarkRuntimeEnvironment,
	bindBenchmarkRuntimeDependencies,
	buildBenchmarkExecutable,
	cargoFeaturesForBenchmark,
	prepareBenchmarkModel,
	probeBenchmarkExecutable,
	stageBenchmarkExecutableSnapshot,
} from './benchmark-executable.ts';
import { loadCorpus, whisperLanguageForSample } from './corpus.ts';
import { writeCorpusBoundJson } from './corpus-result.ts';
import {
	attestedRustcVersion,
	evaluatorBuildEnvironment,
	evaluatorRevision as collectEvaluatorRevision,
	evaluatorRevisionSha256,
	validateEvaluatorRevision,
} from './evaluator-revision.ts';
import {
	modelArtifactSha256,
	primaryModelArtifactSha256,
	resolveModelsDirectory,
	stageModelArtifactSnapshot,
} from './model-artifact.ts';
import { parseRealRunArgs } from './real-run-options.ts';
import { validateBenchmarkMetrics, validateRunReport } from './report.ts';
import { WER_SCORER_ID, werDetails } from './wer.ts';

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_PATH_SEPARATOR_PATTERN = String.raw`[\\/]+`;
const FORCE_KILL_DELAY_MS = 750;
const FORCE_KILL_CONFIRMATION_MS = 5_000;
const PROCESS_TREE_POLL_INTERVAL_MS = 25;
const SESSION_STATE = new WeakMap();
const REPORT_METADATA = new WeakMap();

const DEFAULT_DEPENDENCIES = Object.freeze({
	artifactTreeRevision,
	benchmarkExecutableSha256,
	benchmarkRuntimeDependenciesSha256,
	benchmarkRuntimeEnvironment,
	bindBenchmarkRuntimeDependencies,
	buildBenchmarkExecutable,
	cargoFeaturesForBenchmark,
	createPrivateArtifactSnapshotDirectory,
	evaluatorRevision: collectEvaluatorRevision,
	modelArtifactSha256,
	primaryModelArtifactSha256,
	prepareBenchmarkModel,
	probeBenchmarkExecutable,
	stageBenchmarkExecutableSnapshot,
	stageModelArtifactSnapshot,
	now: () => new Date(),
});

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function escapeRegularExpression(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeDiagnosticControls(value) {
	let sanitized = '';
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		sanitized +=
			codePoint <= 8 ||
			(codePoint >= 11 && codePoint <= 12) ||
			(codePoint >= 14 && codePoint <= 31) ||
			codePoint === 127
				? '\uFFFD'
				: character;
	}
	return sanitized;
}

function addPrivatePathCandidate(candidates, candidate, { windows = false } = {}) {
	if (candidate.length === 0) return;
	candidates.set(candidate, candidates.get(candidate) === true || windows);
}

function windowsPathCandidatePattern(candidate) {
	return candidate
		.split(/[\\/]+/)
		.map(escapeRegularExpression)
		.join(WINDOWS_PATH_SEPARATOR_PATTERN);
}

function isWindowsPrivatePath(filePath) {
	return (
		process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
	);
}

function redactPrivateSamplePaths(value, sample) {
	let diagnostic = String(value ?? '');
	const candidates = new Map();
	for (const filePath of [sample.audio_file, sample.reference_file]) {
		if (typeof filePath !== 'string' || filePath.length === 0) continue;
		const windows = isWindowsPrivatePath(filePath);
		const pathApi = windows ? path.win32 : path;
		const resolved = pathApi.resolve(filePath);
		for (const candidate of [filePath, pathApi.normalize(filePath), resolved]) {
			addPrivatePathCandidate(candidates, candidate, { windows });
		}
		addPrivatePathCandidate(candidates, pathApi.basename(resolved), { windows });
		const directory = pathApi.dirname(resolved);
		if (directory !== pathApi.parse(directory).root) {
			addPrivatePathCandidate(candidates, directory, { windows });
		}
	}
	for (const [candidate, caseInsensitive] of [...candidates].sort(
		([left], [right]) => right.length - left.length,
	)) {
		diagnostic = caseInsensitive
			? diagnostic.replace(
					new RegExp(windowsPathCandidatePattern(candidate), 'gi'),
					'<private-corpus-path>',
				)
			: diagnostic.split(candidate).join('<private-corpus-path>');
	}
	return sanitizeDiagnosticControls(diagnostic.replace(/\r\n?/g, '\n')).trim();
}

function canonicalTimestamp(date) {
	const value = date instanceof Date ? date : new Date(date);
	const timestamp = value.toISOString();
	if (new Date(timestamp).toISOString() !== timestamp) {
		throw new Error('real-run clock returned an invalid timestamp');
	}
	return timestamp;
}

function sameJson(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function freezeEvaluatorIdentity(value) {
	if (value === null) return null;
	if (
		value === undefined ||
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		value.revision === null ||
		typeof value.revision !== 'object' ||
		Array.isArray(value.revision)
	) {
		throw new Error('evaluatorRevision must contain revision and sha256');
	}
	const errors = validateEvaluatorRevision(value.revision);
	if (errors.length > 0) {
		throw new Error(`invalid evaluator revision:\n- ${errors.join('\n- ')}`);
	}
	const expectedSha256 = evaluatorRevisionSha256(value.revision);
	if (value.sha256 !== expectedSha256) {
		throw new Error('evaluator revision SHA-256 does not match its revision');
	}
	return Object.freeze({
		revision: Object.freeze({
			...value.revision,
			cargo_features: Object.freeze([...value.revision.cargo_features]),
		}),
		sha256: value.sha256,
	});
}

function requireSessionState(session) {
	const state = SESSION_STATE.get(session);
	if (!state) throw new Error('invalid real-run session');
	if (state.closed) throw new Error('real-run session is closed');
	return state;
}

function removeDirectories(directories) {
	for (const directory of [...directories].reverse()) {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// Private paths remain inaccessible if best-effort teardown fails.
		}
	}
}

function validateSnapshotArtifacts(state, label = 'real-run session') {
	const executableSha256 = state.dependencies.benchmarkExecutableSha256(
		state.executableSnapshotPath,
	);
	if (executableSha256 !== state.identity.benchmark_executable_sha256) {
		throw new Error(`${label}: benchmark executable snapshot changed`);
	}
	const runtimeDependenciesSha256 = state.dependencies.benchmarkRuntimeDependenciesSha256(
		state.executableSnapshotPath,
	);
	if (runtimeDependenciesSha256 !== state.identity.runtime_dependencies_sha256) {
		throw new Error(`${label}: benchmark runtime library snapshot changed`);
	}
	const modelSha256 = state.dependencies.modelArtifactSha256(
		state.identity.provider,
		state.identity.model,
		state.modelSnapshotDirectory,
		state.identity.backend,
	);
	if (modelSha256 !== state.identity.model_artifact_sha256) {
		throw new Error(`${label}: model artifact snapshot changed`);
	}
	return Object.freeze({
		executableSha256,
		runtimeDependenciesSha256,
		modelSha256,
	});
}

function snapshotMetadataRevisions(state, label = 'real-run session') {
	let executable;
	try {
		executable = state.dependencies.artifactTreeRevision(state.executableSnapshotPath);
	} catch {
		throw new Error(`${label}: benchmark executable snapshot metadata changed`);
	}
	let runtime;
	try {
		runtime = state.dependencies.artifactTreeRevision(path.dirname(state.executableSnapshotPath));
	} catch {
		throw new Error(`${label}: benchmark runtime library snapshot metadata changed`);
	}
	let model;
	try {
		model = state.dependencies.artifactTreeRevision(state.modelSnapshotRoot);
	} catch {
		throw new Error(`${label}: model artifact snapshot metadata changed`);
	}
	return Object.freeze({ executable, runtime, model });
}

function validateSnapshotMetadata(state, label = 'real-run session') {
	const revision = snapshotMetadataRevisions(state, label);
	if (revision.executable !== state.snapshotMetadataRevisions.executable) {
		throw new Error(`${label}: benchmark executable snapshot metadata changed`);
	}
	if (revision.runtime !== state.snapshotMetadataRevisions.runtime) {
		throw new Error(`${label}: benchmark runtime library snapshot metadata changed`);
	}
	if (revision.model !== state.snapshotMetadataRevisions.model) {
		throw new Error(`${label}: model artifact snapshot metadata changed`);
	}
	return revision;
}

function assertSameSnapshotMetadata(state, before, label) {
	let executable;
	try {
		executable = state.dependencies.artifactTreeRevision(state.executableSnapshotPath);
	} catch {
		throw new Error(`${label}: benchmark executable changed during transcription`);
	}
	if (
		executable !== before.executable ||
		executable !== state.snapshotMetadataRevisions.executable
	) {
		throw new Error(`${label}: benchmark executable changed during transcription`);
	}
	let runtime;
	try {
		runtime = state.dependencies.artifactTreeRevision(path.dirname(state.executableSnapshotPath));
	} catch {
		throw new Error(`${label}: benchmark runtime libraries changed during transcription`);
	}
	if (runtime !== before.runtime || runtime !== state.snapshotMetadataRevisions.runtime) {
		throw new Error(`${label}: benchmark runtime libraries changed during transcription`);
	}
	let model;
	try {
		model = state.dependencies.artifactTreeRevision(state.modelSnapshotRoot);
	} catch {
		throw new Error(`${label}: evaluated model artifact changed during transcription`);
	}
	if (model !== before.model || model !== state.snapshotMetadataRevisions.model) {
		throw new Error(`${label}: evaluated model artifact changed during transcription`);
	}
}

function normalizeThresholds(thresholds) {
	if (
		thresholds === null ||
		typeof thresholds !== 'object' ||
		Array.isArray(thresholds) ||
		!Number.isFinite(thresholds.maxWerPercent) ||
		thresholds.maxWerPercent < 0 ||
		!Number.isInteger(thresholds.maxHallucinatedWords) ||
		thresholds.maxHallucinatedWords < 0
	) {
		throw new Error('real-run thresholds must contain non-negative WER and hallucination limits');
	}
	return Object.freeze({
		maxWerPercent: thresholds.maxWerPercent,
		maxHallucinatedWords: thresholds.maxHallucinatedWords,
	});
}

function abortError() {
	const error = new Error('real transcription was cancelled');
	error.name = 'AbortError';
	return error;
}

function windowsTaskkillExecutable(environment) {
	const systemRoot = environment.SystemRoot ?? environment.WINDIR;
	if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
		throw new Error('unable to resolve the Windows taskkill executable');
	}
	const executablePath = path.win32.join(systemRoot, 'System32', 'taskkill.exe');
	const canonicalPath = fs.realpathSync(executablePath);
	if (!fs.statSync(canonicalPath).isFile()) {
		throw new Error('the Windows taskkill executable is not a regular file');
	}
	return canonicalPath;
}

export function signalRealRunProcessTree(
	child,
	signalName,
	environment,
	{
		execFileSyncImpl = execFileSync,
		platform = process.platform,
		windowsTaskkillExecutableImpl = windowsTaskkillExecutable,
	} = {},
) {
	if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
	if (platform === 'win32') {
		try {
			execFileSyncImpl(
				windowsTaskkillExecutableImpl(environment),
				['/PID', String(child.pid), '/T', '/F'],
				{
					env: environment,
					stdio: 'ignore',
					timeout: 10_000,
					windowsHide: true,
				},
			);
			return true;
		} catch {
			return false;
		}
	}
	try {
		process.kill(-child.pid, signalName);
		return true;
	} catch (error) {
		if (error?.code === 'ESRCH') return false;
		throw error;
	}
}

function posixProcessGroupExists(child) {
	if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		if (error?.code === 'ESRCH') return false;
		if (error?.code === 'EPERM') return true;
		throw error;
	}
}

function waitForProcessTreePoll(delayMs) {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function terminateProcessTree(child, environment) {
	if (process.platform === 'win32') {
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (signalRealRunProcessTree(child, 'SIGKILL', environment)) return;
		try {
			child.kill('SIGKILL');
		} catch {
			// The full-tree failure below remains authoritative.
		}
		throw new Error('unable to terminate the full Windows benchmark process tree');
	}
	signalRealRunProcessTree(child, 'SIGTERM', environment);
	const forceKillAt = Date.now() + FORCE_KILL_DELAY_MS;
	while (posixProcessGroupExists(child)) {
		const remainingMs = forceKillAt - Date.now();
		if (remainingMs <= 0) break;
		await waitForProcessTreePoll(Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remainingMs));
	}
	if (!posixProcessGroupExists(child)) return;
	signalRealRunProcessTree(child, 'SIGKILL', environment);
	const confirmationDeadline = Date.now() + FORCE_KILL_CONFIRMATION_MS;
	while (posixProcessGroupExists(child)) {
		const remainingMs = confirmationDeadline - Date.now();
		if (remainingMs <= 0) {
			throw new Error('unable to confirm benchmark process-group termination after SIGKILL');
		}
		await waitForProcessTreePoll(Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remainingMs));
	}
}

function defaultRunProcess(command, args, options) {
	if (options.signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				detached: process.platform !== 'win32',
				env: options.env,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			reject(error);
			return;
		}
		const stdoutChunks = [];
		const stderrChunks = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let transcriptLimitExceeded = false;
		let diagnosticLimitExceeded = false;
		let aborted = false;
		let settled = false;
		let terminationPromise = null;
		const settleResolve = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const settleReject = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const terminate = () => {
			terminationPromise ??= terminateProcessTree(child, options.env);
			terminationPromise.catch(settleReject);
		};
		const onAbort = () => {
			aborted = true;
			terminate();
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });
		child.stdout.on('data', (chunk) => {
			if (transcriptLimitExceeded) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stdoutBytes += buffer.length;
			if (stdoutBytes > options.maxOutputBytes) {
				transcriptLimitExceeded = true;
				terminate();
				return;
			}
			stdoutChunks.push(buffer);
		});
		child.stderr.on('data', (chunk) => {
			if (diagnosticLimitExceeded) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stderrBytes += buffer.length;
			if (stderrBytes > options.maxDiagnosticBytes) {
				diagnosticLimitExceeded = true;
				terminate();
				return;
			}
			stderrChunks.push(buffer);
		});
		child.once('error', (error) => {
			options.signal?.removeEventListener('abort', onAbort);
			settleReject(error);
		});
		child.once('close', async (status, signal) => {
			options.signal?.removeEventListener('abort', onAbort);
			try {
				if (terminationPromise) await terminationPromise;
			} catch (error) {
				settleReject(error);
				return;
			}
			if (aborted || options.signal?.aborted) {
				settleReject(abortError());
				return;
			}
			if (transcriptLimitExceeded) {
				settleReject(new Error('real transcription exceeded the private output limit'));
				return;
			}
			if (diagnosticLimitExceeded) {
				settleReject(new Error('real transcription exceeded the private diagnostic output limit'));
				return;
			}
			settleResolve({
				status,
				signal,
				pid: child.pid,
				stdout: Buffer.concat(stdoutChunks).toString('utf8'),
				stderr: Buffer.concat(stderrChunks).toString('utf8'),
			});
		});
	});
}

export class RealRunProcessError extends Error {
	constructor(message, { exitCode = 1, signal = null } = {}) {
		super(message);
		this.name = 'RealRunProcessError';
		this.exitCode = exitCode;
		this.signal = signal;
	}
}

function validateMetricsIdentity(state, metrics, sample) {
	const errors = validateBenchmarkMetrics(metrics, `${sample.id}.metrics`);
	if (errors.length > 0) {
		throw new Error(`invalid benchmark metrics:\n- ${errors.join('\n- ')}`);
	}
	for (const [field, expected] of [
		['schema_version', 7],
		['provider', state.identity.provider],
		['model', state.identity.model],
		['backend', state.identity.backend],
		['operating_system', state.identity.operating_system],
		['architecture', state.identity.architecture],
		['hardware_profile', state.identity.hardware_profile],
		['accelerator', state.identity.accelerator],
		['benchmark_executable_sha256', state.identity.benchmark_executable_sha256],
		['audio_sha256', sample.audio_sha256],
	]) {
		if (metrics[field] !== expected) {
			throw new Error(
				`${sample.id}: benchmark metrics ${field} does not match the prepared sample`,
			);
		}
	}
}

function scoreSample(sample, referenceText, hypothesis, metrics, thresholds) {
	const result = {
		sample_id: sample.id,
		language: sample.language,
		noise_condition: sample.noise_condition,
		scenario: sample.scenario,
		speakers: sample.speakers,
		provenance_basis: sample.provenance.basis,
		reference_words: null,
		word_errors: null,
		wer_percent: null,
		hallucinated_words: null,
		passed: true,
		metrics,
	};
	if (referenceText.length === 0) {
		result.hallucinated_words = hypothesis.length === 0 ? 0 : hypothesis.split(/\s+/).length;
		result.passed = result.hallucinated_words <= thresholds.maxHallucinatedWords;
		return {
			result,
			failureReason: result.passed ? null : 'hallucination',
		};
	}
	const details = werDetails(referenceText, hypothesis);
	result.reference_words = details.referenceWords;
	result.word_errors = details.wordErrors;
	result.wer_percent = details.rate * 100;
	result.passed = hypothesis.length > 0 && result.wer_percent <= thresholds.maxWerPercent;
	return {
		result,
		failureReason: result.passed ? null : hypothesis.length === 0 ? 'empty' : 'wer',
	};
}

function referenceTextForSample(sample) {
	if (sample.reference_text !== undefined) {
		if (typeof sample.reference_text !== 'string') {
			throw new Error(`${sample.id}: reference_text must be a string when provided`);
		}
		return sample.reference_text.trim();
	}
	const referenceBytes = fs.readFileSync(sample.reference_file);
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(referenceBytes).trim();
	} catch {
		throw new Error(`${sample.id}: reference_file must contain valid UTF-8`);
	}
}

function sampleReport(state, sample, thresholds, startedAt, completedAt, result) {
	if (!state.evaluatorIdentity) {
		throw new Error('real-run session requires evaluator provenance to create a report');
	}
	if (
		typeof sample.corpus_id !== 'string' ||
		typeof sample.corpus_fingerprint !== 'string' ||
		typeof sample.reference_protocol_id !== 'string'
	) {
		throw new Error(
			'real-run sample report requires corpus_id, corpus_fingerprint, and reference_protocol_id',
		);
	}
	const report = {
		schema_version: 10,
		corpus_id: sample.corpus_id,
		corpus_fingerprint: sample.corpus_fingerprint,
		reference_protocol_id: sample.reference_protocol_id,
		started_at: startedAt,
		completed_at: completedAt,
		wer_scorer: WER_SCORER_ID,
		evaluator_revision: state.evaluatorIdentity.revision,
		evaluator_revision_sha256: state.evaluatorIdentity.sha256,
		benchmark_executable_sha256: state.identity.benchmark_executable_sha256,
		provider: state.identity.provider,
		model: state.identity.model,
		model_artifact_sha256: state.identity.model_artifact_sha256,
		thresholds: {
			max_wer_percent: thresholds.maxWerPercent,
			max_hallucinated_words: thresholds.maxHallucinatedWords,
		},
		passed: result.passed,
		results: [result],
	};
	const errors = validateRunReport(report);
	if (errors.length > 0) {
		throw new Error(`refusing to create invalid benchmark report:\n- ${errors.join('\n- ')}`);
	}
	return report;
}

async function executeRealRunSampleLocked(state, sample, options) {
	const thresholds = normalizeThresholds(options.thresholds);
	if (options.signal?.aborted) throw abortError();
	if (!SHA256_PATTERN.test(sample.audio_sha256 ?? '')) {
		throw new Error(`${sample.id}: audio_sha256 must be a lowercase SHA-256 digest`);
	}
	const before = validateSnapshotMetadata(state, `${sample.id} before transcription`);
	const metricsPath = path.join(
		state.metricsDirectory,
		`${String(state.sampleCounter++).padStart(6, '0')}.json`,
	);
	try {
		const referenceText = referenceTextForSample(sample);
		const args = [
			'--provider',
			state.identity.provider,
			'--vad',
			'--metrics-json',
			metricsPath,
			'--expected-audio-sha256',
			sample.audio_sha256,
			sample.audio_file,
			state.identity.model,
		];
		const whisperLanguage =
			state.identity.provider === 'whisper' ? whisperLanguageForSample(sample) : null;
		if (whisperLanguage) args.splice(args.indexOf('--vad'), 0, '--language', whisperLanguage);
		args.push(state.modelSnapshotDirectory);
		const startedAt = canonicalTimestamp(state.dependencies.now());
		let run;
		try {
			run = await (options.runProcess ?? defaultRunProcess)(state.executableSnapshotPath, args, {
				cwd: state.repoRoot,
				env: state.runtimeEnvironment,
				signal: options.signal,
				maxOutputBytes: MAX_TRANSCRIPT_BYTES,
				maxDiagnosticBytes: MAX_DIAGNOSTIC_BYTES,
			});
		} finally {
			assertSameSnapshotMetadata(state, before, `${sample.id} after transcription`);
		}
		if (run?.error) throw run.error;
		if (run?.status !== 0) {
			const diagnostic = redactPrivateSamplePaths(run?.stderr, sample);
			const message =
				`${sample.id}: real transcription failed (exit ${run?.status ?? 'signal'})` +
				(diagnostic.length > 0 ? `\ntranscription diagnostics:\n${diagnostic}` : '');
			throw new RealRunProcessError(message, {
				exitCode: Number.isInteger(run?.status) && run.status > 0 ? run.status : 1,
				signal: run?.signal ?? null,
			});
		}
		let metrics;
		try {
			metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
		} catch {
			throw new Error(`${sample.id}: benchmark metrics are missing or invalid`);
		}
		validateMetricsIdentity(state, metrics, sample);
		const hypothesis = String(run.stdout ?? '').trim();
		const score = scoreSample(sample, referenceText, hypothesis, metrics, thresholds);
		const completedAt = canonicalTimestamp(state.dependencies.now());
		return {
			thresholds,
			startedAt,
			completedAt,
			result: score.result,
			failureReason: score.failureReason,
		};
	} finally {
		fs.rmSync(metricsPath, { force: true });
	}
}

async function executeRealRunSample(session, sample, options) {
	const state = requireSessionState(session);
	if (state.activeRun) {
		throw new Error('real-run session already has an active sample');
	}
	state.activeRun = true;
	try {
		return await executeRealRunSampleLocked(state, sample, options);
	} finally {
		state.activeRun = false;
	}
}

export async function runRealRunSample(session, sample, options) {
	const state = requireSessionState(session);
	const run = await executeRealRunSample(session, sample, options);
	const report = sampleReport(
		state,
		sample,
		run.thresholds,
		run.startedAt,
		run.completedAt,
		run.result,
	);
	REPORT_METADATA.set(report, Object.freeze({ failureReason: run.failureReason }));
	return report;
}

export async function runRealRunSampleUnreported(session, sample, options) {
	const run = await executeRealRunSample(session, sample, options);
	return Object.freeze({
		started_at: run.startedAt,
		completed_at: run.completedAt,
		result: run.result,
		failure_reason: run.failureReason,
	});
}

export function aggregateRealRunReports(reports) {
	if (!Array.isArray(reports) || reports.length === 0) {
		throw new Error('cannot aggregate an empty real-run report set');
	}
	const first = reports[0];
	const last = reports.at(-1);
	for (const [index, report] of reports.entries()) {
		for (const field of [
			'schema_version',
			'corpus_id',
			'corpus_fingerprint',
			'reference_protocol_id',
			'wer_scorer',
			'evaluator_revision_sha256',
			'benchmark_executable_sha256',
			'provider',
			'model',
			'model_artifact_sha256',
		]) {
			if (report?.[field] !== first?.[field]) {
				throw new Error(`real-run report ${index} has a different ${field}`);
			}
		}
		if (
			!sameJson(report?.evaluator_revision, first?.evaluator_revision) ||
			!sameJson(report?.thresholds, first?.thresholds)
		) {
			throw new Error(`real-run report ${index} has a different evaluator or threshold identity`);
		}
	}
	const report = {
		...first,
		started_at: first.started_at,
		completed_at: last.completed_at,
		passed: reports.every((entry) => entry.passed),
		results: reports.flatMap((entry) => entry.results),
	};
	const errors = validateRunReport(report);
	if (errors.length > 0) {
		throw new Error(`refusing to aggregate invalid benchmark reports:\n- ${errors.join('\n- ')}`);
	}
	return report;
}

export function prepareRealRunSession(input, dependencies = {}) {
	const resolvedDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const repoRoot = path.resolve(input.repoRoot);
	const modelsDirectory = path.resolve(input.modelsDirectory);
	const buildEnvironment = { ...input.buildEnvironment };
	const runtimeBaseEnvironment = input.runtimeEnvironment ?? process.env;
	const privateDirectories = [];
	let closed = false;
	try {
		const cargoFeatures = resolvedDependencies.cargoFeaturesForBenchmark(
			input.provider,
			input.backend,
		);
		const evaluatorIdentity = freezeEvaluatorIdentity(
			input.evaluatorRevision === null
				? null
				: (input.evaluatorRevision ??
						resolvedDependencies.evaluatorRevision(repoRoot, {
							buildEnv: buildEnvironment,
							cargoFeatures,
						})),
		);
		const built = resolvedDependencies.buildBenchmarkExecutable(repoRoot, {
			provider: input.provider,
			backend: input.backend,
			buildEnv: buildEnvironment,
		});
		if (!sameJson(built.cargoFeatures, cargoFeatures)) {
			throw new Error('benchmark build features changed after evaluator provenance was collected');
		}
		const sourceExecutableSha256 = resolvedDependencies.benchmarkExecutableSha256(
			built.executablePath,
		);
		const executableSnapshotRoot = resolvedDependencies.createPrivateArtifactSnapshotDirectory(
			path.dirname(built.executablePath),
		);
		privateDirectories.push(executableSnapshotRoot);
		const executableSnapshot = resolvedDependencies.stageBenchmarkExecutableSnapshot(
			built.executablePath,
			path.join(executableSnapshotRoot, 'executable'),
			sourceExecutableSha256,
		);
		let runtimeEnvironment = resolvedDependencies.benchmarkRuntimeEnvironment(
			runtimeBaseEnvironment,
			{
				accelerator: input.accelerator,
				forceWhisperCpu: forcesWhisperCpu(input.provider, input.backend),
				requireWhisperAcceleration: requiresWhisperGpu(input.provider, input.backend),
			},
		);
		runtimeEnvironment = resolvedDependencies.bindBenchmarkRuntimeDependencies(
			runtimeEnvironment,
			executableSnapshot.runtimeDependenciesSha256,
			executableSnapshot.executablePath,
		);
		const hardwareProbe = resolvedDependencies.probeBenchmarkExecutable(
			executableSnapshot.executablePath,
			{
				provider: input.provider,
				backend: input.backend,
				environment: runtimeEnvironment,
			},
		);
		if (hardwareProbe.benchmark_executable_sha256 !== executableSnapshot.sha256) {
			throw new Error('hardware probe does not identify the staged benchmark executable');
		}
		const preparedModel = resolvedDependencies.prepareBenchmarkModel(
			executableSnapshot.executablePath,
			{
				provider: input.provider,
				model: input.model,
				modelsDirectory,
				reportedBackend: hardwareProbe.backend,
				environment: runtimeEnvironment,
			},
		);
		const sourceModelSha256 = resolvedDependencies.modelArtifactSha256(
			input.provider,
			input.model,
			modelsDirectory,
			hardwareProbe.backend,
		);
		if (
			preparedModel.model_artifact_sha256 !== null &&
			sourceModelSha256 !== preparedModel.model_artifact_sha256
		) {
			throw new Error(
				'prepared model bytes do not match the canonical artifact digest attested by the evaluator',
			);
		}
		if (preparedModel.primary_model_artifact_sha256 !== null) {
			const sourcePrimarySha256 = resolvedDependencies.primaryModelArtifactSha256(
				input.provider,
				input.model,
				modelsDirectory,
			);
			if (sourcePrimarySha256 !== preparedModel.primary_model_artifact_sha256) {
				throw new Error(
					'prepared primary model bytes do not match the canonical digest attested by the evaluator',
				);
			}
		}
		const modelSnapshotRoot =
			resolvedDependencies.createPrivateArtifactSnapshotDirectory(modelsDirectory);
		privateDirectories.push(modelSnapshotRoot);
		const modelSnapshot = resolvedDependencies.stageModelArtifactSnapshot(
			input.provider,
			input.model,
			modelsDirectory,
			hardwareProbe.backend,
			path.join(modelSnapshotRoot, 'model'),
			preparedModel.model_artifact_sha256 ?? sourceModelSha256,
		);
		if (
			preparedModel.model_artifact_sha256 !== null &&
			modelSnapshot.sha256 !== preparedModel.model_artifact_sha256
		) {
			throw new Error(
				'model snapshot does not match the canonical artifact digest attested by the evaluator',
			);
		}
		if (preparedModel.primary_model_artifact_sha256 !== null) {
			const snapshotPrimarySha256 = resolvedDependencies.primaryModelArtifactSha256(
				input.provider,
				input.model,
				modelSnapshot.modelsDirectory,
			);
			if (snapshotPrimarySha256 !== preparedModel.primary_model_artifact_sha256) {
				throw new Error(
					'private snapshot primary model bytes do not match the canonical digest attested by the evaluator',
				);
			}
		}
		const metricsDirectory = resolvedDependencies.createPrivateArtifactSnapshotDirectory(
			os.tmpdir(),
		);
		privateDirectories.push(metricsDirectory);
		const identity = Object.freeze({
			provider: input.provider,
			model: input.model,
			requested_backend: input.backend,
			backend: hardwareProbe.backend,
			operating_system: hardwareProbe.operating_system,
			architecture: hardwareProbe.architecture,
			hardware_profile: hardwareProbe.hardware_profile,
			accelerator: hardwareProbe.accelerator,
			cargo_features: Object.freeze([...built.cargoFeatures]),
			benchmark_executable_sha256: executableSnapshot.sha256,
			runtime_dependencies_sha256: executableSnapshot.runtimeDependenciesSha256,
			model_artifact_sha256: modelSnapshot.sha256,
			evaluator_revision: evaluatorIdentity?.revision ?? null,
			evaluator_revision_sha256: evaluatorIdentity?.sha256 ?? null,
		});
		const state = {
			dependencies: resolvedDependencies,
			repoRoot,
			buildEnvironment,
			runtimeEnvironment: Object.freeze({ ...runtimeEnvironment }),
			executableSnapshotPath: executableSnapshot.executablePath,
			modelSnapshotDirectory: modelSnapshot.modelsDirectory,
			modelSnapshotRoot,
			metricsDirectory,
			privateDirectories,
			evaluatorIdentity,
			hardwareProbe: Object.freeze({ ...hardwareProbe }),
			identity,
			sampleCounter: 0,
			activeRun: false,
			closed: false,
			snapshotMetadataRevisions: null,
		};
		const session = {
			identity,
			async revalidate() {
				const current = requireSessionState(session);
				if (current.activeRun) {
					throw new Error('cannot revalidate a real-run session while a sample is active');
				}
				validateSnapshotArtifacts(current);
				validateSnapshotMetadata(current);
				const hardwareProbeAfter = current.dependencies.probeBenchmarkExecutable(
					current.executableSnapshotPath,
					{
						provider: current.identity.provider,
						backend: current.identity.requested_backend,
						environment: current.runtimeEnvironment,
					},
				);
				if (!sameJson(hardwareProbeAfter, current.hardwareProbe)) {
					throw new Error('real-run hardware identity changed');
				}
				if (current.evaluatorIdentity) {
					const evaluatorAfter = freezeEvaluatorIdentity(
						current.dependencies.evaluatorRevision(current.repoRoot, {
							buildEnv: current.buildEnvironment,
							cargoFeatures: current.identity.cargo_features,
						}),
					);
					if (evaluatorAfter.sha256 !== current.evaluatorIdentity.sha256) {
						throw new Error('evaluator revision changed while the benchmark was running');
					}
				}
				validateSnapshotArtifacts(current);
				validateSnapshotMetadata(current);
				return current.identity;
			},
			runSample(sample, options) {
				return runRealRunSample(session, sample, options);
			},
			close() {
				const current = SESSION_STATE.get(session);
				if (!current || current.closed) return;
				if (current.activeRun) {
					throw new Error('cannot close a real-run session while a sample is active');
				}
				current.closed = true;
				removeDirectories(current.privateDirectories);
			},
		};
		SESSION_STATE.set(session, state);
		validateSnapshotArtifacts(state);
		state.snapshotMetadataRevisions = snapshotMetadataRevisions(state);
		closed = true;
		return Object.freeze(session);
	} finally {
		if (!closed) removeDirectories(privateDirectories);
	}
}

function logSampleResult(result, thresholds, failureReason) {
	const modelRtf =
		result.metrics.model_inference_rtf === null
			? 'n/a'
			: result.metrics.model_inference_rtf.toFixed(3);
	if (result.reference_words === null) {
		console.log(
			`${result.sample_id}: hallucinated words = ${result.hallucinated_words} ` +
				`(limit ${thresholds.maxHallucinatedWords}), ` +
				`source RTF ${result.metrics.inference_rtf.toFixed(3)}, ` +
				`model-input RTF ${modelRtf}, ` +
				`peak RSS ${result.metrics.peak_rss_mb.toFixed(1)} MiB`,
		);
		if (!result.passed) {
			console.error(
				`FAIL: ${result.sample_id} hallucinated ${result.hallucinated_words} words ` +
					'(transcript omitted from logs)',
			);
		}
		return;
	}
	console.log(
		`${result.sample_id}: WER ${result.wer_percent.toFixed(2)}% ` +
			`(limit ${thresholds.maxWerPercent}%), ` +
			`source RTF ${result.metrics.inference_rtf.toFixed(3)}, ` +
			`model-input RTF ${modelRtf}, ` +
			`peak RSS ${result.metrics.peak_rss_mb.toFixed(1)} MiB`,
	);
	if (result.passed) return;
	if (failureReason === 'empty') {
		console.error(`FAIL: ${result.sample_id} produced an empty transcript`);
	} else {
		console.error(
			`FAIL: ${result.sample_id} WER ${result.wer_percent.toFixed(2)}% ` +
				`exceeds threshold ${thresholds.maxWerPercent}%`,
		);
	}
}

function ensureSidecarStubs(repoRoot, hostTriple) {
	const binariesDirectory = path.join(repoRoot, 'app/src-tauri/binaries');
	fs.mkdirSync(binariesDirectory, { recursive: true });
	for (const binary of ['llama-helper', 'diarization-helper']) {
		const binaryPath = path.join(binariesDirectory, `${binary}-${hostTriple}`);
		if (fs.existsSync(binaryPath)) continue;
		fs.writeFileSync(binaryPath, '', { mode: 0o755 });
		console.error(`stubbed missing sidecar: ${path.relative(repoRoot, binaryPath)}`);
	}
}

export async function runRealRunCli(
	args,
	{
		repoRoot,
		defaultManifest,
		environment = process.env,
		prepareSession = prepareRealRunSession,
		loadCorpusImpl = loadCorpus,
		writeCorpusBoundJsonImpl = writeCorpusBoundJson,
		attestedRustcVersionImpl = attestedRustcVersion,
		evaluatorBuildEnvironmentImpl = evaluatorBuildEnvironment,
		ensureSidecarStubsImpl = ensureSidecarStubs,
		runReportedSample = runRealRunSample,
		runUnreportedSample = runRealRunSampleUnreported,
		aggregateReports = aggregateRealRunReports,
	} = {},
) {
	let options;
	try {
		options = parseRealRunArgs(args, { defaultManifest });
	} catch (error) {
		console.error(errorMessage(error));
		return { exitCode: 2, signal: null };
	}
	const evalModelsDirectory = resolveModelsDirectory(options.modelsDir, repoRoot);
	let corpus;
	try {
		corpus = loadCorpusImpl(options.manifestPath);
	} catch (error) {
		console.error(errorMessage(error));
		return { exitCode: 2, signal: null };
	}
	const fixtures = options.onlyFixture
		? corpus.samples.filter((sample) => sample.id === options.onlyFixture)
		: corpus.samples;
	if (fixtures.length === 0) {
		console.error(
			options.onlyFixture
				? `no corpus sample named '${options.onlyFixture}'`
				: 'corpus has no samples',
		);
		return { exitCode: 2, signal: null };
	}
	let rustcVersion;
	let buildEnvironment;
	try {
		rustcVersion = attestedRustcVersionImpl(repoRoot, { buildEnv: environment });
		ensureSidecarStubsImpl(repoRoot, rustcVersion.hostTriple);
		const buildTargetTriple = environment.CARGO_BUILD_TARGET || rustcVersion.hostTriple;
		buildEnvironment = evaluatorBuildEnvironmentImpl(
			environment,
			buildTargetTriple,
			rustcVersion.hostTriple,
		);
	} catch (error) {
		console.error(errorMessage(error));
		return { exitCode: 1, signal: null };
	}
	console.error(
		`running real ${options.provider} transcription with model '${options.model}' on ` +
			`${fixtures.length} fixture(s) (the model must already be downloaded)...`,
	);
	const thresholds = Object.freeze({
		maxWerPercent: options.maxWerPct,
		maxHallucinatedWords: options.maxHallucinatedWords,
	});
	const abortController = new AbortController();
	let terminationSignal = null;
	let session;
	const signalHandlers = {
		SIGINT: () => {
			terminationSignal ??= 'SIGINT';
			abortController.abort();
		},
		SIGTERM: () => {
			terminationSignal ??= 'SIGTERM';
			abortController.abort();
		},
	};
	process.on('SIGINT', signalHandlers.SIGINT);
	process.on('SIGTERM', signalHandlers.SIGTERM);
	try {
		session = prepareSession({
			provider: options.provider,
			model: options.model,
			backend: options.backend,
			accelerator: options.accelerator,
			modelsDirectory: evalModelsDirectory,
			repoRoot,
			buildEnvironment,
			runtimeEnvironment: environment,
			evaluatorRevision: options.outputPath ? undefined : null,
		});
		const reports = [];
		let failed = false;
		for (const fixture of fixtures) {
			const sample = {
				...fixture,
				corpus_id: corpus.corpus_id,
				corpus_fingerprint: corpus.corpus_fingerprint,
				reference_protocol_id: corpus.reference_protocol_id,
			};
			const run = options.outputPath
				? await runReportedSample(session, sample, {
						thresholds,
						signal: abortController.signal,
					})
				: await runUnreportedSample(session, sample, {
						thresholds,
						signal: abortController.signal,
					});
			const result = options.outputPath ? run.results[0] : run.result;
			const failureReason = options.outputPath
				? REPORT_METADATA.get(run)?.failureReason
				: run.failure_reason;
			logSampleResult(result, thresholds, failureReason);
			failed ||= !result.passed;
			if (options.outputPath) reports.push(run);
		}
		if (options.outputPath) {
			await session.revalidate();
			if (abortController.signal.aborted) throw abortError();
			const report = aggregateReports(reports);
			const absoluteOutput = path.resolve(options.outputPath);
			writeCorpusBoundJsonImpl({
				manifestPath: options.manifestPath,
				expectedFingerprint: corpus.corpus_fingerprint,
				outputPath: absoluteOutput,
				value: report,
				benchmarkLockToken: environment.MUESLY_CORPUS_BENCHMARK_TOKEN,
			});
			console.log(`wrote benchmark report: ${absoluteOutput}`);
		}
		return { exitCode: failed ? 1 : 0, signal: terminationSignal };
	} catch (error) {
		if (terminationSignal || error?.name === 'AbortError') {
			return { exitCode: 1, signal: terminationSignal };
		}
		console.error(errorMessage(error));
		return {
			exitCode: error instanceof RealRunProcessError ? error.exitCode : 1,
			signal: error instanceof RealRunProcessError ? error.signal : null,
		};
	} finally {
		session?.close();
		process.off('SIGINT', signalHandlers.SIGINT);
		process.off('SIGTERM', signalHandlers.SIGTERM);
	}
}
