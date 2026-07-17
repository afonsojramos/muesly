import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { processIdentity, processOwnsState } from './process-identity.ts';

function waitForLock(milliseconds) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sameFileIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameLockOwner(left, right) {
	return (
		left.pid === right.pid &&
		left.token === right.token &&
		(left.process_identity ?? null) === (right.process_identity ?? null)
	);
}

function lockIdentity(lockPath) {
	const status = fs.lstatSync(lockPath, { bigint: true });
	if (!status.isDirectory() || status.isSymbolicLink()) {
		throw new Error(`public corpus lock must be a real directory: ${lockPath}`);
	}
	return status;
}

function readLockOwner(lockPath) {
	const directoryBefore = lockIdentity(lockPath);
	const ownerPath = path.join(lockPath, 'owner.json');
	const descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(ownerPath, { bigint: true });
		if (
			!opened.isFile() ||
			!named.isFile() ||
			named.isSymbolicLink() ||
			opened.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameFileIdentity(opened, named)
		) {
			throw new Error(`public corpus lock owner must be a stable single-link file: ${ownerPath}`);
		}
		const owner = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
		if (
			owner.schema_version !== 1 ||
			!Number.isInteger(owner.pid) ||
			owner.pid < 1 ||
			typeof owner.token !== 'string' ||
			!/^[0-9a-f-]{36}$/.test(owner.token)
		) {
			throw new Error(`public corpus lock owner is invalid: ${ownerPath}`);
		}
		const directoryAfter = lockIdentity(lockPath);
		if (!sameFileIdentity(directoryBefore, directoryAfter)) {
			throw new Error(`public corpus lock changed while reading its owner: ${lockPath}`);
		}
		return { owner, identity: directoryAfter };
	} finally {
		fs.closeSync(descriptor);
	}
}

function restoreClaimedLock(claimedPath, lockPath) {
	if (fs.lstatSync(lockPath, { throwIfNoEntry: false })) {
		throw new Error(
			`public corpus lock changed during recovery; the claimed lock was preserved at ${claimedPath}`,
		);
	}
	try {
		fs.renameSync(claimedPath, lockPath);
	} catch (error) {
		throw new Error(
			`public corpus lock changed during recovery; the claimed lock was preserved at ${claimedPath}: ${error.message}`,
		);
	}
}

function removeClaimedLock(claimedPath, expected, beforeCleanup) {
	beforeCleanup?.({ claimedPath });
	const current = readLockOwner(claimedPath);
	if (
		!sameFileIdentity(current.identity, expected.identity) ||
		!sameLockOwner(current.owner, expected.owner)
	) {
		throw new Error(`public corpus claimed lock changed before cleanup: ${claimedPath}`);
	}
	fs.unlinkSync(path.join(claimedPath, 'owner.json'));
	const directory = lockIdentity(claimedPath);
	if (!sameFileIdentity(directory, expected.identity)) {
		throw new Error(`public corpus claimed lock changed during cleanup: ${claimedPath}`);
	}
	if (fs.readdirSync(claimedPath).length !== 0) {
		throw new Error(`public corpus claimed lock was not empty during cleanup: ${claimedPath}`);
	}
	fs.rmdirSync(claimedPath);
}

export function acquirePublicCorpusLock(workspace, timeoutMs = 30_000, options = {}) {
	const lockName = options.lockName ?? '.prepare.lock';
	if (
		typeof lockName !== 'string' ||
		!/^\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.lock$/.test(lockName) ||
		path.basename(lockName) !== lockName ||
		lockName.includes('\\')
	) {
		throw new Error(`public corpus lock name must be a safe .*.lock basename: ${lockName}`);
	}
	const lockPath = path.join(workspace, lockName);
	const activity = options.activity ?? 'public corpus preparation';
	if (typeof activity !== 'string' || activity.length === 0 || /[\r\n]/.test(activity)) {
		throw new Error('public corpus lock activity must be a non-empty single-line string');
	}
	const token = randomUUID();
	const pendingPath = `${lockPath}.pending-${token}`;
	const identity = processIdentity(process.pid);
	fs.mkdirSync(pendingPath, { mode: 0o700 });
	try {
		fs.writeFileSync(
			path.join(pendingPath, 'owner.json'),
			`${JSON.stringify({
				schema_version: 1,
				pid: process.pid,
				...(identity ? { process_identity: identity } : {}),
				token,
				created_at: new Date().toISOString(),
			})}\n`,
			{ encoding: 'utf8', mode: 0o600, flag: 'wx' },
		);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				fs.renameSync(pendingPath, lockPath);
				const acquired = readLockOwner(lockPath);
				if (acquired.owner.pid !== process.pid || acquired.owner.token !== token) {
					throw new Error('public corpus lock changed immediately after acquisition');
				}
				return { lockPath, token, identity: acquired.identity };
			} catch (error) {
				if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
			}
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for ${activity}: ${lockPath}`);
			}
			let observed;
			try {
				observed = readLockOwner(lockPath);
			} catch (error) {
				if (!fs.lstatSync(lockPath, { throwIfNoEntry: false })) continue;
				throw new Error(`public corpus left an unreadable lock: ${error.message}`);
			}
			if (processOwnsState(observed.owner)) {
				waitForLock(Math.min(25, Math.max(1, deadline - Date.now())));
				continue;
			}
			options.beforeStaleClaim?.({ lockPath, observedOwner: observed.owner });
			const stalePath = `${lockPath}.stale-${token}-${randomUUID()}`;
			try {
				fs.renameSync(lockPath, stalePath);
			} catch (error) {
				if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error.code)) continue;
				throw error;
			}
			let claimed;
			try {
				claimed = readLockOwner(stalePath);
			} catch (error) {
				restoreClaimedLock(stalePath, lockPath);
				throw new Error(`could not re-attest claimed stale lock: ${error.message}`);
			}
			if (
				!sameFileIdentity(observed.identity, claimed.identity) ||
				!sameLockOwner(observed.owner, claimed.owner)
			) {
				restoreClaimedLock(stalePath, lockPath);
				continue;
			}
			const final = readLockOwner(stalePath);
			if (
				!sameFileIdentity(claimed.identity, final.identity) ||
				!sameLockOwner(claimed.owner, final.owner)
			) {
				restoreClaimedLock(stalePath, lockPath);
				continue;
			}
			removeClaimedLock(stalePath, final, options.beforeStaleCleanup);
		}
	} catch (error) {
		fs.rmSync(pendingPath, { recursive: true, force: true });
		throw error;
	}
}

export function releasePublicCorpusLock(lock, options = {}) {
	let observed;
	try {
		observed = readLockOwner(lock.lockPath);
	} catch {
		return false;
	}
	if (
		observed.owner.pid !== process.pid ||
		observed.owner.token !== lock.token ||
		!sameFileIdentity(observed.identity, lock.identity)
	) {
		return false;
	}
	options.beforeReleaseClaim?.({ lockPath: lock.lockPath });
	const claimedPath = `${lock.lockPath}.release-${lock.token}-${randomUUID()}`;
	try {
		fs.renameSync(lock.lockPath, claimedPath);
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
	let claimed;
	try {
		claimed = readLockOwner(claimedPath);
	} catch (error) {
		restoreClaimedLock(claimedPath, lock.lockPath);
		throw new Error(`could not re-attest public corpus lock during release: ${error.message}`);
	}
	if (
		claimed.owner.pid !== process.pid ||
		claimed.owner.token !== lock.token ||
		!sameFileIdentity(claimed.identity, lock.identity)
	) {
		restoreClaimedLock(claimedPath, lock.lockPath);
		return false;
	}
	removeClaimedLock(claimedPath, claimed, options.beforeReleaseCleanup);
	return true;
}

export function assertPublicCorpusLockOwned(lock) {
	if (!lock) throw new Error('public corpus mutation requires the shared workspace lock');
	const observed = readLockOwner(lock.lockPath);
	if (
		observed.owner.pid !== process.pid ||
		observed.owner.token !== lock.token ||
		!sameFileIdentity(observed.identity, lock.identity) ||
		!processOwnsState(observed.owner)
	) {
		throw new Error('public corpus shared workspace lock ownership changed during mutation');
	}
	return true;
}

export const acquirePreparationLock = acquirePublicCorpusLock;
export const releasePreparationLock = releasePublicCorpusLock;
