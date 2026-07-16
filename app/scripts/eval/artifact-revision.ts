import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sameMetadata(left, right) {
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

function metadataRecord(relativePath, kind, status) {
	return {
		path: relativePath,
		kind,
		dev: status.dev.toString(),
		ino: status.ino.toString(),
		mode: status.mode.toString(),
		nlink: status.nlink.toString(),
		size: status.size.toString(),
		mtime_ns: status.mtimeNs.toString(),
		ctime_ns: status.ctimeNs.toString(),
	};
}

function utf8Filename(name, directoryPath) {
	const decoded = name.toString('utf8');
	if (!Buffer.from(decoded, 'utf8').equals(name)) {
		throw new Error(`artifact snapshot contains a non-UTF-8 filename under ${directoryPath}`);
	}
	return decoded;
}

/**
 * Cheap revision of a private artifact tree.
 *
 * This deliberately records metadata and exact directory membership rather
 * than rereading large model or executable bytes. Full content digests remain
 * authoritative during snapshot creation and explicit session revalidation.
 */
export function artifactTreeRevision(rootDirectory) {
	const root = path.resolve(rootDirectory);
	const visited = new Set();
	const records = [];

	const visit = (entryPath, relativePath) => {
		const initial = fs.lstatSync(entryPath, { bigint: true, throwIfNoEntry: false });
		if (!initial || initial.isSymbolicLink()) {
			throw new Error('artifact snapshot entries must exist without symbolic links');
		}
		const identity = `${initial.dev}:${initial.ino}`;
		if (visited.has(identity)) {
			throw new Error('artifact snapshot entries cannot alias one another');
		}
		visited.add(identity);

		if (initial.isFile()) {
			if (initial.nlink !== 1n) {
				throw new Error('artifact snapshot files must have exactly one hard link');
			}
			records.push(metadataRecord(relativePath, 'file', initial));
			const final = fs.lstatSync(entryPath, { bigint: true, throwIfNoEntry: false });
			if (!final?.isFile() || final.isSymbolicLink() || !sameMetadata(initial, final)) {
				throw new Error('artifact snapshot file changed during revision capture');
			}
			return;
		}
		if (!initial.isDirectory()) {
			throw new Error('artifact snapshot entries must be regular files or directories');
		}

		records.push(metadataRecord(relativePath, 'directory', initial));
		const entries = fs
			.readdirSync(entryPath, { encoding: 'buffer' })
			.sort((left, right) => Buffer.compare(left, right));
		for (const name of entries) {
			const filename = utf8Filename(name, entryPath);
			const childRelativePath =
				relativePath.length === 0 ? filename : `${relativePath}/${filename}`;
			visit(path.join(entryPath, filename), childRelativePath);
		}
		const final = fs.lstatSync(entryPath, { bigint: true, throwIfNoEntry: false });
		if (!final?.isDirectory() || final.isSymbolicLink() || !sameMetadata(initial, final)) {
			throw new Error('artifact snapshot directory changed during revision capture');
		}
	};

	visit(root, '');
	return createHash('sha256')
		.update(JSON.stringify({ schema_version: 1, entries: records }))
		.digest('hex');
}
