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

function readRegularFileNoFollow(filePath) {
	const entry = fs.lstatSync(filePath);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`benchmark lock owner must be a regular file: ${filePath}`);
	}
	const noFollow = fs.constants.O_NOFOLLOW ?? 0;
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const status = fs.fstatSync(descriptor);
		if (!status.isFile()) {
			throw new Error(`benchmark lock owner must be a regular file: ${filePath}`);
		}
		if (status.size > MAX_OWNER_BYTES) {
			throw new Error(`benchmark lock owner is too large: ${filePath}`);
		}
		return fs.readFileSync(descriptor, 'utf8');
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

function readBenchmarkLockOwner(lockPath) {
	const lockEntry = fs.lstatSync(lockPath);
	if (!lockEntry.isDirectory() || lockEntry.isSymbolicLink()) {
		throw new Error(`benchmark lock must be a regular directory: ${lockPath}`);
	}
	const ownerPath = path.join(lockPath, 'owner.json');
	const contents = readRegularFileNoFollow(ownerPath);
	let owner;
	try {
		owner = JSON.parse(contents);
	} catch {
		throw new Error(`benchmark lock owner is not valid JSON: ${ownerPath}`);
	}
	return validateOwner(owner, ownerPath);
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

export function acquireCorpusBenchmarkLock(manifestPath, options = {}) {
	const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
	const localCorpusRoot = path.join(path.dirname(canonicalManifest), 'local-corpus');
	ensurePrivateDirectory(localCorpusRoot, 'local corpus root');
	const lockPath = path.join(localCorpusRoot, '.benchmark.lock');
	const prepared = prepareBenchmarkLock(localCorpusRoot, canonicalManifest, options);
	const isAlive = options.isAlive ?? processIsAlive;
	const identityForPid = options.identityForPid ?? processIdentity;
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
				stillOwned = processOwnsState(observedOwner, { isAlive, identityForPid });
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
