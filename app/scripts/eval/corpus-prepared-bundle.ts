import fs from 'node:fs';
import path from 'node:path';

import {
	assertConsentedReviewAttestations,
	assertConsentedReviewLockOwned,
	consentedReviewDirectory,
	withConsentedReviewLock,
} from './corpus-review.ts';
import { canonicalFilePath, canonicalManifestPath, REFERENCE_PROTOCOL_ID } from './corpus.ts';

const CURRENT_PREPARED_SCHEMA_VERSION = 3;
const MAX_PREPARED_METADATA_BYTES = 64 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const SESSION_ID_PATTERN = /^session-[a-z0-9][a-z0-9-]*$/;

class PreparedBundleMismatchError extends Error {}

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

function assertPreparedSessionId(sessionId) {
	if (!SESSION_ID_PATTERN.test(sessionId ?? '')) {
		throw new Error('prepared session ID must be an opaque session-* identifier');
	}
	return sessionId;
}

function preparedBundleDirectory(manifestPath, sessionId) {
	assertPreparedSessionId(sessionId);
	return path.join(path.dirname(manifestPath), 'intake', sessionId);
}

function retiredBundleDirectory(manifestPath, sessionId) {
	assertPreparedSessionId(sessionId);
	return path.join(path.dirname(manifestPath), 'intake', `.retired-${sessionId}`);
}

function regularBundleAt(bundleDirectory, label) {
	const bundleEntry = fs.lstatSync(bundleDirectory, { bigint: true, throwIfNoEntry: false });
	if (!bundleEntry) return null;
	if (!bundleEntry.isDirectory() || bundleEntry.isSymbolicLink()) {
		throw new Error(`${label} must be a regular directory: ${bundleDirectory}`);
	}
	assertPrivateMode(bundleEntry, label);
	return { bundleDirectory, bundleIdentity: bundleEntry };
}

function regularPreparedBundle(manifestPath, sessionId, { retired = false } = {}) {
	const intakeRoot = path.join(path.dirname(manifestPath), 'intake');
	const rootEntry = fs.lstatSync(intakeRoot, { bigint: true, throwIfNoEntry: false });
	if (!rootEntry) return null;
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`prepared intake root must be a regular directory: ${intakeRoot}`);
	}
	const bundleDirectory = retired
		? retiredBundleDirectory(manifestPath, sessionId)
		: preparedBundleDirectory(manifestPath, sessionId);
	return regularBundleAt(
		bundleDirectory,
		retired ? 'retired prepared intake bundle' : 'prepared intake bundle',
	);
}

function readPreparedMetadata(bundleDirectory) {
	const metadataPath = path.join(bundleDirectory, 'collection-session.json');
	const descriptor = fs.openSync(metadataPath, fs.constants.O_RDONLY | NO_FOLLOW);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(metadataPath, { bigint: true });
		if (
			!opened.isFile() ||
			!named.isFile() ||
			named.isSymbolicLink() ||
			opened.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameIdentity(opened, named)
		) {
			throw new Error(
				`prepared intake metadata must be a stable single-link file: ${metadataPath}`,
			);
		}
		assertPrivateMode(opened, 'prepared intake metadata');
		const size = Number(opened.size);
		if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PREPARED_METADATA_BYTES) {
			throw new Error(`prepared intake metadata exceeds its safe read limit: ${metadataPath}`);
		}
		const contents = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const count = fs.readSync(descriptor, contents, offset, size - offset, offset);
			if (count === 0)
				throw new Error(`prepared intake metadata changed while reading: ${metadataPath}`);
			offset += count;
		}
		let metadata;
		try {
			metadata = JSON.parse(contents.toString('utf8'));
		} catch (error) {
			throw new Error(`failed to read prepared intake metadata ${metadataPath}: ${error.message}`);
		}
		const completed = fs.fstatSync(descriptor, { bigint: true });
		const current = fs.lstatSync(metadataPath, { bigint: true, throwIfNoEntry: false });
		if (!current || !sameRevision(opened, completed) || !sameRevision(completed, current)) {
			throw new Error(`prepared intake metadata changed while reading: ${metadataPath}`);
		}
		return metadata;
	} finally {
		fs.closeSync(descriptor);
	}
}

function matchingPreparedBundle(
	manifestPath,
	sessionId,
	{ allowLegacyWithdrawal = false, retired = false } = {},
) {
	const prepared = regularPreparedBundle(manifestPath, sessionId, { retired });
	if (!prepared) return null;
	let metadata;
	try {
		metadata = readPreparedMetadata(prepared.bundleDirectory);
	} catch (error) {
		if (!retired || fs.existsSync(path.join(prepared.bundleDirectory, 'collection-session.json'))) {
			throw error;
		}
		return {
			...prepared,
			activeBundleDirectory: preparedBundleDirectory(manifestPath, sessionId),
			metadata: null,
			retired: true,
		};
	}
	const currentBundle = fs.lstatSync(prepared.bundleDirectory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (
		!currentBundle?.isDirectory() ||
		currentBundle.isSymbolicLink() ||
		!sameIdentity(prepared.bundleIdentity, currentBundle)
	) {
		throw new Error(`prepared intake bundle changed while reading: ${prepared.bundleDirectory}`);
	}
	assertPrivateMode(currentBundle, 'prepared intake bundle');
	const allowedSchemas = allowLegacyWithdrawal ? new Set([1, 2, 3]) : new Set([3]);
	if (!allowedSchemas.has(metadata.schemaVersion)) {
		throw new Error(
			`prepared intake metadata has an unsupported schema: ${prepared.bundleDirectory}`,
		);
	}
	if (metadata.schemaVersion !== 1 && metadata.referenceProtocolId !== REFERENCE_PROTOCOL_ID) {
		throw new Error(
			`prepared intake metadata has an unsupported reference protocol: ${prepared.bundleDirectory}`,
		);
	}
	if (metadata.sessionId !== sessionId) {
		throw new PreparedBundleMismatchError(
			`prepared intake metadata does not match sessionId: ${prepared.bundleDirectory}`,
		);
	}
	if (
		typeof metadata.manifestPath !== 'string' ||
		canonicalManifestPath(metadata.manifestPath, { allowMissing: true }) !== manifestPath
	) {
		throw new PreparedBundleMismatchError(
			`prepared intake metadata does not match manifestPath: ${prepared.bundleDirectory}`,
		);
	}
	return {
		...prepared,
		activeBundleDirectory: preparedBundleDirectory(manifestPath, sessionId),
		metadata,
		retired,
	};
}

function expectedBundlePaths(bundleDirectory) {
	return {
		audioPath: path.join(bundleDirectory, 'recording.wav'),
		referencePath: path.join(bundleDirectory, 'reference.txt'),
		reviewAttestationsPath: consentedReviewDirectory(bundleDirectory),
	};
}

function canonicalDirectory(directory) {
	const status = fs.lstatSync(directory, { throwIfNoEntry: false });
	if (!status?.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`prepared review path must be a regular directory: ${directory}`);
	}
	return fs.realpathSync(directory);
}

function canonicalLeafPath(filePath) {
	const absolutePath = path.resolve(filePath);
	return path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
}

function assertPreparedSingleLinkFile(filePath, label) {
	const status = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
	if (!status?.isFile() || status.isSymbolicLink() || status.nlink !== 1n) {
		throw new Error(`${label} must be a regular single-link file: ${filePath}`);
	}
	return canonicalLeafPath(filePath);
}

function validatePreparedPaths(prepared) {
	const paths = expectedBundlePaths(prepared.bundleDirectory);
	const expected = {
		audioPath: assertPreparedSingleLinkFile(paths.audioPath, 'prepared audio'),
		referencePath: assertPreparedSingleLinkFile(paths.referencePath, 'prepared reference'),
		reviewAttestationsPath: canonicalDirectory(paths.reviewAttestationsPath),
	};
	for (const [field, value] of Object.entries(expected)) {
		if (typeof prepared.metadata[field] !== 'string') {
			throw new Error(`prepared intake metadata is missing ${field}: ${prepared.bundleDirectory}`);
		}
		const actual =
			field === 'reviewAttestationsPath'
				? canonicalDirectory(prepared.metadata[field])
				: canonicalLeafPath(prepared.metadata[field]);
		if (actual !== value) {
			throw new Error(
				`prepared intake metadata does not match ${field}: ${prepared.bundleDirectory}`,
			);
		}
	}
	return { ...paths, ...expected };
}

export function preparedBundleForReview({ manifestPath, sessionId }) {
	const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
	const prepared = matchingPreparedBundle(canonicalManifest, sessionId);
	if (!prepared) {
		throw new Error(`no prepared intake bundle exists for '${sessionId}'`);
	}
	const paths = validatePreparedPaths(prepared);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(prepared.metadata.sampleId ?? '')) {
		throw new Error(
			`prepared intake metadata has an invalid sampleId: ${prepared.bundleDirectory}`,
		);
	}
	return { ...prepared, ...paths, manifestPath: canonicalManifest };
}

export function preparedBundleForIntake({
	manifestPath,
	audioSource,
	referenceSource,
	consentRecord,
	options,
}) {
	const prepared = preparedBundleForReview({ manifestPath, sessionId: options.sessionId });
	const canonicalAudioSource = canonicalFilePath(audioSource);
	const canonicalReferenceSource = canonicalFilePath(referenceSource);
	const canonicalConsentRecord = canonicalFilePath(consentRecord);
	if (
		canonicalAudioSource !== prepared.audioPath ||
		canonicalReferenceSource !== prepared.referencePath
	) {
		throw new Error(
			'intake must use the recording and reference from its generated prepared bundle',
		);
	}

	const expected = {
		schemaVersion: CURRENT_PREPARED_SCHEMA_VERSION,
		referenceProtocolId: options.referenceProtocolId,
		sessionId: options.sessionId,
		consentRecordId: options.consentRecordId,
		sampleId: options.sampleId,
		language: options.language,
		noiseCondition: options.noiseCondition,
		manifestPath: prepared.manifestPath,
		audioPath: canonicalAudioSource,
		referencePath: canonicalReferenceSource,
		consentRecordPath: canonicalConsentRecord,
		reviewAttestationsPath: prepared.reviewAttestationsPath,
	};
	for (const [field, value] of Object.entries(expected)) {
		let actual = prepared.metadata[field];
		if (typeof actual === 'string') {
			if (field === 'manifestPath') {
				actual = canonicalManifestPath(actual, { allowMissing: true });
			} else if (field === 'reviewAttestationsPath') {
				actual = canonicalDirectory(actual);
			} else if (['audioPath', 'referencePath', 'consentRecordPath'].includes(field)) {
				actual = canonicalFilePath(actual);
			}
		}
		if (actual !== value) {
			throw new Error(
				`prepared intake metadata does not match ${field}: ${prepared.bundleDirectory}`,
			);
		}
	}
	const reviews = assertConsentedReviewAttestations({
		bundleDirectory: prepared.bundleDirectory,
		audioPath: prepared.audioPath,
		referencePath: prepared.referencePath,
		sessionId: prepared.metadata.sessionId,
		sampleId: prepared.metadata.sampleId,
	});
	return { ...prepared, ...reviews };
}

function assertExactDirectoryIdentity(directory, identity, label) {
	const current = fs.lstatSync(directory, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(identity, current)) {
		throw new Error(`${label} changed before retirement: ${directory}`);
	}
	assertPrivateMode(current, label);
	return current;
}

function assertExactBundleIdentity(preparedBundle, label) {
	return assertExactDirectoryIdentity(
		preparedBundle.bundleDirectory,
		preparedBundle.bundleIdentity,
		label,
	);
}

export function retirePreparedBundle(preparedBundle, options = {}) {
	if (!preparedBundle) return false;
	if (
		typeof preparedBundle !== 'object' ||
		typeof preparedBundle.bundleDirectory !== 'string' ||
		!preparedBundle.bundleIdentity
	) {
		throw new Error('prepared bundle retirement requires its validated directory identity');
	}
	const activeBundleDirectory =
		preparedBundle.activeBundleDirectory ?? preparedBundle.bundleDirectory;
	return withConsentedReviewLock(
		activeBundleDirectory,
		options.lockTimeoutMs ?? 30_000,
		'prepared bundle retirement lock ownership changed before release',
		(lock) => {
			assertConsentedReviewLockOwned(lock);
			options.beforeRetireClaim?.({
				bundleDirectory: preparedBundle.bundleDirectory,
				activeBundleDirectory,
			});
			const exact = assertExactBundleIdentity(
				preparedBundle,
				preparedBundle.retired ? 'retired prepared intake bundle' : 'prepared intake bundle',
			);
			if (preparedBundle.retired) {
				options.beforeRetiredBundleDelete?.({
					claimDirectory: preparedBundle.bundleDirectory,
				});
				assertExactDirectoryIdentity(
					preparedBundle.bundleDirectory,
					exact,
					'retired prepared intake bundle',
				);
				assertConsentedReviewLockOwned(lock);
				assertExactDirectoryIdentity(
					preparedBundle.bundleDirectory,
					exact,
					'retired prepared intake bundle',
				);
				fs.rmSync(preparedBundle.bundleDirectory, {
					recursive: true,
					maxRetries: 3,
					retryDelay: 25,
				});
				assertConsentedReviewLockOwned(lock);
				return true;
			}
			const claimDirectory = path.join(
				path.dirname(activeBundleDirectory),
				`.retired-${path.basename(activeBundleDirectory)}`,
			);
			if (fs.lstatSync(claimDirectory, { throwIfNoEntry: false })) {
				throw new Error(`prepared bundle retirement claim already exists: ${claimDirectory}`);
			}
			assertConsentedReviewLockOwned(lock);
			fs.renameSync(preparedBundle.bundleDirectory, claimDirectory);
			const claimed = fs.lstatSync(claimDirectory, { bigint: true, throwIfNoEntry: false });
			if (!claimed?.isDirectory() || claimed.isSymbolicLink() || !sameIdentity(exact, claimed)) {
				throw new Error(`prepared bundle retirement claim changed: ${claimDirectory}`);
			}
			assertPrivateMode(claimed, 'retired prepared intake bundle');
			options.beforeRetiredBundleDelete?.({ claimDirectory });
			assertExactDirectoryIdentity(claimDirectory, claimed, 'retired prepared intake bundle claim');
			assertConsentedReviewLockOwned(lock);
			assertExactDirectoryIdentity(claimDirectory, claimed, 'retired prepared intake bundle claim');
			fs.rmSync(claimDirectory, { recursive: true, maxRetries: 3, retryDelay: 25 });
			assertConsentedReviewLockOwned(lock);
			return true;
		},
	);
}

export function preparedBundleForWithdrawal(manifestPath, sessionId) {
	const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
	const prepared = matchingPreparedBundle(canonicalManifest, sessionId, {
		allowLegacyWithdrawal: true,
	});
	const retired = matchingPreparedBundle(canonicalManifest, sessionId, {
		allowLegacyWithdrawal: true,
		retired: true,
	});
	if (prepared && retired) {
		throw new Error(`both active and retired prepared bundles exist for '${sessionId}'`);
	}
	return prepared ?? retired;
}

export function retirePreparedBundleForWithdrawal(manifestPath, sessionId) {
	return retirePreparedBundle(preparedBundleForWithdrawal(manifestPath, sessionId));
}

export function preparedBundleIfMatching(manifestPath, sessionId) {
	try {
		return preparedBundleForWithdrawal(manifestPath, sessionId);
	} catch (error) {
		if (error instanceof PreparedBundleMismatchError) return null;
		throw error;
	}
}

export function retirePreparedBundleIfMatching(manifestPath, sessionId) {
	return retirePreparedBundle(preparedBundleIfMatching(manifestPath, sessionId));
}
