import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { assertOwnedCorpusBenchmarkLock } from './corpus-benchmark-lock.ts';
import {
	acquireLocalCorpusLock,
	hasPendingWithdrawal,
	releaseLocalCorpusLock,
} from './corpus-intake.ts';
import {
	canonicalManifestPath,
	canonicalOutputPath,
	corpusFingerprint,
	loadCorpus,
	validateCorpusDocument,
} from './corpus.ts';
import { processIdentity, processOwnsState } from './process-identity.ts';

const RESULT_TRANSACTION_PATTERN = /^\.result-transaction-(\d+)-([0-9a-f-]{36})\.json$/;
const CORPUS_RESULT_LEASES = new WeakMap();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function fileMetadata(status) {
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

function sameMetadata(left, right) {
	return Object.keys(left).every((field) => left[field] === right[field]);
}

function canonicalJsonValue(value, label) {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) => canonicalJsonValue(entry, `${label}[${index}]`));
	}
	if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error(`${label} must contain only plain JSON values`);
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((field) => [field, canonicalJsonValue(value[field], `${label}.${field}`)]),
	);
}

function assertLoadedCorpusProjection(corpus, document, manifestPath, fingerprint) {
	const expected = {
		...document,
		corpus_fingerprint: fingerprint,
		manifest_path: manifestPath,
		samples: document.samples.map((sample) => ({
			...sample,
			audio_file: path.resolve(path.dirname(manifestPath), sample.audio_path),
			reference_file: path.resolve(path.dirname(manifestPath), sample.reference_path),
		})),
	};
	const actualJson = JSON.stringify(canonicalJsonValue(corpus, 'fully loaded corpus'));
	const expectedJson = JSON.stringify(canonicalJsonValue(expected, 'validated corpus manifest'));
	if (actualJson !== expectedJson) {
		throw new Error('the fully loaded corpus projection does not match its validated manifest');
	}
}

function deepFreeze(value) {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function hashDescriptor(descriptor) {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(1024 * 1024);
	let position = 0;
	for (;;) {
		const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
		if (bytesRead === 0) break;
		hash.update(buffer.subarray(0, bytesRead));
		position += bytesRead;
	}
	return hash.digest('hex');
}

function inspectStableRegularFile(filePath, label, read, options = {}) {
	const allowedLinks = new Set(options.allowedLinks ?? [1n]);
	const entryBefore = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
	if (!entryBefore?.isFile() || entryBefore.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file: ${filePath}`);
	}
	if (!allowedLinks.has(entryBefore.nlink)) {
		if (allowedLinks.size === 1 && allowedLinks.has(1n)) {
			throw new Error(`${label} must not be hard linked: ${filePath}`);
		}
		throw new Error(`${label} has an unexpected hard-link count: ${filePath}`);
	}
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const before = fileMetadata(entryBefore);
		if (!opened.isFile() || !sameMetadata(before, fileMetadata(opened))) {
			throw new Error(`${label} changed while it was opened: ${filePath}`);
		}
		const value = read(descriptor);
		const openedAfter = fs.fstatSync(descriptor, { bigint: true });
		const entryAfter = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
		if (
			!entryAfter?.isFile() ||
			entryAfter.isSymbolicLink() ||
			!allowedLinks.has(opened.nlink) ||
			!allowedLinks.has(openedAfter.nlink) ||
			!allowedLinks.has(entryAfter.nlink) ||
			!sameMetadata(fileMetadata(opened), fileMetadata(openedAfter)) ||
			!sameMetadata(fileMetadata(openedAfter), fileMetadata(entryAfter))
		) {
			throw new Error(`${label} changed while it was inspected: ${filePath}`);
		}
		const canonicalPath = fs.realpathSync(filePath);
		if (canonicalPath !== filePath) {
			throw new Error(`${label} path is not canonical: ${filePath}`);
		}
		return {
			canonicalPath,
			metadata: fileMetadata(openedAfter),
			value,
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

function directoryIdentity(directory, label) {
	const entry = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
	if (!entry?.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
		throw new Error(`${label} must be a canonical regular directory: ${directory}`);
	}
	return {
		dev: entry.dev.toString(),
		ino: entry.ino.toString(),
		mode: entry.mode.toString(),
	};
}

function permissionMode(metadata) {
	return Number(BigInt(metadata.mode) & 0o777n);
}

function assertPrivateDirectoryIdentity(directory, identity, label) {
	const current = directoryIdentity(directory, label);
	if (!sameMetadata(identity, current)) {
		throw new Error(`${label} changed after validation`);
	}
	if (process.platform !== 'win32' && permissionMode(current) !== 0o700) {
		throw new Error(`${label} must have private 0700 permissions`);
	}
}

function readManifestSnapshot(manifestPath) {
	const snapshot = inspectStableRegularFile(manifestPath, 'leased corpus manifest', (descriptor) =>
		fs.readFileSync(descriptor),
	);
	let document;
	try {
		document = JSON.parse(snapshot.value.toString('utf8'));
	} catch (error) {
		throw new Error(`failed to read leased corpus manifest ${manifestPath}: ${error.message}`);
	}
	return {
		document,
		metadata: snapshot.metadata,
		rawSha256: createHash('sha256').update(snapshot.value).digest('hex'),
	};
}

function sameLockOwnership(left, right) {
	return (
		left.lockPath === right.lockPath &&
		left.manifestPath === right.manifestPath &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.processIdentity === right.processIdentity &&
		left.createdAt === right.createdAt &&
		sameMetadata(left.lockIdentity.manifestDirectory, right.lockIdentity.manifestDirectory) &&
		sameMetadata(left.lockIdentity.localCorpus, right.lockIdentity.localCorpus) &&
		sameMetadata(left.lockIdentity.lock, right.lockIdentity.lock) &&
		sameMetadata(left.lockIdentity.owner, right.lockIdentity.owner)
	);
}

function participantCustody(manifestPath, sample, filePath, extension, field) {
	if (sample.provenance?.basis !== 'participant-consent') return null;
	const localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
	const sessionDirectory = path.join(localCorpusRoot, sample.session_id);
	const expectedPath = path.join(sessionDirectory, `${sample.id}${extension}`);
	if (filePath !== expectedPath) {
		throw new Error(
			`leased corpus sample '${sample.id}'.${field} is outside its managed session directory`,
		);
	}
	const localCorpusRootIdentity = directoryIdentity(localCorpusRoot, 'leased local corpus root');
	const sessionDirectoryLabel = `leased corpus sample '${sample.id}' session directory`;
	const sessionDirectoryIdentity = directoryIdentity(sessionDirectory, sessionDirectoryLabel);
	if (process.platform !== 'win32') {
		if (permissionMode(localCorpusRootIdentity) !== 0o700) {
			throw new Error('leased local corpus root must have private 0700 permissions');
		}
		if (permissionMode(sessionDirectoryIdentity) !== 0o700) {
			throw new Error(`${sessionDirectoryLabel} must have private 0700 permissions`);
		}
	}
	return {
		localCorpusRoot: {
			identity: localCorpusRootIdentity,
			path: localCorpusRoot,
		},
		sessionDirectory: {
			identity: sessionDirectoryIdentity,
			path: sessionDirectory,
		},
	};
}

function sampleFileSnapshot(manifestPath, sample, field, hashField, extension, options = {}) {
	const filePath = path.resolve(path.dirname(manifestPath), sample[field]);
	const custody = participantCustody(manifestPath, sample, filePath, extension, field);
	const snapshot = inspectStableRegularFile(
		filePath,
		`leased corpus sample '${sample.id}'.${field}`,
		(descriptor) => {
			if (!options.captureText) return null;
			const contents = fs.readFileSync(descriptor);
			if (createHash('sha256').update(contents).digest('hex') !== sample[hashField]) {
				throw new Error(`leased corpus sample '${sample.id}'.${field} digest is invalid`);
			}
			try {
				return UTF8_DECODER.decode(contents).trim();
			} catch {
				throw new Error(`leased corpus sample '${sample.id}'.${field} must be valid UTF-8`);
			}
		},
	);
	return {
		filePath: snapshot.canonicalPath,
		expectedSha256: sample[hashField],
		metadata: snapshot.metadata,
		custody,
		...(options.captureText ? { text: snapshot.value } : {}),
	};
}

function snapshotCorpusSamples(document, manifestPath) {
	const samples = new Map();
	for (const sample of document.samples) {
		const audio = sampleFileSnapshot(manifestPath, sample, 'audio_path', 'audio_sha256', '.wav');
		const reference = sampleFileSnapshot(
			manifestPath,
			sample,
			'reference_path',
			'reference_sha256',
			'.txt',
			{ captureText: true },
		);
		samples.set(
			sample.id,
			Object.freeze({
				audio,
				inference: deepFreeze({
					...structuredClone(sample),
					audio_file: audio.filePath,
					reference_file: reference.filePath,
					reference_text: reference.text,
				}),
				reference,
			}),
		);
	}
	return samples;
}

function resultLeaseState(lease) {
	if (
		lease === null ||
		(typeof lease !== 'object' && typeof lease !== 'function') ||
		!CORPUS_RESULT_LEASES.has(lease)
	) {
		throw new Error('a validated corpus result lease is required');
	}
	return CORPUS_RESULT_LEASES.get(lease);
}

function assertLeaseCurrent(state) {
	const ownership = assertOwnedCorpusBenchmarkLock(state.manifestPath, state.benchmarkLockToken, {
		currentIdentity: state.benchmarkProcessIdentity,
	});
	if (!sameLockOwnership(state.lockOwnership, ownership)) {
		throw new Error('the leased corpus benchmark lock changed after validation');
	}
	assertPrivateDirectoryIdentity(
		state.localCorpusRoot,
		state.localCorpusRootIdentity,
		'leased local corpus root',
	);
	assertPrivateDirectoryIdentity(
		state.resultsRoot,
		state.resultsRootIdentity,
		'leased corpus results directory',
	);
	assertNoLeasedResultTransactions(state.resultsRoot, state.resultsRootIdentity);
	if (hasPendingWithdrawal(state.localCorpusRoot)) {
		throw new Error(
			'a corpus withdrawal is pending; refusing to write results until it is resumed',
		);
	}
	const manifestPath = canonicalManifestPath(state.manifestPath);
	if (manifestPath !== state.manifestPath) {
		throw new Error('the leased corpus manifest path changed after validation');
	}
	const manifest = readManifestSnapshot(state.manifestPath);
	if (
		manifest.rawSha256 !== state.manifestRawSha256 ||
		!sameMetadata(manifest.metadata, state.manifestMetadata) ||
		corpusFingerprint(manifest.document) !== state.corpusFingerprint
	) {
		throw new Error('the leased corpus manifest changed after validation');
	}
}

function assertSampleFileUnchanged(sampleId, label, expected) {
	if (expected.custody) {
		assertPrivateDirectoryIdentity(
			expected.custody.localCorpusRoot.path,
			expected.custody.localCorpusRoot.identity,
			'leased local corpus root',
		);
		assertPrivateDirectoryIdentity(
			expected.custody.sessionDirectory.path,
			expected.custody.sessionDirectory.identity,
			`leased corpus sample '${sampleId}' session directory`,
		);
	}
	const current = inspectStableRegularFile(
		expected.filePath,
		`leased corpus sample '${sampleId}' ${label}`,
		hashDescriptor,
	);
	if (
		current.canonicalPath !== expected.filePath ||
		!sameMetadata(current.metadata, expected.metadata) ||
		current.value !== expected.expectedSha256
	) {
		throw new Error(`leased corpus sample '${sampleId}' ${label} changed after validation`);
	}
}

/**
 * Creates an in-process lease from a corpus that the caller has already fully
 * loaded and validated while holding the benchmark campaign lock.
 *
 * The lease snapshots the exact lock, canonical manifest bytes and metadata,
 * corpus fingerprint, and sample file identities. It intentionally does not
 * replace the campaign's initial or final loadCorpus() validation. Pass the
 * exact non-null processIdentity returned by acquireCorpusBenchmarkLock().
 */
export function createCorpusResultLease(options) {
	const corpus = options?.corpus;
	if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
		throw new Error('a fully loaded corpus is required to create a result lease');
	}
	if (corpus.distribution !== 'local') {
		throw new Error('corpus result leases require a local corpus');
	}
	if (
		typeof corpus.manifest_path !== 'string' ||
		canonicalManifestPath(corpus.manifest_path) !== corpus.manifest_path
	) {
		throw new Error('the fully loaded corpus manifest path must be canonical');
	}
	if (
		typeof corpus.corpus_fingerprint !== 'string' ||
		!/^[a-f0-9]{64}$/.test(corpus.corpus_fingerprint)
	) {
		throw new Error('the fully loaded corpus fingerprint must be a lowercase SHA-256 digest');
	}
	if (!Array.isArray(corpus.samples)) {
		throw new Error('the fully loaded corpus samples must be an array');
	}

	const manifestPath = corpus.manifest_path;
	const localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
	if (
		typeof options.benchmarkProcessIdentity !== 'string' ||
		options.benchmarkProcessIdentity.length === 0
	) {
		throw new Error('a verified benchmark process identity is required to create a result lease');
	}
	const lockOwnership = assertOwnedCorpusBenchmarkLock(manifestPath, options.benchmarkLockToken, {
		currentIdentity: options.benchmarkProcessIdentity,
	});
	const localCorpusRootIdentity = directoryIdentity(localCorpusRoot, 'leased local corpus root');
	const localLockPath = path.join(localCorpusRoot, '.intake.lock');
	const localLockToken = acquireLocalCorpusLock(localLockPath, localCorpusRoot, manifestPath, {
		operation: 'result-write',
		benchmarkToken: options.benchmarkLockToken,
	});
	try {
		if (hasPendingWithdrawal(localCorpusRoot)) {
			throw new Error('a corpus withdrawal is pending; resume it before creating a result lease');
		}
		const manifest = readManifestSnapshot(manifestPath);
		const fingerprint = corpusFingerprint(manifest.document);
		const manifestErrors = validateCorpusDocument(manifest.document, {
			manifestPath,
			checkFiles: false,
		});
		if (manifestErrors.length > 0) {
			throw new Error(`the leased corpus manifest is invalid:\n- ${manifestErrors.join('\n- ')}`);
		}
		if (
			manifest.document.distribution !== 'local' ||
			manifest.document.corpus_id !== corpus.corpus_id ||
			fingerprint !== corpus.corpus_fingerprint
		) {
			throw new Error('the fully loaded corpus does not match the current manifest');
		}
		assertLoadedCorpusProjection(corpus, manifest.document, manifestPath, fingerprint);

		const resultsRoot = path.join(path.dirname(manifestPath), 'results');
		const resultsRootIdentity = ensurePrivateResultsDirectory(resultsRoot);
		assertNoLeasedResultTransactions(resultsRoot, resultsRootIdentity);

		const state = {
			benchmarkLockToken: options.benchmarkLockToken,
			benchmarkProcessIdentity: options.benchmarkProcessIdentity,
			corpusFingerprint: fingerprint,
			corpusId: manifest.document.corpus_id,
			localCorpusRoot,
			localCorpusRootIdentity,
			lockOwnership,
			manifestMetadata: manifest.metadata,
			manifestPath,
			manifestRawSha256: manifest.rawSha256,
			resultsRoot,
			resultsRootIdentity,
			samples: snapshotCorpusSamples(manifest.document, manifestPath),
		};
		assertLeaseCurrent(state);

		const lease = Object.freeze({
			corpusFingerprint: state.corpusFingerprint,
			corpusId: state.corpusId,
			manifestPath: state.manifestPath,
		});
		CORPUS_RESULT_LEASES.set(lease, state);
		return lease;
	} finally {
		releaseLocalCorpusLock(localLockPath, localLockToken);
	}
}

/**
 * Re-hashes one selected sample and rechecks its custody and campaign lease.
 * Call immediately before and after inference to fail closed on sample drift.
 * The returned frozen descriptor contains the exact bound inference paths.
 */
export function assertLeasedCorpusSampleUnchanged(lease, sampleId) {
	const state = resultLeaseState(lease);
	if (typeof sampleId !== 'string' || !state.samples.has(sampleId)) {
		throw new Error(`leased corpus sample is not available: ${sampleId}`);
	}
	assertLeaseCurrent(state);
	const sample = state.samples.get(sampleId);
	assertSampleFileUnchanged(sampleId, 'audio', sample.audio);
	assertSampleFileUnchanged(sampleId, 'reference', sample.reference);
	assertLeaseCurrent(state);
	return sample.inference;
}

function validateLocalOutputPath(resultsRoot, outputPath) {
	if (path.dirname(outputPath) !== resultsRoot) {
		throw new Error(
			`local corpus outputs must be direct files in the managed results directory: ${resultsRoot}`,
		);
	}
	const resultsEntry = fs.lstatSync(resultsRoot, { throwIfNoEntry: false });
	if (resultsEntry?.isSymbolicLink()) {
		throw new Error(`local corpus results directory cannot be a symbolic link: ${resultsRoot}`);
	}
	if (resultsEntry && !resultsEntry.isDirectory()) {
		throw new Error(`local corpus results path is not a directory: ${resultsRoot}`);
	}
}

function writeTransactionMarker(markerPath, transaction) {
	const stagedMarker = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.writeFileSync(stagedMarker, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
		fs.renameSync(stagedMarker, markerPath);
	} finally {
		fs.rmSync(stagedMarker, { force: true });
	}
}

function isDirectFileName(value) {
	return (
		typeof value === 'string' && value !== '.' && value !== '..' && path.basename(value) === value
	);
}

function readTransactionMarker(directory, entry) {
	const match = entry.name.match(RESULT_TRANSACTION_PATTERN);
	if (!match) return null;
	const markerPath = path.join(directory, entry.name);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`result transaction marker is not a regular file: ${markerPath}`);
	}
	let transaction;
	try {
		transaction = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read result transaction ${markerPath}: ${error.message}`);
	}
	const pid = Number(match[1]);
	const token = match[2];
	if (
		![1, 2].includes(transaction.schema_version) ||
		transaction.pid !== pid ||
		transaction.token !== token ||
		(transaction.schema_version === 2 &&
			transaction.process_identity !== undefined &&
			(typeof transaction.process_identity !== 'string' ||
				transaction.process_identity.length === 0)) ||
		!['prepared', 'committed'].includes(transaction.state) ||
		!Array.isArray(transaction.outputs) ||
		transaction.outputs.length < 2
	) {
		throw new Error(`result transaction marker is invalid: ${markerPath}`);
	}
	const outputNames = new Set();
	for (const output of transaction.outputs) {
		if (
			!isDirectFileName(output.file) ||
			!isDirectFileName(output.staged_file) ||
			!output.staged_file.startsWith(`${output.file}.tmp-${pid}-`) ||
			!isDirectFileName(output.backup_file) ||
			output.backup_file !== `${output.file}.bak-${pid}-${token}` ||
			typeof output.had_original !== 'boolean' ||
			outputNames.has(output.file)
		) {
			throw new Error(`result transaction marker is invalid: ${markerPath}`);
		}
		outputNames.add(output.file);
	}
	return { markerPath, transaction };
}

function finishResultTransaction(directory, markerPath, transaction) {
	for (const output of transaction.outputs) {
		fs.rmSync(path.join(directory, output.staged_file), { force: true });
		fs.rmSync(path.join(directory, output.backup_file), { force: true });
	}
	fs.rmSync(markerPath, { force: true });
}

function rollBackResultTransaction(directory, markerPath, transaction) {
	for (const output of transaction.outputs) {
		const outputPath = path.join(directory, output.file);
		const backupPath = path.join(directory, output.backup_file);
		if (fs.existsSync(backupPath)) {
			fs.rmSync(outputPath, { force: true });
			fs.renameSync(backupPath, outputPath);
		} else if (!output.had_original) {
			fs.rmSync(outputPath, { force: true });
		}
		fs.rmSync(path.join(directory, output.staged_file), { force: true });
	}
	fs.rmSync(markerPath, { force: true });
}

function recoverResultTransactions(directory) {
	const directoryEntry = fs.lstatSync(directory, { throwIfNoEntry: false });
	if (!directoryEntry) return;
	if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
		throw new Error(`result output path is not a regular directory: ${directory}`);
	}
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const recovered = readTransactionMarker(directory, entry);
		if (!recovered) continue;
		if (processOwnsState(recovered.transaction)) {
			throw new Error(`another result transaction is active: ${recovered.markerPath}`);
		}
		if (recovered.transaction.state === 'committed') {
			finishResultTransaction(directory, recovered.markerPath, recovered.transaction);
		} else {
			rollBackResultTransaction(directory, recovered.markerPath, recovered.transaction);
		}
	}
}

function leasedResultsDirectoryGuard(directory, identity) {
	return () =>
		assertPrivateDirectoryIdentity(
			directory,
			identity,
			'leased corpus results directory during transaction preflight',
		);
}

function openDirectoryRevisionGuard(directory, label) {
	const entry = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
	if (!entry?.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`${label} must be a regular directory: ${directory}`);
	}
	const descriptor = fs.openSync(
		directory,
		fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!opened.isDirectory() || !sameMetadata(fileMetadata(entry), fileMetadata(opened))) {
			throw new Error(`${label} changed while it was opened: ${directory}`);
		}
		return {
			descriptor,
			metadata: fileMetadata(opened),
			path: directory,
		};
	} catch (error) {
		fs.closeSync(descriptor);
		throw error;
	}
}

function assertDirectoryRevisionGuardUnchanged(guard, label) {
	const opened = fs.fstatSync(guard.descriptor, { bigint: true });
	const installed = fs.lstatSync(guard.path, { bigint: true, throwIfNoEntry: false });
	if (
		!opened.isDirectory() ||
		!installed?.isDirectory() ||
		installed.isSymbolicLink() ||
		!sameMetadata(guard.metadata, fileMetadata(opened)) ||
		!sameMetadata(fileMetadata(opened), fileMetadata(installed))
	) {
		throw new Error(`${label} changed after validation: ${guard.path}`);
	}
}

function assertNoLeasedResultTransactions(directory, identity) {
	const assertDirectory = leasedResultsDirectoryGuard(directory, identity);
	assertDirectory();
	const parentGuard = openDirectoryRevisionGuard(
		path.dirname(directory),
		'leased corpus results parent directory',
	);
	let resultsGuard;
	try {
		resultsGuard = openDirectoryRevisionGuard(
			directory,
			'leased corpus results directory during transaction preflight',
		);
		assertDirectory();
		assertDirectoryRevisionGuardUnchanged(parentGuard, 'leased corpus results parent directory');
		assertDirectoryRevisionGuardUnchanged(
			resultsGuard,
			'leased corpus results directory during transaction preflight',
		);
		const entries = fs.readdirSync(directory, { withFileTypes: true });
		assertDirectoryRevisionGuardUnchanged(
			resultsGuard,
			'leased corpus results directory during transaction preflight',
		);
		assertDirectoryRevisionGuardUnchanged(parentGuard, 'leased corpus results parent directory');
		assertDirectory();
		const marker = entries.find((entry) => RESULT_TRANSACTION_PATTERN.test(entry.name));
		if (marker) {
			throw new Error(
				`a legacy result transaction requires recovery outside the corpus result lease: ${path.join(directory, marker.name)}`,
			);
		}
	} finally {
		if (resultsGuard) fs.closeSync(resultsGuard.descriptor);
		fs.closeSync(parentGuard.descriptor);
	}
}

function promoteOutputSet(stagedOutputs) {
	const directory = path.dirname(stagedOutputs[0].outputPath);
	const token = randomUUID();
	const identity = processIdentity(process.pid);
	const markerPath = path.join(directory, `.result-transaction-${process.pid}-${token}.json`);
	const transaction = {
		schema_version: 2,
		pid: process.pid,
		...(identity ? { process_identity: identity } : {}),
		token,
		state: 'prepared',
		outputs: stagedOutputs.map((output) => {
			const existing = fs.lstatSync(output.outputPath, { throwIfNoEntry: false });
			if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
				throw new Error(`result output is not a regular file: ${output.outputPath}`);
			}
			const file = path.basename(output.outputPath);
			return {
				file,
				staged_file: path.basename(output.stagedPath),
				backup_file: `${file}.bak-${process.pid}-${token}`,
				had_original: Boolean(existing),
			};
		}),
	};
	writeTransactionMarker(markerPath, transaction);
	try {
		for (const output of transaction.outputs) {
			if (output.had_original) {
				fs.renameSync(path.join(directory, output.file), path.join(directory, output.backup_file));
			}
		}
		for (const output of transaction.outputs) {
			fs.renameSync(path.join(directory, output.staged_file), path.join(directory, output.file));
		}
		transaction.state = 'committed';
		writeTransactionMarker(markerPath, transaction);
	} catch (error) {
		rollBackResultTransaction(directory, markerPath, transaction);
		throw error;
	}
	finishResultTransaction(directory, markerPath, transaction);
}

function canonicalCorpusBoundOutputs(rawOutputs) {
	if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
		throw new Error('at least one corpus-bound output is required');
	}
	const outputs = rawOutputs.map((output) => ({
		contents: output.contents,
		outputPath: canonicalOutputPath(output.outputPath),
	}));
	if (new Set(outputs.map((output) => output.outputPath)).size !== outputs.length) {
		throw new Error('corpus-bound output paths must be unique');
	}
	if (
		outputs.length > 1 &&
		new Set(outputs.map((output) => path.dirname(output.outputPath))).size !== 1
	) {
		throw new Error('corpus-bound output sets must share one directory');
	}
	return outputs;
}

function ensurePrivateResultsDirectory(resultsRoot) {
	const existing = fs.lstatSync(resultsRoot, { throwIfNoEntry: false });
	if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
		throw new Error(`local corpus results path is not a regular directory: ${resultsRoot}`);
	}
	fs.mkdirSync(resultsRoot, { recursive: true, mode: 0o700 });
	const before = directoryIdentity(resultsRoot, 'leased corpus results directory');
	if (process.platform === 'win32') return before;
	const flags =
		fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
	const descriptor = fs.openSync(resultsRoot, flags);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (
			!opened.isDirectory() ||
			opened.dev.toString() !== before.dev ||
			opened.ino.toString() !== before.ino
		) {
			throw new Error(`local corpus results path changed while opening: ${resultsRoot}`);
		}
		if (process.platform !== 'win32') {
			fs.fchmodSync(descriptor, 0o700);
		}
	} finally {
		fs.closeSync(descriptor);
	}
	const installed = directoryIdentity(resultsRoot, 'leased corpus results directory');
	if (installed.dev !== before.dev || installed.ino !== before.ino) {
		throw new Error(`local corpus results path changed during creation: ${resultsRoot}`);
	}
	if (process.platform !== 'win32' && permissionMode(installed) !== 0o700) {
		throw new Error(`local corpus results path must have private 0700 permissions: ${resultsRoot}`);
	}
	return installed;
}

function assertLocalOutputTargets(resultsRoot, outputs) {
	for (const output of outputs) {
		validateLocalOutputPath(resultsRoot, output.outputPath);
		if (canonicalOutputPath(output.outputPath) !== output.outputPath) {
			throw new Error(`local corpus output path changed before promotion: ${output.outputPath}`);
		}
		const entry = fs.lstatSync(output.outputPath, { throwIfNoEntry: false });
		if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
			throw new Error(`result output is not a regular file: ${output.outputPath}`);
		}
	}
}

function assertBoundResultsDirectory(state) {
	assertPrivateDirectoryIdentity(
		state.resultsRoot,
		state.resultsRootIdentity,
		'leased corpus results directory',
	);
}

function assertPrivateFileMetadata(metadata, label) {
	if (process.platform !== 'win32' && permissionMode(metadata) !== 0o600) {
		throw new Error(`${label} must have private 0600 permissions`);
	}
}

function installedFileIdentity(metadata) {
	return {
		dev: metadata.dev,
		ino: metadata.ino,
		mode: metadata.mode,
		size: metadata.size,
		mtimeNs: metadata.mtimeNs,
	};
}

function sameCapturedInode(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function quarantineLeasedPath(state, filePath, expected, label) {
	assertBoundResultsDirectory(state);
	const entry = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
	if (!entry) return null;

	const quarantineDirectory = path.join(
		state.resultsRoot,
		`.lease-quarantine-${process.pid}-${randomUUID()}`,
	);
	fs.mkdirSync(quarantineDirectory, { mode: 0o700 });
	const quarantineDirectoryIdentity = directoryIdentity(
		quarantineDirectory,
		`${label} quarantine directory`,
	);
	if (process.platform !== 'win32' && permissionMode(quarantineDirectoryIdentity) !== 0o700) {
		throw new Error(`${label} quarantine directory must have private 0700 permissions`);
	}
	assertBoundResultsDirectory(state);

	const quarantinePath = path.join(quarantineDirectory, 'entry');
	const source = inspectStableRegularFile(filePath, `${label} source`, hashDescriptor, {
		allowedLinks: [entry.nlink],
	});
	assertPrivateFileMetadata(source.metadata, `${label} source`);
	const sourceLinks = BigInt(source.metadata.nlink);
	try {
		fs.linkSync(filePath, quarantinePath);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
	const linkedSource = inspectStableRegularFile(
		filePath,
		`${label} linked source`,
		hashDescriptor,
		{
			allowedLinks: [sourceLinks + 1n],
		},
	);
	const linkedQuarantine = inspectStableRegularFile(
		quarantinePath,
		`${label} linked quarantine`,
		hashDescriptor,
		{ allowedLinks: [sourceLinks + 1n] },
	);
	if (
		!sameCapturedInode(source.metadata, linkedSource.metadata) ||
		!sameCapturedInode(linkedSource.metadata, linkedQuarantine.metadata) ||
		source.value !== linkedSource.value ||
		linkedSource.value !== linkedQuarantine.value
	) {
		throw new Error(
			`${label} changed while it was linked into quarantine; both paths were preserved`,
		);
	}
	assertBoundResultsDirectory(state);
	assertPrivateDirectoryIdentity(
		quarantineDirectory,
		quarantineDirectoryIdentity,
		`${label} quarantine directory`,
	);

	const quarantined = inspectStableRegularFile(
		quarantinePath,
		`${label} quarantine`,
		hashDescriptor,
		{
			// Keep both names after validation. Unlinking the source by pathname
			// would allow a replacement installed after inspection to be deleted.
			allowedLinks: [sourceLinks + 1n],
		},
	);
	assertPrivateFileMetadata(quarantined.metadata, `${label} quarantine`);
	if (
		!sameCapturedInode(source.metadata, quarantined.metadata) ||
		source.value !== quarantined.value
	) {
		throw new Error(`${label} changed while it was quarantined; the evidence was preserved`);
	}
	const exactInode = sameCapturedInode(quarantined.metadata, expected.metadata);
	const exactMetadata = sameMetadata(
		installedFileIdentity(quarantined.metadata),
		installedFileIdentity(expected.metadata),
	);
	const exactContents =
		expected.expectedSha256 === undefined || quarantined.value === expected.expectedSha256;
	if (!exactInode || !exactMetadata || !exactContents) {
		throw new Error(
			`${label} was replaced while it was quarantined; the replacement was preserved at ${quarantinePath}`,
		);
	}
	return quarantinePath;
}

function createLeasedStagedOutput(state, outputPath, contents) {
	const stagedPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
	const expectedSha256 = createHash('sha256').update(contents).digest('hex');
	assertBoundResultsDirectory(state);
	const flags =
		fs.constants.O_CREAT |
		fs.constants.O_EXCL |
		fs.constants.O_RDWR |
		(fs.constants.O_NOFOLLOW ?? 0);
	let descriptor = null;
	let createdMetadata = null;
	let metadata;
	let creationError = null;
	try {
		descriptor = fs.openSync(stagedPath, flags, 0o600);
		const created = fs.fstatSync(descriptor, { bigint: true });
		createdMetadata = fileMetadata(created);
		if (!created.isFile() || created.nlink !== 1n) {
			throw new Error(`leased staged output must be a regular single-link file: ${stagedPath}`);
		}
		if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
		fs.writeFileSync(descriptor, contents);
		fs.fsyncSync(descriptor);
		const status = fs.fstatSync(descriptor, { bigint: true });
		if (!status.isFile() || status.nlink !== 1n) {
			throw new Error(`leased staged output must be a regular single-link file: ${stagedPath}`);
		}
		metadata = fileMetadata(status);
		assertPrivateFileMetadata(metadata, 'leased staged output');
		if (hashDescriptor(descriptor) !== expectedSha256) {
			throw new Error(`leased staged output digest changed during creation: ${stagedPath}`);
		}
	} catch (error) {
		creationError = error;
	} finally {
		if (descriptor !== null) {
			try {
				fs.closeSync(descriptor);
			} catch (error) {
				creationError ??= error;
			}
		}
	}
	if (creationError) {
		if (createdMetadata) {
			try {
				quarantineLeasedPath(
					state,
					stagedPath,
					{ metadata: createdMetadata },
					'failed leased staged output',
				);
			} catch (cleanupError) {
				throw new AggregateError(
					[creationError, cleanupError],
					'leased staged output creation and cleanup both failed',
				);
			}
		}
		throw creationError;
	}
	assertBoundResultsDirectory(state);
	const staged = { expectedSha256, metadata, stagedPath };
	try {
		assertLeasedStagedOutput(state, staged);
	} catch (error) {
		try {
			quarantineLeasedPath(state, stagedPath, staged, 'failed leased staged output');
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'leased staged output validation and cleanup both failed',
			);
		}
		throw error;
	}
	return staged;
}

function assertLeasedStagedOutput(state, staged) {
	assertBoundResultsDirectory(state);
	const current = inspectStableRegularFile(
		staged.stagedPath,
		'leased staged output',
		hashDescriptor,
	);
	assertPrivateFileMetadata(current.metadata, 'leased staged output');
	if (!sameMetadata(current.metadata, staged.metadata) || current.value !== staged.expectedSha256) {
		throw new Error(`leased staged output changed after creation: ${staged.stagedPath}`);
	}
	assertBoundResultsDirectory(state);
}

function assertInstalledLeasedOutput(state, staged, outputPath, allowedLinks = [1n]) {
	assertBoundResultsDirectory(state);
	const installed = inspectStableRegularFile(
		outputPath,
		'installed leased corpus output',
		hashDescriptor,
		{ allowedLinks },
	);
	assertPrivateFileMetadata(installed.metadata, 'installed leased corpus output');
	if (
		!sameMetadata(
			installedFileIdentity(installed.metadata),
			installedFileIdentity(staged.metadata),
		) ||
		installed.value !== staged.expectedSha256
	) {
		throw new Error(`installed leased corpus output changed during promotion: ${outputPath}`);
	}
	assertBoundResultsDirectory(state);
	return installed;
}

function removeLeasedStagedOutput(state, staged) {
	assertBoundResultsDirectory(state);
	if (!fs.lstatSync(staged.stagedPath, { throwIfNoEntry: false })) return;
	quarantineLeasedPath(state, staged.stagedPath, staged, 'leased staged output cleanup');
}

function quarantineFailedLeasedOutput(state, staged, outputPath) {
	return quarantineLeasedPath(state, outputPath, staged, 'failed leased corpus output');
}

function assertLinkedLeasedOutput(state, staged, outputPath) {
	const installed = assertInstalledLeasedOutput(state, staged, outputPath, [2n]);
	const stagedAfterLink = inspectStableRegularFile(
		staged.stagedPath,
		'linked leased staged output',
		hashDescriptor,
		{ allowedLinks: [2n] },
	);
	if (
		!sameMetadata(
			installedFileIdentity(stagedAfterLink.metadata),
			installedFileIdentity(staged.metadata),
		) ||
		stagedAfterLink.value !== staged.expectedSha256 ||
		!sameCapturedInode(stagedAfterLink.metadata, installed.metadata)
	) {
		throw new Error(
			`leased staged output changed during no-clobber publication: ${staged.stagedPath}`,
		);
	}
	assertBoundResultsDirectory(state);
}

function promoteLeasedOutput(state, staged, outputPath) {
	assertBoundResultsDirectory(state);
	assertLocalOutputTargets(state.resultsRoot, [{ outputPath }]);
	assertLeasedStagedOutput(state, staged);
	assertBoundResultsDirectory(state);
	let linked = false;
	try {
		fs.linkSync(staged.stagedPath, outputPath);
		linked = true;
		assertBoundResultsDirectory(state);
		assertLinkedLeasedOutput(state, staged, outputPath);
		const installed = assertInstalledLeasedOutput(state, staged, outputPath, [2n]);
		return {
			expectedSha256: staged.expectedSha256,
			metadata: installed.metadata,
		};
	} catch (error) {
		if (linked) {
			try {
				quarantineFailedLeasedOutput(state, staged, outputPath);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					'leased corpus output promotion and cleanup both failed',
				);
			}
		}
		throw error;
	}
}

/**
 * Writes one checkpoint through a validated campaign lease without running a
 * full loadCorpus() validation. The exact benchmark lock, manifest snapshot,
 * staged inode, results directory, and installed output are attested around
 * atomic no-clobber hard-link publication.
 */
export function writeLeasedCorpusBoundJson(options) {
	const state = resultLeaseState(options?.lease);
	const output = canonicalCorpusBoundOutputs([
		{
			outputPath: options.outputPath,
			contents: `${JSON.stringify(options.value, null, 2)}\n`,
		},
	])[0];
	validateLocalOutputPath(state.resultsRoot, output.outputPath);
	assertLeaseCurrent(state);

	const localLockPath = path.join(state.localCorpusRoot, '.intake.lock');
	const localLockToken = acquireLocalCorpusLock(
		localLockPath,
		state.localCorpusRoot,
		state.manifestPath,
		{
			operation: 'result-write',
			benchmarkToken: state.benchmarkLockToken,
		},
	);
	let staged = null;
	let publication = null;
	let publishedSuccessfully = false;
	let operationError = null;
	try {
		assertLeaseCurrent(state);
		assertLocalOutputTargets(state.resultsRoot, [output]);
		staged = createLeasedStagedOutput(state, output.outputPath, output.contents);
		assertLeaseCurrent(state);
		assertLeasedStagedOutput(state, staged);
		publication = promoteLeasedOutput(state, staged, output.outputPath);
		assertLeaseCurrent(state);
		publishedSuccessfully = true;
	} catch (error) {
		operationError = error;
		if (publication) {
			try {
				quarantineFailedLeasedOutput(state, publication, output.outputPath);
			} catch (cleanupError) {
				operationError = new AggregateError(
					[operationError, cleanupError],
					'leased corpus output validation and quarantine both failed',
				);
			}
		}
	} finally {
		try {
			if (staged && !publishedSuccessfully) {
				try {
					removeLeasedStagedOutput(state, staged);
				} catch (cleanupError) {
					operationError = operationError
						? new AggregateError(
								[operationError, cleanupError],
								'leased corpus output and staged cleanup both failed',
							)
						: cleanupError;
				}
			}
		} finally {
			releaseLocalCorpusLock(localLockPath, localLockToken);
		}
	}
	if (operationError) throw operationError;
}

export function writeCorpusBoundFiles(options) {
	const manifestPath = canonicalManifestPath(options.manifestPath);
	const outputs = canonicalCorpusBoundOutputs(options.outputs);
	const initialCorpus = loadCorpus(manifestPath);
	let localCorpusRoot;
	let lockPath;
	let lockToken;
	let resultsRoot;
	if (initialCorpus.distribution === 'local') {
		localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
		resultsRoot = path.join(path.dirname(manifestPath), 'results');
		for (const output of outputs) validateLocalOutputPath(resultsRoot, output.outputPath);
		const localCorpusEntry = fs.lstatSync(localCorpusRoot, { throwIfNoEntry: false });
		if (localCorpusEntry?.isSymbolicLink()) {
			throw new Error(`local corpus directory cannot be a symbolic link: ${localCorpusRoot}`);
		}
		if (localCorpusEntry && !localCorpusEntry.isDirectory()) {
			throw new Error(`local corpus path is not a directory: ${localCorpusRoot}`);
		}
		fs.mkdirSync(localCorpusRoot, { recursive: true, mode: 0o700 });
		lockPath = path.join(localCorpusRoot, '.intake.lock');
		lockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath, {
			operation: 'result-write',
			benchmarkToken: options.benchmarkLockToken,
		});
	}

	const stagedOutputs = outputs.map((output) => ({
		...output,
		stagedPath: `${output.outputPath}.tmp-${process.pid}-${randomUUID()}`,
	}));
	try {
		if (localCorpusRoot && hasPendingWithdrawal(localCorpusRoot)) {
			throw new Error(
				'a corpus withdrawal is pending; refusing to write results until it is resumed',
			);
		}
		if (resultsRoot) {
			fs.mkdirSync(resultsRoot, { recursive: true, mode: 0o700 });
			fs.chmodSync(resultsRoot, 0o700);
			for (const output of outputs) validateLocalOutputPath(resultsRoot, output.outputPath);
		} else {
			for (const output of outputs) {
				fs.mkdirSync(path.dirname(output.outputPath), { recursive: true });
			}
		}
		for (const directory of new Set(outputs.map((output) => path.dirname(output.outputPath)))) {
			recoverResultTransactions(directory);
		}
		const currentCorpus = loadCorpus(manifestPath);
		if (currentCorpus.corpus_fingerprint !== options.expectedFingerprint) {
			throw new Error(
				'corpus changed while the benchmark was running; refusing to write stale results',
			);
		}
		for (const output of stagedOutputs) {
			fs.writeFileSync(output.stagedPath, output.contents, {
				mode: resultsRoot ? 0o600 : 0o666,
			});
		}
		if (stagedOutputs.length === 1) {
			fs.renameSync(stagedOutputs[0].stagedPath, stagedOutputs[0].outputPath);
		} else {
			promoteOutputSet(stagedOutputs);
		}
	} finally {
		for (const output of stagedOutputs) fs.rmSync(output.stagedPath, { force: true });
		if (lockPath && lockToken) releaseLocalCorpusLock(lockPath, lockToken);
	}
}

export function writeCorpusBoundJson(options) {
	writeCorpusBoundFiles({
		manifestPath: options.manifestPath,
		expectedFingerprint: options.expectedFingerprint,
		benchmarkLockToken: options.benchmarkLockToken,
		outputs: [
			{
				outputPath: options.outputPath,
				contents: `${JSON.stringify(options.value, null, 2)}\n`,
			},
		],
	});
}
