import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export const MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES = 1024 * 1024;

const CHECKPOINT_FILENAME_PATTERN =
	/^run-(?:whisper-(?:cpu|metal|coreml-metal|cuda|vulkan|hipblas|openblas-cpu)|parakeet-onnx-cpu)-[0-9a-f]{16}-[0-9a-f]{16}\.run\.json$/;
const ATTEMPT_FILENAME_PATTERN =
	/^\.benchmark-attempt-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const MANAGED_PAIR_SUFFIX_PATTERN =
	/^([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function lexicalCompare(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function entryAt(entryPath) {
	return fs.lstatSync(entryPath, { bigint: true, throwIfNoEntry: false });
}

function isSingleLinkRegularFile(status) {
	return status.isFile() && status.nlink === 1n;
}

function isAllowedLinkRegularFile(status, allowedLinks) {
	return status.isFile() && allowedLinks.has(status.nlink);
}

function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameRevision(left, right) {
	return (
		sameIdentity(left, right) &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function openResultsDirectory(resultsDirectory, { allowMissing = false } = {}) {
	const resolved = path.resolve(resultsDirectory);
	const entry = entryAt(resolved);
	if (!entry && allowMissing) return null;
	if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
		throw new Error(`benchmark results path must be a non-symlink directory: ${resolved}`);
	}
	let descriptor;
	try {
		descriptor = fs.openSync(
			resolved,
			fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
		);
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (!opened.isDirectory() || !sameRevision(entry, opened)) {
			throw new Error(`benchmark results directory changed while it was being opened: ${resolved}`);
		}
		return { path: resolved, status: opened, descriptor };
	} catch (error) {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		if (error instanceof Error && error.message.startsWith('benchmark results directory')) {
			throw error;
		}
		throw new Error(`benchmark results directory could not be opened safely: ${resolved}`);
	}
}

function assertResultsDirectoryBound(results, { requireUnchangedRevision = true } = {}) {
	const descriptorStatus = fs.fstatSync(results.descriptor, { bigint: true });
	const pathStatus = entryAt(results.path);
	if (
		!descriptorStatus.isDirectory() ||
		!pathStatus ||
		pathStatus.isSymbolicLink() ||
		!pathStatus.isDirectory() ||
		!sameIdentity(results.status, descriptorStatus) ||
		!sameIdentity(descriptorStatus, pathStatus) ||
		(requireUnchangedRevision &&
			(!sameRevision(results.status, descriptorStatus) ||
				!sameRevision(descriptorStatus, pathStatus)))
	) {
		throw new Error(`benchmark results directory changed during access: ${results.path}`);
	}
}

function assertCheckpointName(name) {
	if (!CHECKPOINT_FILENAME_PATTERN.test(name)) {
		throw new Error(`invalid corpus benchmark checkpoint filename: ${name}`);
	}
}

function openRegularFileNoFollow(filePath, label, options = {}) {
	const allowedLinks = new Set(options.allowedLinks ?? [1n]);
	const initial = entryAt(filePath);
	if (!initial || initial.isSymbolicLink() || !isAllowedLinkRegularFile(initial, allowedLinks)) {
		const requirement =
			allowedLinks.size === 1 && allowedLinks.has(1n)
				? 'a regular single-link file'
				: 'a regular single-link file or a valid managed-pair file';
		throw new Error(`${label} must be ${requirement}: ${filePath}`);
	}
	let descriptor;
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	} catch {
		throw new Error(`${label} could not be opened without following aliases: ${filePath}`);
	}
	let opened;
	try {
		opened = fs.fstatSync(descriptor, { bigint: true });
		if (!isAllowedLinkRegularFile(opened, allowedLinks) || !sameRevision(initial, opened)) {
			throw new Error(`${label} changed before it could be read safely: ${filePath}`);
		}
	} catch (error) {
		fs.closeSync(descriptor);
		throw error;
	}
	return { descriptor, opened };
}

function isManagedCheckpointPairName(name, checkpointName) {
	if (!name.startsWith(`${checkpointName}.tmp-`)) return false;
	return MANAGED_PAIR_SUFFIX_PATTERN.test(name.slice(`${checkpointName}.tmp-`.length));
}

function openManagedCheckpointPair(results, checkpointName, checkpointStatus) {
	assertResultsDirectoryBound(results);
	const candidates = fs
		.readdirSync(results.path)
		.filter((name) => isManagedCheckpointPairName(name, checkpointName));
	assertResultsDirectoryBound(results);
	if (candidates.length !== 1) {
		throw new Error(
			`corpus benchmark checkpoint must be a regular single-link file or have exactly one managed hard-link sibling: ${checkpointName}`,
		);
	}
	const pairPath = path.join(results.path, candidates[0]);
	const pair = openRegularFileNoFollow(pairPath, 'managed corpus benchmark checkpoint sibling', {
		allowedLinks: [2n],
	});
	if (!sameIdentity(checkpointStatus, pair.opened)) {
		fs.closeSync(pair.descriptor);
		throw new Error(
			`corpus benchmark checkpoint managed sibling does not reference the same file: ${pairPath}`,
		);
	}
	return { ...pair, path: pairPath };
}

function readBounded(descriptor, maximumBytes) {
	const chunks = [];
	let totalBytes = 0;
	while (totalBytes <= maximumBytes) {
		const remaining = maximumBytes + 1 - totalBytes;
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
		const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
		if (bytesRead === 0) break;
		chunks.push(chunk.subarray(0, bytesRead));
		totalBytes += bytesRead;
	}
	if (totalBytes > maximumBytes) return null;
	return Buffer.concat(chunks, totalBytes);
}

function validateMaximumBytes(value) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error('checkpoint maximum bytes must be a positive safe integer');
	}
	return value;
}

export function isCorpusBenchmarkCheckpointName(name) {
	return typeof name === 'string' && CHECKPOINT_FILENAME_PATTERN.test(name);
}

export function isCorpusBenchmarkAttemptName(name) {
	if (typeof name !== 'string') return false;
	const match = name.match(ATTEMPT_FILENAME_PATTERN);
	if (!match) return false;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0;
}

function readCheckpointFromResults(results, name, options = {}) {
	assertCheckpointName(name);
	assertResultsDirectoryBound(results);
	const resolvedPath = path.join(results.path, name);
	const maximumBytes = validateMaximumBytes(
		options.maximumBytes ?? MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES,
	);
	const { descriptor, opened } = openRegularFileNoFollow(
		resolvedPath,
		'corpus benchmark checkpoint',
		{ allowedLinks: [1n, 2n] },
	);
	let managedPair = null;
	let contents;
	let finalDescriptorStatus;
	let finalPairDescriptorStatus;
	try {
		if (opened.nlink === 2n) {
			managedPair = openManagedCheckpointPair(results, name, opened);
		}
		if (opened.size > BigInt(maximumBytes)) {
			throw new Error(`corpus benchmark checkpoint is too large: ${resolvedPath}`);
		}
		contents = readBounded(descriptor, maximumBytes);
		if (contents === null) {
			throw new Error(`corpus benchmark checkpoint is too large: ${resolvedPath}`);
		}
		options.onAfterRead?.({ path: resolvedPath });
		finalDescriptorStatus = fs.fstatSync(descriptor, { bigint: true });
		if (managedPair) {
			finalPairDescriptorStatus = fs.fstatSync(managedPair.descriptor, { bigint: true });
		}
	} finally {
		if (managedPair) fs.closeSync(managedPair.descriptor);
		fs.closeSync(descriptor);
	}
	const finalPathStatus = entryAt(resolvedPath);
	const finalPairPathStatus = managedPair ? entryAt(managedPair.path) : null;
	const expectedLinks = managedPair ? 2n : 1n;
	if (
		!finalPathStatus ||
		finalPathStatus.isSymbolicLink() ||
		!finalDescriptorStatus?.isFile() ||
		finalDescriptorStatus.nlink !== expectedLinks ||
		!finalPathStatus.isFile() ||
		finalPathStatus.nlink !== expectedLinks ||
		!sameRevision(opened, finalDescriptorStatus) ||
		!sameRevision(finalDescriptorStatus, finalPathStatus) ||
		(managedPair &&
			(!finalPairPathStatus ||
				finalPairPathStatus.isSymbolicLink() ||
				!finalPairDescriptorStatus?.isFile() ||
				finalPairDescriptorStatus.nlink !== 2n ||
				!finalPairPathStatus.isFile() ||
				finalPairPathStatus.nlink !== 2n ||
				!sameRevision(managedPair.opened, finalPairDescriptorStatus) ||
				!sameRevision(finalPairDescriptorStatus, finalPairPathStatus) ||
				!sameIdentity(finalDescriptorStatus, finalPairDescriptorStatus))) ||
		BigInt(contents.length) !== finalDescriptorStatus.size
	) {
		throw new Error(`corpus benchmark checkpoint changed while it was being read: ${resolvedPath}`);
	}
	assertResultsDirectoryBound(results);
	let decoded;
	try {
		decoded = UTF8_DECODER.decode(contents);
	} catch {
		throw new Error(`corpus benchmark checkpoint is not valid UTF-8: ${resolvedPath}`);
	}
	let report;
	try {
		report = JSON.parse(decoded);
	} catch {
		throw new Error(`corpus benchmark checkpoint is not valid JSON: ${resolvedPath}`);
	}
	if (report === null || typeof report !== 'object' || Array.isArray(report)) {
		throw new Error(`corpus benchmark checkpoint must contain a JSON object: ${resolvedPath}`);
	}
	return {
		name,
		path: resolvedPath,
		report,
		sha256: createHash('sha256').update(contents).digest('hex'),
	};
}

export function readCorpusBenchmarkCheckpoint(checkpointPath, options = {}) {
	const resolvedPath = path.resolve(checkpointPath);
	const name = path.basename(resolvedPath);
	const results = openResultsDirectory(path.dirname(resolvedPath));
	try {
		return readCheckpointFromResults(results, name, options);
	} finally {
		fs.closeSync(results.descriptor);
	}
}

export function discoverCorpusBenchmarkCheckpoints(resultsDirectory, options = {}) {
	const results = openResultsDirectory(resultsDirectory, { allowMissing: true });
	if (!results) return [];
	try {
		const names = fs.readdirSync(results.path).sort(lexicalCompare);
		assertResultsDirectoryBound(results);
		const seen = new Set();
		const checkpoints = [];
		for (const name of names) {
			if (!name.endsWith('.run.json')) continue;
			if (seen.has(name)) {
				throw new Error(`duplicate corpus benchmark checkpoint filename: ${name}`);
			}
			seen.add(name);
			assertCheckpointName(name);
			checkpoints.push(
				readCheckpointFromResults(results, name, {
					maximumBytes: options.maximumBytes,
					onAfterRead: options.onAfterRead,
				}),
			);
		}
		assertResultsDirectoryBound(results);
		return checkpoints;
	} finally {
		fs.closeSync(results.descriptor);
	}
}

export function cleanupCorpusBenchmarkAttempt(attemptPath, options = {}) {
	const resolvedPath = path.resolve(attemptPath);
	const name = path.basename(resolvedPath);
	if (!isCorpusBenchmarkAttemptName(name)) {
		throw new Error(`refusing to clean non-reserved benchmark attempt path: ${resolvedPath}`);
	}
	const results = openResultsDirectory(path.dirname(resolvedPath));
	try {
		assertResultsDirectoryBound(results);
		const initial = entryAt(resolvedPath);
		if (!initial) return false;
		const { descriptor, opened } = openRegularFileNoFollow(resolvedPath, 'benchmark attempt');
		try {
			options.onBeforeUnlink?.({ path: resolvedPath });
			assertResultsDirectoryBound(results);
			const finalStatus = entryAt(resolvedPath);
			if (
				!finalStatus ||
				finalStatus.isSymbolicLink() ||
				!isSingleLinkRegularFile(finalStatus) ||
				!sameRevision(opened, finalStatus)
			) {
				throw new Error(`benchmark attempt changed before cleanup: ${resolvedPath}`);
			}
			fs.unlinkSync(resolvedPath);
			assertResultsDirectoryBound(results, { requireUnchangedRevision: false });
			return true;
		} finally {
			fs.closeSync(descriptor);
		}
	} finally {
		fs.closeSync(results.descriptor);
	}
}
