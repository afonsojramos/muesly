import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { processIdentity, processOwnsState } from './process-identity.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_DIRECTORY_PATTERN = /^\.muesly-eval-artifacts-([1-9][0-9]*)-[A-Za-z0-9]{6}$/;
let cachedProcessIdentity;

function sameFileSnapshot(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function requireSingleLinkRegularFile(filePath, label) {
	const status = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
	if (!status?.isFile() || status.isSymbolicLink() || status.nlink !== 1n) {
		throw new Error(`${label} must be a regular single-link file`);
	}
	return status;
}

function sha256RegularFile(filePath, label) {
	const initial = requireSingleLinkRegularFile(filePath, label);
	let descriptor;
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!opened.isFile() || opened.nlink !== 1n || !sameFileSnapshot(initial, opened)) {
			throw new Error(`${label} changed while it was being opened`);
		}
		const hash = createHash('sha256');
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
		const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
		const finalPath = requireSingleLinkRegularFile(filePath, label);
		if (
			!sameFileSnapshot(opened, finalDescriptor) ||
			!sameFileSnapshot(finalDescriptor, finalPath)
		) {
			throw new Error(`${label} changed while it was being hashed`);
		}
		return hash.digest('hex');
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function snapshotOwner(directory, expectedPid) {
	const ownerPath = path.join(directory, 'owner.json');
	const status = fs.lstatSync(ownerPath, { bigint: true, throwIfNoEntry: false });
	if (!status?.isFile() || status.isSymbolicLink() || status.nlink !== 1n || status.size > 4096n) {
		return null;
	}
	let descriptor;
	try {
		descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!sameFileSnapshot(status, opened)) return null;
		const owner = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
		const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
		const finalPath = fs.lstatSync(ownerPath, { bigint: true, throwIfNoEntry: false });
		if (
			!finalPath?.isFile() ||
			finalPath.isSymbolicLink() ||
			!sameFileSnapshot(opened, finalDescriptor) ||
			!sameFileSnapshot(finalDescriptor, finalPath)
		) {
			return null;
		}
		if (
			owner?.schema_version !== 1 ||
			owner.pid !== expectedPid ||
			(Object.hasOwn(owner, 'process_identity') &&
				(typeof owner.process_identity !== 'string' || owner.process_identity.length === 0))
		) {
			return null;
		}
		return owner;
	} catch {
		return null;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

export function reclaimStaleArtifactSnapshotDirectories(parentDirectory) {
	for (const name of fs.readdirSync(parentDirectory)) {
		const match = SNAPSHOT_DIRECTORY_PATTERN.exec(name);
		if (!match) continue;
		const directory = path.join(parentDirectory, name);
		const initial = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
		if (!initial?.isDirectory() || initial.isSymbolicLink()) continue;
		const owner = snapshotOwner(directory, Number(match[1]));
		if (!owner || processOwnsState(owner)) continue;
		const final = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
		if (!final?.isDirectory() || final.isSymbolicLink() || !sameFileSnapshot(initial, final)) {
			continue;
		}
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

function currentProcessIdentity() {
	if (cachedProcessIdentity === undefined) {
		cachedProcessIdentity = processIdentity(process.pid);
	}
	return cachedProcessIdentity;
}

export function createPrivateArtifactSnapshotDirectory(parentDirectory = os.tmpdir()) {
	reclaimStaleArtifactSnapshotDirectories(parentDirectory);
	const directory = fs.mkdtempSync(
		path.join(parentDirectory, `.muesly-eval-artifacts-${process.pid}-`),
	);
	try {
		fs.chmodSync(directory, 0o700);
		const status = fs.lstatSync(directory);
		if (!status.isDirectory() || status.isSymbolicLink()) {
			throw new Error('private artifact snapshot path is not a real directory');
		}
		const identity = currentProcessIdentity();
		fs.writeFileSync(
			path.join(directory, 'owner.json'),
			`${JSON.stringify({
				schema_version: 1,
				pid: process.pid,
				...(identity ? { process_identity: identity } : {}),
			})}\n`,
			{ mode: 0o600 },
		);
		return directory;
	} catch (error) {
		fs.rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Copy one attested file into a private snapshot.
 *
 * COPYFILE_FICLONE gives large local model artifacts an independent
 * copy-on-write snapshot on supporting filesystems and falls back to a regular
 * byte copy elsewhere. The destination digest is always recomputed, so a
 * source path swapped only during copy cannot enter the benchmark unnoticed.
 */
export function copyAttestedFileSnapshot(
	sourcePath,
	destinationPath,
	{ expectedSha256 = null, mode = 0o600, label = 'artifact snapshot' } = {},
) {
	if (expectedSha256 !== null && !SHA256_PATTERN.test(expectedSha256)) {
		throw new Error(`${label} expected SHA-256 is invalid`);
	}
	const sourceBefore = requireSingleLinkRegularFile(sourcePath, label);
	fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
	try {
		fs.copyFileSync(
			sourcePath,
			destinationPath,
			fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE ?? 0),
		);
		fs.chmodSync(destinationPath, mode);
		const sourceAfter = requireSingleLinkRegularFile(sourcePath, label);
		if (!sameFileSnapshot(sourceBefore, sourceAfter)) {
			throw new Error(`${label} source changed while it was being snapshotted`);
		}
		const sha256 = sha256RegularFile(destinationPath, label);
		if (expectedSha256 !== null && sha256 !== expectedSha256) {
			throw new Error(`${label} does not match the expected SHA-256`);
		}
		return sha256;
	} catch (error) {
		fs.rmSync(destinationPath, { force: true });
		throw error;
	}
}
