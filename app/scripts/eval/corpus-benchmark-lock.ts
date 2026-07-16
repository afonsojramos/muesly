import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalManifestPath } from './corpus.ts';
import { processIdentity, processIsAlive, processOwnsState } from './process-identity.ts';

const OWNER_SCHEMA_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_OWNER_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_FIELDS = new Set([
	'schema_version',
	'pid',
	'process_identity',
	'token',
	'manifest_path',
	'created_at',
]);

function entryAt(filePath) {
	return fs.lstatSync(filePath, { throwIfNoEntry: false });
}

function ensurePrivateDirectory(directory, label) {
	const existing = entryAt(directory);
	if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
		throw new Error(`${label} must be a regular directory: ${directory}`);
	}
	if (!existing) {
		try {
			fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
		}
	}
	const installed = entryAt(directory);
	if (!installed?.isDirectory() || installed.isSymbolicLink()) {
		throw new Error(`${label} must be a regular directory: ${directory}`);
	}
	fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
}

function writePrivateOwner(ownerPath, owner) {
	fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
		flag: 'wx',
		mode: PRIVATE_FILE_MODE,
	});
	fs.chmodSync(ownerPath, PRIVATE_FILE_MODE);
}

function statusMetadata(status) {
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

function sameEntryMetadata(left, right) {
	return Object.keys(left).every((field) => left[field] === right[field]);
}

function readRegularFileNoFollow(filePath) {
	const entryBefore = fs.lstatSync(filePath, { bigint: true });
	if (!entryBefore.isFile() || entryBefore.isSymbolicLink()) {
		throw new Error(`benchmark lock owner must be a regular file: ${filePath}`);
	}
	if (entryBefore.nlink !== 1n) {
		throw new Error(`benchmark lock owner must not be hard linked: ${filePath}`);
	}
	if (process.platform !== 'win32' && Number(entryBefore.mode & 0o777n) !== PRIVATE_FILE_MODE) {
		throw new Error(`benchmark lock owner must have private 0600 permissions: ${filePath}`);
	}
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const openedBefore = fs.fstatSync(descriptor, { bigint: true });
		if (
			!openedBefore.isFile() ||
			openedBefore.nlink !== 1n ||
			!sameEntryMetadata(statusMetadata(entryBefore), statusMetadata(openedBefore))
		) {
			throw new Error(`benchmark lock owner changed while it was opened: ${filePath}`);
		}
		if (openedBefore.size > BigInt(MAX_OWNER_BYTES)) {
			throw new Error(`benchmark lock owner is too large: ${filePath}`);
		}
		const contents = fs.readFileSync(descriptor, 'utf8');
		const openedAfter = fs.fstatSync(descriptor, { bigint: true });
		const entryAfter = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
		if (
			!entryAfter?.isFile() ||
			entryAfter.isSymbolicLink() ||
			entryAfter.nlink !== 1n ||
			!sameEntryMetadata(statusMetadata(openedBefore), statusMetadata(openedAfter)) ||
			!sameEntryMetadata(statusMetadata(openedAfter), statusMetadata(entryAfter))
		) {
			throw new Error(`benchmark lock owner changed while it was read: ${filePath}`);
		}
		return {
			contents,
			metadata: statusMetadata(openedAfter),
		};
	} finally {
		fs.closeSync(descriptor);
	}
}

function isCanonicalTimestamp(value) {
	if (typeof value !== 'string') return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateOwner(owner, ownerPath) {
	if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
		throw new Error(`benchmark lock owner is invalid: ${ownerPath}`);
	}
	for (const field of Object.keys(owner)) {
		if (!OWNER_FIELDS.has(field)) {
			throw new Error(`benchmark lock owner has an unknown field '${field}': ${ownerPath}`);
		}
	}
	if (
		owner.schema_version !== OWNER_SCHEMA_VERSION ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid < 1 ||
		typeof owner.token !== 'string' ||
		!UUID_PATTERN.test(owner.token) ||
		typeof owner.manifest_path !== 'string' ||
		!path.isAbsolute(owner.manifest_path) ||
		!isCanonicalTimestamp(owner.created_at) ||
		(owner.process_identity !== undefined &&
			(typeof owner.process_identity !== 'string' || owner.process_identity.length === 0))
	) {
		throw new Error(`benchmark lock owner is invalid: ${ownerPath}`);
	}
	let canonicalOwnerManifest;
	try {
		canonicalOwnerManifest = canonicalManifestPath(owner.manifest_path, { allowMissing: true });
	} catch {
		throw new Error(`benchmark lock owner manifest path is invalid: ${ownerPath}`);
	}
	if (canonicalOwnerManifest !== owner.manifest_path) {
		throw new Error(`benchmark lock owner manifest path is not canonical: ${ownerPath}`);
	}
	return owner;
}

function readBenchmarkLockOwnerSnapshot(lockPath) {
	const lockEntry = fs.lstatSync(lockPath);
	if (!lockEntry.isDirectory() || lockEntry.isSymbolicLink()) {
		throw new Error(`benchmark lock must be a regular directory: ${lockPath}`);
	}
	const ownerPath = path.join(lockPath, 'owner.json');
	const snapshot = readRegularFileNoFollow(ownerPath);
	let owner;
	try {
		owner = JSON.parse(snapshot.contents);
	} catch {
		throw new Error(`benchmark lock owner is not valid JSON: ${ownerPath}`);
	}
	return {
		metadata: snapshot.metadata,
		owner: validateOwner(owner, ownerPath),
	};
}

function readBenchmarkLockOwner(lockPath) {
	return readBenchmarkLockOwnerSnapshot(lockPath).owner;
}

function sameOwner(left, right) {
	return (
		left.pid === right.pid &&
		left.process_identity === right.process_identity &&
		left.token === right.token &&
		left.manifest_path === right.manifest_path &&
		left.created_at === right.created_at
	);
}

function stableEntryMetadata(filePath, expectedType) {
	const status = fs.lstatSync(filePath, { bigint: true });
	const validType =
		expectedType === 'directory'
			? status.isDirectory() && !status.isSymbolicLink()
			: status.isFile() && !status.isSymbolicLink();
	if (!validType) {
		throw new Error(`benchmark lock ${expectedType} identity is invalid: ${filePath}`);
	}
	return statusMetadata(status);
}

function readBenchmarkLockState(lockPath) {
	const lockBefore = stableEntryMetadata(lockPath, 'directory');
	const snapshot = readBenchmarkLockOwnerSnapshot(lockPath);
	const lockAfter = stableEntryMetadata(lockPath, 'directory');
	if (!sameEntryMetadata(lockBefore, lockAfter)) {
		throw new Error(`benchmark lock changed while ownership was inspected: ${lockPath}`);
	}
	return {
		owner: snapshot.owner,
		lockIdentity: {
			lock: lockAfter,
			owner: snapshot.metadata,
		},
	};
}

function currentProcessIdentity(options) {
	if (Object.hasOwn(options, 'currentIdentity')) {
		const identity = options.currentIdentity;
		if (identity !== null && (typeof identity !== 'string' || identity.length === 0)) {
			throw new Error('current benchmark process identity must be null or a non-empty string');
		}
		return identity;
	}
	return processIdentity(process.pid);
}

/**
 * Verifies that the exact current process still owns the benchmark lock.
 *
 * Unlike assertCorpusBenchmarkAccess(), possession of a token is not enough:
 * the owner PID and recorded process identity must also match this process.
 * The returned filesystem identity lets long-lived in-process leases reject a
 * released and recreated lock even if its owner document was copied verbatim.
 */
export function assertOwnedCorpusBenchmarkLock(manifestPath, token, options = {}) {
	const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
	const lockPath = path.join(path.dirname(canonicalManifest), 'local-corpus', '.benchmark.lock');
	if (typeof token !== 'string' || !UUID_PATTERN.test(token)) {
		throw new Error('the current process does not own the corpus benchmark lock');
	}
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!entryAt(lockPath)) {
			throw new Error('the owned corpus benchmark lock is no longer available');
		}
		let state;
		try {
			state = readBenchmarkLockState(lockPath);
		} catch (error) {
			if (!entryAt(lockPath)) continue;
			throw new Error(
				`the owned corpus benchmark lock is invalid or unreadable: ${lockPath}; ${error.message}`,
			);
		}
		const { owner } = state;
		if (owner.manifest_path !== canonicalManifest) {
			throw new Error(`the corpus benchmark lock is bound to another manifest: ${lockPath}`);
		}
		const identity = currentProcessIdentity(options);
		if (
			owner.pid !== process.pid ||
			owner.token !== token ||
			typeof owner.process_identity !== 'string' ||
			identity === null ||
			owner.process_identity !== identity
		) {
			throw new Error('the current process does not own the corpus benchmark lock');
		}
		return {
			lockPath,
			manifestPath: canonicalManifest,
			token,
			pid: owner.pid,
			processIdentity: owner.process_identity ?? null,
			createdAt: owner.created_at,
			lockIdentity: state.lockIdentity,
		};
	}
	throw new Error(`could not verify owned corpus benchmark access: ${lockPath}`);
}

function prepareBenchmarkLock(localCorpusRoot, canonicalManifest, options) {
	const token = randomUUID();
	const pendingPath = path.join(localCorpusRoot, `.benchmark.lock.pending-${token}`);
	const identity = currentProcessIdentity(options);
	fs.mkdirSync(pendingPath, { mode: PRIVATE_DIRECTORY_MODE });
	try {
		writePrivateOwner(path.join(pendingPath, 'owner.json'), {
			schema_version: OWNER_SCHEMA_VERSION,
			pid: process.pid,
			...(identity ? { process_identity: identity } : {}),
			token,
			manifest_path: canonicalManifest,
			created_at: new Date().toISOString(),
		});
		return { identity, pendingPath, token };
	} catch (error) {
		fs.rmSync(pendingPath, { recursive: true, force: true });
		throw error;
	}
}

function restoreDisplacedLock(stalePath, lockPath) {
	if (!entryAt(stalePath) || entryAt(lockPath)) return;
	try {
		fs.renameSync(stalePath, lockPath);
	} catch {
		// Preserve the displaced lock as evidence when another contender installed first.
	}
}

function preserveStaleLock(lockPath, observedOwner) {
	const stalePath = `${lockPath}.stale-${observedOwner.token}-${randomUUID()}`;
	fs.renameSync(lockPath, stalePath);
	let movedOwner;
	try {
		movedOwner = readBenchmarkLockOwner(stalePath);
	} catch (error) {
		restoreDisplacedLock(stalePath, lockPath);
		throw error;
	}
	if (!sameOwner(observedOwner, movedOwner)) {
		restoreDisplacedLock(stalePath, lockPath);
		throw new Error(`benchmark lock changed while reclaiming stale ownership: ${lockPath}`);
	}
	fs.chmodSync(stalePath, PRIVATE_DIRECTORY_MODE);
	fs.chmodSync(path.join(stalePath, 'owner.json'), PRIVATE_FILE_MODE);
	return stalePath;
}

function contentionAfterRename(error, lockPath) {
	if (entryAt(lockPath)) return true;
	return ['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code);
}

function benchmarkOwnerIsCurrent(owner, lockPath, options = {}) {
	const isAlive = options.isAlive ?? processIsAlive;
	const identityForPid = options.identityForPid ?? processIdentity;
	try {
		return processOwnsState(owner, { isAlive, identityForPid });
	} catch {
		throw new Error(
			`a corpus benchmark may still be active; ownership could not be verified: ${lockPath}`,
		);
	}
}

export function acquireCorpusBenchmarkLock(manifestPath, options = {}) {
	const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
	const localCorpusRoot = path.join(path.dirname(canonicalManifest), 'local-corpus');
	ensurePrivateDirectory(localCorpusRoot, 'local corpus root');
	const lockPath = path.join(localCorpusRoot, '.benchmark.lock');
	const prepared = prepareBenchmarkLock(localCorpusRoot, canonicalManifest, options);
	try {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (!entryAt(lockPath)) {
				let installed = false;
				try {
					fs.renameSync(prepared.pendingPath, lockPath);
					installed = true;
				} catch (error) {
					if (!contentionAfterRename(error, lockPath)) throw error;
				}
				if (installed) {
					try {
						fs.chmodSync(lockPath, PRIVATE_DIRECTORY_MODE);
						fs.chmodSync(path.join(lockPath, 'owner.json'), PRIVATE_FILE_MODE);
						const installedOwner = readBenchmarkLockOwner(lockPath);
						if (
							installedOwner.pid !== process.pid ||
							installedOwner.token !== prepared.token ||
							installedOwner.process_identity !== (prepared.identity ?? undefined) ||
							installedOwner.manifest_path !== canonicalManifest
						) {
							throw new Error(`benchmark lock changed during acquisition: ${lockPath}`);
						}
						return {
							lockPath,
							token: prepared.token,
							processIdentity: prepared.identity,
							manifestPath: canonicalManifest,
						};
					} catch (error) {
						releaseCorpusBenchmarkLock(lockPath, prepared.token, {
							currentIdentity: prepared.identity,
						});
						throw error;
					}
				}
			}

			let observedOwner;
			try {
				observedOwner = readBenchmarkLockOwner(lockPath);
			} catch (error) {
				if (!entryAt(lockPath)) continue;
				throw new Error(
					`another corpus benchmark is active or left an invalid or unreadable lock: ${lockPath}; ${error.message}`,
				);
			}
			if (observedOwner.manifest_path !== canonicalManifest) {
				throw new Error(
					`benchmark lock is bound to another manifest: ${observedOwner.manifest_path}`,
				);
			}
			let stillOwned;
			try {
				stillOwned = benchmarkOwnerIsCurrent(observedOwner, lockPath, options);
			} catch {
				throw new Error(
					`another corpus benchmark may still be active; ownership could not be verified: ${lockPath}`,
				);
			}
			if (stillOwned) {
				throw new Error(`another corpus benchmark is active: ${lockPath}`);
			}
			try {
				preserveStaleLock(lockPath, observedOwner);
			} catch (error) {
				if (!entryAt(lockPath) && error.code === 'ENOENT') continue;
				throw new Error(`failed to preserve stale benchmark lock: ${lockPath}; ${error.message}`);
			}
		}
		throw new Error(`could not acquire corpus benchmark lock: ${lockPath}`);
	} catch (error) {
		fs.rmSync(prepared.pendingPath, { recursive: true, force: true });
		throw error;
	}
}

function releaseMatches(owner, token, identity) {
	if (owner.pid !== process.pid || owner.token !== token) return false;
	if (owner.process_identity === undefined) return true;
	return identity !== null && owner.process_identity === identity;
}

export function assertCorpusBenchmarkAccess(manifestPath, token = null, options = {}) {
	const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
	const lockPath = path.join(path.dirname(canonicalManifest), 'local-corpus', '.benchmark.lock');
	const hasToken = token !== null && token !== undefined;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const lockEntry = entryAt(lockPath);
		if (!lockEntry) {
			if (hasToken) {
				throw new Error('the owned corpus benchmark lock is no longer available');
			}
			return;
		}
		let owner;
		try {
			owner = readBenchmarkLockOwner(lockPath);
		} catch (error) {
			if (!entryAt(lockPath)) continue;
			throw new Error(
				`a corpus benchmark is active or left an invalid or unreadable lock: ${lockPath}; ${error.message}`,
			);
		}
		if (owner.manifest_path !== canonicalManifest) {
			throw new Error(`the corpus benchmark lock is bound to another manifest: ${lockPath}`);
		}
		const stillOwned = benchmarkOwnerIsCurrent(owner, lockPath, options);
		if (stillOwned) {
			if (hasToken && owner.token === token) return;
			throw new Error(`a corpus benchmark is active: ${lockPath}`);
		}
		try {
			preserveStaleLock(lockPath, owner);
		} catch (error) {
			if (!entryAt(lockPath) && error.code === 'ENOENT') continue;
			throw new Error(`failed to preserve stale benchmark lock: ${lockPath}; ${error.message}`);
		}
		if (hasToken) {
			throw new Error('the owned corpus benchmark lock is no longer available');
		}
		return;
	}
	throw new Error(`could not verify corpus benchmark access: ${lockPath}`);
}

export function releaseCorpusBenchmarkLock(lockPath, token, options = {}) {
	let identity;
	try {
		identity = currentProcessIdentity(options);
	} catch {
		return false;
	}
	let owner;
	try {
		owner = readBenchmarkLockOwner(lockPath);
	} catch {
		return false;
	}
	if (!releaseMatches(owner, token, identity)) return false;

	const releasePath = `${lockPath}.release-${token}-${randomUUID()}`;
	try {
		fs.renameSync(lockPath, releasePath);
	} catch {
		return false;
	}
	try {
		const movedOwner = readBenchmarkLockOwner(releasePath);
		if (!sameOwner(owner, movedOwner) || !releaseMatches(movedOwner, token, identity)) {
			restoreDisplacedLock(releasePath, lockPath);
			return false;
		}
		fs.rmSync(releasePath, { recursive: true, force: true });
		return true;
	} catch {
		restoreDisplacedLock(releasePath, lockPath);
		return false;
	}
}
