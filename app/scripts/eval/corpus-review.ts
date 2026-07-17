import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { REFERENCE_PROTOCOL_ID } from './corpus.ts';
import {
	acquirePublicCorpusLock,
	assertPublicCorpusLockOwned,
	releasePublicCorpusLock,
} from './public-corpus-lock.ts';

export const CONSENTED_REVIEW_SCHEMA_VERSION = 1;
export const CONSENTED_REVIEW_DIRECTORY_NAME = 'review-attestations';
export const REQUIRED_CONSENTED_REVIEW_COUNT = 2;

const REVIEWER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REVIEW_BYTES = 16 * 1024;
const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const REVIEW_PENDING_PATTERN = /^\.pending-([a-f0-9]{64})-([0-9a-f-]{36})\.json$/;
const REVIEW_FIELDS = new Set([
	'schema_version',
	'session_id',
	'sample_id',
	'reviewer_id',
	'reviewed_at',
	'decision',
	'affirmed_reference_protocol_id',
	'audio_sha256',
	'reference_sha256',
]);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameRevision(left, right) {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function assertPrivateMode(status, label) {
	if (process.platform !== 'win32' && (status.mode & 0o077n) !== 0n) {
		throw new Error(`${label} must not be accessible by group or other users`);
	}
}

function isIsoTimestamp(value) {
	return (
		typeof value === 'string' &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

function assertReviewerId(reviewerId) {
	if (!REVIEWER_ID_PATTERN.test(reviewerId ?? '')) {
		throw new Error('reviewer ID must be an opaque lowercase identifier of at most 64 characters');
	}
	return reviewerId;
}

function reviewerFilename(reviewerId) {
	return `${createHash('sha256').update(assertReviewerId(reviewerId)).digest('hex')}.json`;
}

function assertReviewDirectory(reviewDirectory) {
	const status = fs.lstatSync(reviewDirectory, { bigint: true, throwIfNoEntry: false });
	if (!status?.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`review attestations must be stored in a real directory: ${reviewDirectory}`);
	}
	assertPrivateMode(status, 'review attestations directory');
	return status;
}

function captureReviewDirectory(reviewDirectory, expectedIdentity) {
	const identity = assertReviewDirectory(reviewDirectory);
	if (expectedIdentity && !sameIdentity(expectedIdentity, identity)) {
		throw new Error(`review attestations directory changed before it could be captured`);
	}
	let descriptor;
	try {
		if (process.platform !== 'win32') {
			descriptor = fs.openSync(
				reviewDirectory,
				fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NO_FOLLOW,
			);
			const opened = fs.fstatSync(descriptor, { bigint: true });
			if (!opened.isDirectory() || !sameIdentity(identity, opened)) {
				throw new Error(`review attestations directory changed while it was being opened`);
			}
			assertPrivateMode(opened, 'review attestations directory');
		}
		return { path: reviewDirectory, identity, descriptor };
	} catch (error) {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		throw error;
	}
}

function closeReviewDirectory(directory) {
	if (directory?.descriptor !== undefined) fs.closeSync(directory.descriptor);
}

function assertReviewDirectoryIdentity(directory) {
	if (directory.descriptor !== undefined) {
		const opened = fs.fstatSync(directory.descriptor, { bigint: true });
		if (!opened.isDirectory() || !sameIdentity(directory.identity, opened)) {
			throw new Error(`captured review attestations directory changed: ${directory.path}`);
		}
		assertPrivateMode(opened, 'review attestations directory');
	}
	const current = assertReviewDirectory(directory.path);
	if (!sameIdentity(directory.identity, current)) {
		throw new Error(`review attestations directory changed: ${directory.path}`);
	}
	return current;
}

function assertReviewDirectoryRevision(snapshot) {
	const current = assertReviewDirectoryIdentity(snapshot.directory);
	if (!sameRevision(snapshot.revision, current)) {
		throw new Error('review attestations directory changed after its coherent snapshot');
	}
	return current;
}

export function consentedReviewDirectory(bundleDirectory) {
	return path.join(bundleDirectory, CONSENTED_REVIEW_DIRECTORY_NAME);
}

function openConsentedReviewDirectory(bundleDirectory, options = {}) {
	const reviewDirectory = consentedReviewDirectory(bundleDirectory);
	const existing = fs.lstatSync(reviewDirectory, { bigint: true, throwIfNoEntry: false });
	if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
		throw new Error(`review attestations must be stored in a real directory: ${reviewDirectory}`);
	}
	if (!existing) fs.mkdirSync(reviewDirectory, { mode: 0o700 });
	const before = assertReviewDirectory(reviewDirectory);
	if (process.platform !== 'win32') {
		const descriptor = fs.openSync(
			reviewDirectory,
			fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NO_FOLLOW,
		);
		try {
			const opened = fs.fstatSync(descriptor, { bigint: true });
			if (!opened.isDirectory() || !sameIdentity(before, opened)) {
				throw new Error(`review attestations directory changed before securing it`);
			}
			fs.fchmodSync(descriptor, 0o700);
		} finally {
			fs.closeSync(descriptor);
		}
	}
	const after = assertReviewDirectory(reviewDirectory);
	if (!sameIdentity(before, after)) {
		throw new Error(`review attestations directory changed while securing it`);
	}
	options.beforeReviewDirectoryCapture?.({ reviewDirectory });
	return captureReviewDirectory(reviewDirectory, after);
}

export function createConsentedReviewDirectory(bundleDirectory) {
	const directory = openConsentedReviewDirectory(bundleDirectory);
	try {
		return directory.path;
	} finally {
		closeReviewDirectory(directory);
	}
}

function reviewLockLocation(bundleDirectory) {
	const absoluteBundle = path.resolve(bundleDirectory);
	const requestedGuardedDirectory = path.dirname(absoluteBundle);
	const requestedGuardedIdentity = fs.lstatSync(requestedGuardedDirectory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!requestedGuardedIdentity?.isDirectory() || requestedGuardedIdentity.isSymbolicLink()) {
		throw new Error(`review lock parent must be a real directory: ${requestedGuardedDirectory}`);
	}
	const guardedDirectory = fs.realpathSync(requestedGuardedDirectory);
	const guardedIdentity = fs.lstatSync(guardedDirectory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!guardedIdentity?.isDirectory() || guardedIdentity.isSymbolicLink()) {
		throw new Error(`review lock parent must be a real directory: ${guardedDirectory}`);
	}
	if (!sameIdentity(requestedGuardedIdentity, guardedIdentity)) {
		throw new Error(`review lock parent changed while resolving it: ${requestedGuardedDirectory}`);
	}
	const workspace = fs.realpathSync(path.dirname(guardedDirectory));
	const workspaceIdentity = fs.lstatSync(workspace, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!workspaceIdentity?.isDirectory() || workspaceIdentity.isSymbolicLink()) {
		throw new Error(`review lock workspace must be a real directory: ${workspace}`);
	}
	const canonicalBundle = path.join(guardedDirectory, path.basename(absoluteBundle));
	const digest = createHash('sha256').update(canonicalBundle).digest('hex');
	return {
		workspace,
		workspaceIdentity,
		guardedDirectory,
		guardedIdentity,
		lockName: `.review-${digest}.lock`,
	};
}

export function acquireConsentedReviewLock(bundleDirectory, timeoutMs = 30_000) {
	const location = reviewLockLocation(bundleDirectory);
	const lock = acquirePublicCorpusLock(location.workspace, timeoutMs, {
		lockName: location.lockName,
		activity: 'review attestation',
	});
	try {
		const currentWorkspace = fs.lstatSync(location.workspace, {
			bigint: true,
			throwIfNoEntry: false,
		});
		if (
			!currentWorkspace?.isDirectory() ||
			currentWorkspace.isSymbolicLink() ||
			!sameIdentity(location.workspaceIdentity, currentWorkspace)
		) {
			throw new Error(`review lock workspace changed during acquisition: ${location.workspace}`);
		}
		assertPublicCorpusLockOwned(lock);
		const currentGuarded = fs.lstatSync(location.guardedDirectory, {
			bigint: true,
			throwIfNoEntry: false,
		});
		if (
			!currentGuarded?.isDirectory() ||
			currentGuarded.isSymbolicLink() ||
			!sameIdentity(location.guardedIdentity, currentGuarded)
		) {
			throw new Error(
				`review lock parent changed during acquisition: ${location.guardedDirectory}`,
			);
		}
		return {
			...lock,
			guardedDirectory: location.guardedDirectory,
			guardedIdentity: location.guardedIdentity,
		};
	} catch (error) {
		const releaseError = lockReleaseError(
			lock,
			'review lock ownership changed while rolling back acquisition',
		);
		if (releaseError) {
			throw new AggregateError(
				[error, releaseError],
				`${error.message}; additionally, ${releaseError.message}`,
			);
		}
		throw error;
	}
}

export function assertConsentedReviewLockOwned(lock) {
	assertPublicCorpusLockOwned(lock);
	const guarded = fs.lstatSync(lock.guardedDirectory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (
		!guarded?.isDirectory() ||
		guarded.isSymbolicLink() ||
		!sameIdentity(lock.guardedIdentity, guarded)
	) {
		throw new Error(`review lock parent changed while the lock was held: ${lock.guardedDirectory}`);
	}
	return true;
}

function lockReleaseError(lock, message) {
	try {
		if (releasePublicCorpusLock(lock)) return null;
		return new Error(message);
	} catch (error) {
		return error;
	}
}

export function withConsentedReviewLock(
	bundleDirectory,
	timeoutMs,
	releaseFailureMessage,
	operation,
) {
	const lock = acquireConsentedReviewLock(bundleDirectory, timeoutMs);
	let result;
	let operationError;
	try {
		result = operation(lock);
	} catch (error) {
		operationError = error;
	}
	const releaseError = lockReleaseError(lock, releaseFailureMessage);
	if (operationError && releaseError) {
		throw new AggregateError(
			[operationError, releaseError],
			`${operationError.message}; additionally, ${releaseError.message}`,
		);
	}
	if (operationError) throw operationError;
	if (releaseError) throw releaseError;
	return result;
}

function openStableFile(filePath, label, { requirePrivate = false, maximumBytes } = {}) {
	const before = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
	if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
		throw new Error(`${label} must be a stable regular single-link file: ${filePath}`);
	}
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(filePath, { bigint: true });
		if (
			!opened.isFile() ||
			!named.isFile() ||
			named.isSymbolicLink() ||
			opened.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameIdentity(opened, named)
		) {
			throw new Error(`${label} must be a stable regular single-link file: ${filePath}`);
		}
		if (requirePrivate) {
			assertPrivateMode(opened, label);
			assertPrivateMode(named, label);
		}
		const size = Number(opened.size);
		if (
			!Number.isSafeInteger(size) ||
			size < 0 ||
			(maximumBytes !== undefined && size > maximumBytes)
		) {
			throw new Error(`${label} exceeds its safe read limit`);
		}
		return { descriptor, filePath, label, identity: opened, size, requirePrivate };
	} catch (error) {
		fs.closeSync(descriptor);
		throw error;
	}
}

function reattestStableFile(opened) {
	const current = fs.fstatSync(opened.descriptor, { bigint: true });
	const named = fs.lstatSync(opened.filePath, { bigint: true, throwIfNoEntry: false });
	if (
		!current.isFile() ||
		!named?.isFile() ||
		named.isSymbolicLink() ||
		current.nlink !== 1n ||
		named.nlink !== 1n ||
		!sameRevision(opened.identity, current) ||
		!sameRevision(current, named)
	) {
		throw new Error(`${opened.label} changed while it was being reviewed: ${opened.filePath}`);
	}
	if (opened.requirePrivate) {
		assertPrivateMode(current, opened.label);
		assertPrivateMode(named, opened.label);
	}
	return current;
}

function readDescriptor(opened) {
	const contents = Buffer.alloc(opened.size);
	let offset = 0;
	while (offset < contents.length) {
		const count = fs.readSync(
			opened.descriptor,
			contents,
			offset,
			contents.length - offset,
			offset,
		);
		if (count === 0) throw new Error(`${opened.label} ended while it was being read`);
		offset += count;
	}
	reattestStableFile(opened);
	return contents;
}

function hashDescriptor(opened) {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
	let offset = 0;
	while (offset < opened.size) {
		const count = fs.readSync(
			opened.descriptor,
			buffer,
			0,
			Math.min(buffer.length, opened.size - offset),
			offset,
		);
		if (count === 0) throw new Error(`${opened.label} ended while it was being hashed`);
		hash.update(buffer.subarray(0, count));
		offset += count;
	}
	reattestStableFile(opened);
	return hash.digest('hex');
}

function openReviewedInputs(audioPath, referencePath) {
	const audio = openStableFile(audioPath, 'reviewed audio');
	let reference;
	try {
		reference = openStableFile(referencePath, 'reviewed reference', {
			maximumBytes: MAX_REFERENCE_BYTES,
		});
		const referenceBytes = readDescriptor(reference);
		let referenceText;
		try {
			referenceText = new TextDecoder('utf-8', { fatal: true }).decode(referenceBytes);
		} catch {
			throw new Error('reviewed reference must be valid UTF-8');
		}
		if (referenceText.trim().length === 0) {
			throw new Error('reviewed reference must not be empty');
		}
		return {
			audio,
			reference,
			audioSha256: hashDescriptor(audio),
			referenceSha256: createHash('sha256').update(referenceBytes).digest('hex'),
		};
	} catch (error) {
		fs.closeSync(audio.descriptor);
		if (reference) fs.closeSync(reference.descriptor);
		throw error;
	}
}

function closeReviewedInputs(inputs) {
	fs.closeSync(inputs.audio.descriptor);
	fs.closeSync(inputs.reference.descriptor);
}

function reattestReviewedInputs(inputs) {
	reattestStableFile(inputs.audio);
	reattestStableFile(inputs.reference);
}

function validateReviewRecord(record, expected, filename, label) {
	if (!isObject(record)) throw new Error(`${label} must contain a JSON object`);
	for (const field of Object.keys(record)) {
		if (!REVIEW_FIELDS.has(field)) throw new Error(`${label}.${field} is not allowed`);
	}
	for (const field of REVIEW_FIELDS) {
		if (!Object.hasOwn(record, field)) throw new Error(`${label}.${field} is required`);
	}
	if (record.schema_version !== CONSENTED_REVIEW_SCHEMA_VERSION) {
		throw new Error(`${label}.schema_version is unsupported`);
	}
	assertReviewerId(record.reviewer_id);
	if (reviewerFilename(record.reviewer_id) !== filename) {
		throw new Error(`${label}.reviewer_id does not match its immutable filename`);
	}
	if (!isIsoTimestamp(record.reviewed_at)) {
		throw new Error(`${label}.reviewed_at must be an ISO-8601 timestamp`);
	}
	if (record.decision !== 'accepted') throw new Error(`${label}.decision must be accepted`);
	for (const [field, value] of Object.entries({
		session_id: expected.sessionId,
		sample_id: expected.sampleId,
		affirmed_reference_protocol_id: REFERENCE_PROTOCOL_ID,
	})) {
		if (record[field] !== value) throw new Error(`${label}.${field} does not match the bundle`);
	}
	for (const field of ['audio_sha256', 'reference_sha256']) {
		if (!SHA256_PATTERN.test(record[field] ?? '')) {
			throw new Error(`${label}.${field} must be a lowercase SHA-256 digest`);
		}
	}
	return record;
}

function readReviewRecord(reviewPath, expected) {
	const filename = path.basename(reviewPath);
	if (!/^[a-f0-9]{64}\.json$/.test(filename)) {
		throw new Error(`review attestation has an unsafe filename: ${reviewPath}`);
	}
	const opened = openStableFile(reviewPath, `review attestation '${filename}'`, {
		requirePrivate: true,
		maximumBytes: MAX_REVIEW_BYTES,
	});
	try {
		let record;
		try {
			record = JSON.parse(readDescriptor(opened).toString('utf8'));
		} catch (error) {
			throw new Error(`review attestation '${filename}' is invalid JSON: ${error.message}`);
		}
		return {
			path: reviewPath,
			identity: opened.identity,
			opened,
			record: validateReviewRecord(record, expected, filename, `review attestation '${filename}'`),
		};
	} catch (error) {
		fs.closeSync(opened.descriptor);
		throw error;
	}
}

function closeReviewRecords(records) {
	for (const record of records) fs.closeSync(record.opened.descriptor);
}

function reattestReviewRecords(records) {
	for (const record of records) reattestStableFile(record.opened);
}

function recoverReviewPublications(directory, options = {}) {
	let removed = false;
	assertReviewDirectoryIdentity(directory);
	const entries = fs.readdirSync(directory.path, { withFileTypes: true });
	assertReviewDirectoryIdentity(directory);
	for (const entry of entries) {
		const match = entry.name.match(REVIEW_PENDING_PATTERN);
		if (!match) continue;
		assertReviewDirectoryIdentity(directory);
		const pendingPath = path.join(directory.path, entry.name);
		const pending = fs.lstatSync(pendingPath, { bigint: true });
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			!pending.isFile() ||
			pending.isSymbolicLink() ||
			(pending.nlink !== 1n && pending.nlink !== 2n)
		) {
			throw new Error(`pending review publication is not recoverable: ${pendingPath}`);
		}
		assertPrivateMode(pending, 'pending review publication');
		let finalPath;
		let final;
		if (pending.nlink === 2n) {
			finalPath = path.join(directory.path, `${match[1]}.json`);
			final = fs.lstatSync(finalPath, { bigint: true, throwIfNoEntry: false });
			if (
				!final?.isFile() ||
				final.isSymbolicLink() ||
				final.nlink !== 2n ||
				!sameIdentity(pending, final)
			) {
				throw new Error(`pending review publication has an unexpected hard link: ${pendingPath}`);
			}
		}
		options.beforeReviewRecoveryMutation?.({
			reviewDirectory: directory.path,
			pendingPath,
			finalPath,
		});
		assertReviewDirectoryIdentity(directory);
		const currentPending = fs.lstatSync(pendingPath, { bigint: true, throwIfNoEntry: false });
		if (
			!currentPending?.isFile() ||
			currentPending.isSymbolicLink() ||
			!sameRevision(pending, currentPending)
		) {
			throw new Error(`pending review publication changed before recovery: ${pendingPath}`);
		}
		if (final) {
			const currentFinal = fs.lstatSync(finalPath, { bigint: true, throwIfNoEntry: false });
			if (
				!currentFinal?.isFile() ||
				currentFinal.isSymbolicLink() ||
				!sameRevision(final, currentFinal) ||
				!sameIdentity(currentPending, currentFinal)
			) {
				throw new Error(`published review attestation changed before recovery: ${finalPath}`);
			}
		}
		assertReviewDirectoryIdentity(directory);
		fs.unlinkSync(pendingPath);
		removed = true;
	}
	if (removed) fsyncReviewDirectory(directory);
}

function scanReviewRecords(directory, expected, options = {}) {
	recoverReviewPublications(directory, options);
	const directoryRevision = assertReviewDirectoryIdentity(directory);
	const records = [];
	try {
		const entries = fs
			.readdirSync(directory.path, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (!entry.isFile() || entry.isSymbolicLink()) {
				throw new Error(`review attestations directory contains a non-file entry: ${entry.name}`);
			}
			assertReviewDirectoryIdentity(directory);
			records.push(readReviewRecord(path.join(directory.path, entry.name), expected));
		}
		const after = assertReviewDirectoryIdentity(directory);
		if (!sameRevision(directoryRevision, after)) {
			throw new Error(`review attestations directory changed while it was being scanned`);
		}
		if (records.length > REQUIRED_CONSENTED_REVIEW_COUNT) {
			throw new Error(
				`review attestations must contain exactly ${REQUIRED_CONSENTED_REVIEW_COUNT} records`,
			);
		}
		const reviewerIds = new Set(records.map(({ record }) => record.reviewer_id));
		if (reviewerIds.size !== records.length) {
			throw new Error('review attestations must use distinct reviewer IDs');
		}
		return {
			directory,
			revision: after,
			entryNames: entries.map(({ name }) => name),
			records: records.sort((left, right) =>
				left.record.reviewer_id.localeCompare(right.record.reviewer_id),
			),
		};
	} catch (error) {
		closeReviewRecords(records);
		throw error;
	}
}

function reattestReviewSnapshot(snapshot) {
	reattestReviewRecords(snapshot.records);
	assertReviewDirectoryRevision(snapshot);
	const entryNames = fs.readdirSync(snapshot.directory.path).sort();
	assertReviewDirectoryRevision(snapshot);
	if (
		entryNames.length !== snapshot.entryNames.length ||
		entryNames.some((entryName, index) => entryName !== snapshot.entryNames[index])
	) {
		throw new Error('review attestations directory membership changed after its coherent snapshot');
	}
}

function fsyncReviewDirectory(directory) {
	assertReviewDirectoryIdentity(directory);
	if (process.platform === 'win32') return;
	fs.fsyncSync(directory.descriptor);
	assertReviewDirectoryIdentity(directory);
}

function unlinkIfSame(record, directory) {
	assertReviewDirectoryIdentity(directory);
	const named = fs.lstatSync(record.path, { bigint: true, throwIfNoEntry: false });
	if (!named) return false;
	if (
		!named.isFile() ||
		named.isSymbolicLink() ||
		named.nlink !== 1n ||
		!sameRevision(record.identity, named)
	) {
		throw new Error(`review attestation changed before cleanup: ${record.path}`);
	}
	assertReviewDirectoryIdentity(directory);
	fs.unlinkSync(record.path);
	return true;
}

function invalidateStaleReviews(records, hashes, directory) {
	const stale = records.filter(
		({ record }) =>
			record.audio_sha256 !== hashes.audioSha256 ||
			record.reference_sha256 !== hashes.referenceSha256,
	);
	if (stale.length === 0) return { records, invalidatedReviewCount: 0 };
	for (const record of records) unlinkIfSame(record, directory);
	fsyncReviewDirectory(directory);
	return { records: [], invalidatedReviewCount: records.length };
}

function writeReviewRecord(reviewPath, document, directory) {
	const contents = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
	if (contents.length > MAX_REVIEW_BYTES)
		throw new Error('review attestation is unexpectedly large');
	const reviewDirectory = directory.path;
	if (path.dirname(reviewPath) !== reviewDirectory) {
		throw new Error('review attestation must remain inside its captured directory');
	}
	const digest = path.basename(reviewPath, '.json');
	const pendingPath = path.join(reviewDirectory, `.pending-${digest}-${randomUUID()}.json`);
	let descriptor;
	let identity;
	let finalLinked = false;
	try {
		assertReviewDirectoryIdentity(directory);
		descriptor = fs.openSync(
			pendingPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
			0o600,
		);
		identity = fs.fstatSync(descriptor, { bigint: true });
		assertReviewDirectoryIdentity(directory);
		let offset = 0;
		while (offset < contents.length) {
			const written = fs.writeSync(descriptor, contents, offset, contents.length - offset, offset);
			if (written === 0) throw new Error('review attestation write made no progress');
			offset += written;
		}
		fs.fsyncSync(descriptor);
		const completed = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(pendingPath, { bigint: true });
		if (
			!completed.isFile() ||
			!named.isFile() ||
			named.isSymbolicLink() ||
			completed.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameIdentity(identity, completed) ||
			!sameIdentity(completed, named) ||
			completed.size !== BigInt(contents.length)
		) {
			throw new Error('review attestation changed while it was being written');
		}
		assertPrivateMode(completed, 'review attestation');
		fs.closeSync(descriptor);
		descriptor = undefined;
		assertReviewDirectoryIdentity(directory);
		fs.linkSync(pendingPath, reviewPath);
		finalLinked = true;
		assertReviewDirectoryIdentity(directory);
		const linkedPending = fs.lstatSync(pendingPath, { bigint: true });
		const linkedFinal = fs.lstatSync(reviewPath, { bigint: true });
		if (
			!linkedPending.isFile() ||
			!linkedFinal.isFile() ||
			linkedPending.isSymbolicLink() ||
			linkedFinal.isSymbolicLink() ||
			linkedPending.nlink !== 2n ||
			linkedFinal.nlink !== 2n ||
			!sameIdentity(completed, linkedPending) ||
			!sameIdentity(linkedPending, linkedFinal)
		) {
			throw new Error('review attestation changed during no-clobber publication');
		}
		assertReviewDirectoryIdentity(directory);
		fs.unlinkSync(pendingPath);
		assertReviewDirectoryIdentity(directory);
		const published = fs.lstatSync(reviewPath, { bigint: true });
		if (
			!published.isFile() ||
			published.isSymbolicLink() ||
			published.nlink !== 1n ||
			!sameIdentity(completed, published) ||
			published.size !== BigInt(contents.length)
		) {
			throw new Error('review attestation changed after no-clobber publication');
		}
		assertPrivateMode(published, 'review attestation');
		fsyncReviewDirectory(directory);
		return { path: reviewPath, identity: published };
	} catch (error) {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		descriptor = undefined;
		let cleanupError;
		try {
			assertReviewDirectoryIdentity(directory);
			if (finalLinked) {
				const final = fs.lstatSync(reviewPath, { bigint: true, throwIfNoEntry: false });
				if (final && identity && sameIdentity(identity, final)) {
					if (final.nlink > 2n) {
						throw new Error('published review attestation gained an unexpected hard link');
					}
					assertReviewDirectoryIdentity(directory);
					fs.unlinkSync(reviewPath);
				}
			}
			assertReviewDirectoryIdentity(directory);
			const pending = fs.lstatSync(pendingPath, { bigint: true, throwIfNoEntry: false });
			if (pending && identity && sameIdentity(identity, pending)) {
				if (pending.nlink > 2n) {
					throw new Error('pending review attestation gained an unexpected hard link');
				}
				assertReviewDirectoryIdentity(directory);
				fs.unlinkSync(pendingPath);
			}
			fsyncReviewDirectory(directory);
		} catch (cleanupFailure) {
			cleanupError = cleanupFailure;
		}
		if (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`${error.message}; additionally, review publication cleanup failed: ${cleanupError.message}`,
			);
		}
		throw error;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function reviewContext(options) {
	const bundleDirectory = path.resolve(options.bundleDirectory);
	const bundleIdentity = fs.lstatSync(bundleDirectory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!bundleIdentity?.isDirectory() || bundleIdentity.isSymbolicLink()) {
		throw new Error(`review bundle must be a real directory: ${bundleDirectory}`);
	}
	assertPrivateMode(bundleIdentity, 'review bundle');
	return {
		bundleDirectory,
		bundleIdentity,
		audioPath: path.resolve(options.audioPath),
		referencePath: path.resolve(options.referencePath),
		expected: {
			sessionId: options.sessionId,
			sampleId: options.sampleId,
		},
	};
}

function assertReviewBundle(context) {
	const current = fs.lstatSync(context.bundleDirectory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (
		!current?.isDirectory() ||
		current.isSymbolicLink() ||
		!sameIdentity(context.bundleIdentity, current)
	) {
		throw new Error(`review bundle changed while waiting for its lock: ${context.bundleDirectory}`);
	}
	assertPrivateMode(current, 'review bundle');
	return current;
}

export function recordConsentedReviewAttestation(options) {
	if (!options.acceptReviewedReference) {
		throw new Error('--accept-reviewed-reference is required');
	}
	if (options.affirmReferenceProtocol !== REFERENCE_PROTOCOL_ID) {
		throw new Error(`--affirm-reference-protocol must be '${REFERENCE_PROTOCOL_ID}'`);
	}
	const reviewerId = assertReviewerId(options.reviewerId);
	const context = reviewContext(options);
	const reviewDirectory = consentedReviewDirectory(context.bundleDirectory);
	return withConsentedReviewLock(
		context.bundleDirectory,
		options.lockTimeoutMs ?? 30_000,
		'review attestation lock ownership changed before release',
		(lock) => {
			let inputs;
			let directory;
			try {
				assertConsentedReviewLockOwned(lock);
				assertReviewBundle(context);
				directory = openConsentedReviewDirectory(context.bundleDirectory, options);
				inputs = openReviewedInputs(context.audioPath, context.referencePath);
				const snapshot = scanReviewRecords(directory, context.expected, options);
				let records = snapshot.records;
				try {
					reattestReviewSnapshot(snapshot);
				} finally {
					closeReviewRecords(records);
				}
				const invalidation = invalidateStaleReviews(records, inputs, directory);
				records = invalidation.records;
				if (records.some(({ record }) => record.reviewer_id === reviewerId)) {
					throw new Error(`reviewer '${reviewerId}' already attested this bundle`);
				}
				if (records.length >= REQUIRED_CONSENTED_REVIEW_COUNT) {
					throw new Error('this bundle already has two accepted reviews');
				}
				const reviewedAt = options.reviewedAt ?? new Date().toISOString();
				if (!isIsoTimestamp(reviewedAt)) {
					throw new Error('reviewed_at must be an ISO-8601 timestamp');
				}
				const document = {
					schema_version: CONSENTED_REVIEW_SCHEMA_VERSION,
					session_id: context.expected.sessionId,
					sample_id: context.expected.sampleId,
					reviewer_id: reviewerId,
					reviewed_at: reviewedAt,
					decision: 'accepted',
					affirmed_reference_protocol_id: REFERENCE_PROTOCOL_ID,
					audio_sha256: inputs.audioSha256,
					reference_sha256: inputs.referenceSha256,
				};
				options.beforeReviewWrite?.({
					audioPath: context.audioPath,
					referencePath: context.referencePath,
					reviewDirectory,
				});
				assertConsentedReviewLockOwned(lock);
				assertReviewBundle(context);
				assertReviewDirectoryIdentity(directory);
				const written = writeReviewRecord(
					path.join(reviewDirectory, reviewerFilename(reviewerId)),
					document,
					directory,
				);
				try {
					reattestReviewedInputs(inputs);
					assertConsentedReviewLockOwned(lock);
					fsyncReviewDirectory(directory);
					const currentSnapshot = scanReviewRecords(directory, context.expected, options);
					const current = currentSnapshot.records;
					try {
						const recorded = current.find(({ record }) => record.reviewer_id === reviewerId);
						if (
							!recorded ||
							recorded.record.audio_sha256 !== inputs.audioSha256 ||
							recorded.record.reference_sha256 !== inputs.referenceSha256
						) {
							throw new Error('review attestation failed content re-attestation');
						}
						options.beforePublishedReviewSnapshotReattest?.({
							reviewDirectory,
							reviewPaths: current.map(({ path: reviewPath }) => reviewPath),
						});
						reattestReviewedInputs(inputs);
						assertConsentedReviewLockOwned(lock);
						assertReviewBundle(context);
						reattestReviewSnapshot(currentSnapshot);
						return {
							reviewerId,
							reviewCount: current.length,
							invalidatedReviewCount: invalidation.invalidatedReviewCount,
							audioSha256: inputs.audioSha256,
							referenceSha256: inputs.referenceSha256,
						};
					} finally {
						closeReviewRecords(current);
					}
				} catch (error) {
					let cleanupError;
					try {
						unlinkIfSame(written, directory);
						fsyncReviewDirectory(directory);
					} catch (cleanupFailure) {
						cleanupError = cleanupFailure;
					}
					if (cleanupError) {
						throw new AggregateError(
							[error, cleanupError],
							`${error.message}; additionally, review rollback failed: ${cleanupError.message}`,
						);
					}
					throw error;
				}
			} finally {
				if (inputs) closeReviewedInputs(inputs);
				closeReviewDirectory(directory);
			}
		},
	);
}

export function assertConsentedReviewAttestations(options) {
	const context = reviewContext(options);
	const reviewDirectory = consentedReviewDirectory(context.bundleDirectory);
	return withConsentedReviewLock(
		context.bundleDirectory,
		options.lockTimeoutMs ?? 30_000,
		'review validation lock ownership changed before release',
		(lock) => {
			let inputs;
			let records;
			let directory;
			try {
				assertConsentedReviewLockOwned(lock);
				assertReviewBundle(context);
				assertReviewDirectory(reviewDirectory);
				directory = captureReviewDirectory(reviewDirectory);
				inputs = openReviewedInputs(context.audioPath, context.referencePath);
				const snapshot = scanReviewRecords(directory, context.expected, options);
				records = snapshot.records;
				for (const { record } of records) {
					if (
						record.audio_sha256 !== inputs.audioSha256 ||
						record.reference_sha256 !== inputs.referenceSha256
					) {
						throw new Error(
							`review by '${record.reviewer_id}' is stale because the audio or reference changed`,
						);
					}
				}
				if (records.length !== REQUIRED_CONSENTED_REVIEW_COUNT) {
					throw new Error(
						`intake requires exactly ${REQUIRED_CONSENTED_REVIEW_COUNT} current review attestations; found ${records.length}`,
					);
				}
				options.beforeReviewSnapshotReattest?.({
					reviewDirectory,
					reviewPaths: records.map(({ path: reviewPath }) => reviewPath),
				});
				reattestReviewedInputs(inputs);
				assertConsentedReviewLockOwned(lock);
				assertReviewBundle(context);
				reattestReviewSnapshot(snapshot);
				return {
					audioSha256: inputs.audioSha256,
					referenceSha256: inputs.referenceSha256,
					reviewerCount: records.length,
				};
			} finally {
				if (records) closeReviewRecords(records);
				if (inputs) closeReviewedInputs(inputs);
				closeReviewDirectory(directory);
			}
		},
	);
}
