#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileSha256, REFERENCE_PROTOCOL_ID } from './corpus.ts';
import { wavDurationSeconds } from './corpus-intake.ts';
import {
	acquirePreparationLock,
	assertPublicCorpusLockOwned,
	releasePreparationLock,
} from './public-corpus-lock.ts';
import {
	artifactCachePath,
	assertExtractedTree,
	deriveEarningsReferenceExcerpt,
	ensurePrivateDirectory,
	extractArchiveMembers,
	listArchiveEntries,
	loadPublicCorpusConfig,
	materializeCatalogArtifacts,
	parseAmiWordDocuments,
	parseFleursTsv,
	planOverlapTimings,
	renderEarningsContext,
	renderTimedReference,
	resolveInside,
	selectDensestTimedWindow,
	selectFleursComposites,
	sha256Text,
	verifyPinnedArtifactFile,
	writePreparedBundle,
	PUBLIC_PREPARED_SCHEMA_VERSION,
} from './public-corpus.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PUBLIC_CATALOG = path.join(here, 'public-corpus-sources.json');
export const DEFAULT_PUBLIC_SELECTION = path.join(here, 'public-corpus-selection.json');
export const DEFAULT_PUBLIC_WORKSPACE = path.join(here, 'public-corpus');

function parseNonNegativeNumber(value, flag) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) throw new Error(`${flag} must be non-negative`);
	return number;
}

export function parsePublicPrepareArgs(args) {
	const options = {
		catalogPath: DEFAULT_PUBLIC_CATALOG,
		selectionPath: DEFAULT_PUBLIC_SELECTION,
		workspace: DEFAULT_PUBLIC_WORKSPACE,
		allowNetwork: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const value = () => {
			const next = args[index + 1];
			if (next === undefined || next.startsWith('--')) {
				throw new Error(`${argument} requires a value`);
			}
			index += 1;
			return next;
		};
		if (argument === '--download') {
			options.allowNetwork = true;
		} else if (argument === '--catalog') {
			options.catalogPath = path.resolve(value());
		} else if (argument === '--selection') {
			options.selectionPath = path.resolve(value());
		} else if (argument === '--workspace') {
			options.workspace = path.resolve(value());
		} else if (argument === '--ffmpeg') {
			options.ffmpegPath = path.resolve(value());
		} else if (argument === '--minimum-free-gib') {
			options.minimumFreeBytes = Math.floor(
				parseNonNegativeNumber(value(), '--minimum-free-gib') * 1024 ** 3,
			);
		} else if (argument === '--help') {
			options.help = true;
		} else {
			throw new Error(`unknown argument '${argument}'`);
		}
	}
	return options;
}

function usage() {
	return `Usage: nub app/scripts/eval/public-corpus-prepare.ts [options]

Options:
  --download                 Explicitly allow missing pinned sources to be downloaded
  --catalog <path>           Source catalog (default: public-corpus-sources.json)
  --selection <path>         Deterministic selection (default: public-corpus-selection.json)
  --workspace <path>         Ignored local workspace (default: public-corpus/)
  --ffmpeg <path>            FFmpeg executable; current Apple Silicon bundle is auto-detected
  --minimum-free-gib <GiB>   Override the 20 GiB preparation preflight
  --help                     Show this help
`;
}

export { acquirePreparationLock, releasePreparationLock } from './public-corpus-lock.ts';

export function assertWorkspaceIsUntracked(
	workspace,
	repositoryRoot = path.resolve(here, '../../..'),
) {
	const absoluteWorkspace = path.resolve(workspace);
	const relative = path.relative(repositoryRoot, absoluteWorkspace);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return;
	if (relative.length === 0)
		throw new Error('public corpus workspace cannot be the repository root');
	const checkPath = fs.existsSync(absoluteWorkspace)
		? absoluteWorkspace
		: `${absoluteWorkspace}${path.sep}`;
	const result = spawnSync(
		'git',
		['-C', repositoryRoot, 'check-ignore', '--quiet', '--no-index', '--', checkPath],
		{ encoding: 'utf8' },
	);
	if (result.status !== 0) {
		throw new Error(
			`public corpus workspace is inside the repository but is not ignored: ${absoluteWorkspace}`,
		);
	}
}

export const PUBLIC_GENERATED_OUTPUT_BUDGET_BYTES = 4 * 1024 ** 3;

export function calculatePreparationDiskRequirement(
	catalog,
	cacheRoot,
	reserveBytes,
	generatedOutputBytes = PUBLIC_GENERATED_OUTPUT_BUDGET_BYTES,
) {
	const missingArtifactBytes = catalog.artifacts.reduce(
		(total, artifact) =>
			total + (fs.existsSync(artifactCachePath(cacheRoot, artifact)) ? 0 : artifact.size_bytes),
		0,
	);
	return {
		reserveBytes,
		missingArtifactBytes,
		generatedOutputBytes,
		requiredBytes: reserveBytes + missingArtifactBytes + generatedOutputBytes,
	};
}

function requireFreeSpace(workspace, requirement) {
	const stats = fs.statfsSync(workspace);
	const availableBytes = stats.bavail * stats.bsize;
	if (availableBytes < requirement.requiredBytes) {
		throw new Error(
			`public corpus preparation requires ${(requirement.requiredBytes / 1024 ** 3).toFixed(1)} GiB free ` +
				`(${(requirement.reserveBytes / 1024 ** 3).toFixed(1)} GiB reserve, ` +
				`${(requirement.missingArtifactBytes / 1024 ** 3).toFixed(1)} GiB missing downloads, ` +
				`${(requirement.generatedOutputBytes / 1024 ** 3).toFixed(1)} GiB generation budget); ` +
				`only ${(availableBytes / 1024 ** 3).toFixed(1)} GiB is available`,
		);
	}
	return availableBytes;
}

function resolveFfmpeg(explicitPath) {
	let candidate = explicitPath ?? process.env.FFMPEG_PATH;
	if (!candidate && process.platform === 'darwin' && process.arch === 'arm64') {
		candidate = path.resolve(here, '../../src-tauri/binaries/ffmpeg-aarch64-apple-darwin');
	}
	if (!candidate) {
		try {
			candidate = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
		} catch {
			throw new Error('FFmpeg was not found; pass --ffmpeg with the exact executable');
		}
	}
	const absolute = fs.realpathSync(candidate);
	const entry = fs.lstatSync(absolute);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`FFmpeg must be a regular executable: ${candidate}`);
	}
	fs.accessSync(absolute, fs.constants.X_OK);
	return absolute;
}

function resolveApprovedFfmpeg(explicitPath, selection) {
	const executablePath = resolveFfmpeg(explicitPath);
	const sha256 = fileSha256(executablePath);
	const version = execFileSync(executablePath, ['-version'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 1024 * 1024,
	})
		.split(/\r?\n/, 1)[0]
		.trim();
	const approved = selection.approved_ffmpeg.find(
		(toolchain) => toolchain.sha256 === sha256 && toolchain.version === version,
	);
	if (!approved) {
		throw new Error(
			`FFmpeg ${sha256} (${version}) is not in selection.approved_ffmpeg; pin it before preparing`,
		);
	}
	return { id: approved.id, executablePath, sha256, version };
}

function runFfmpeg(ffmpegPath, args, temporaryOutput) {
	execFileSync(
		ffmpegPath,
		['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, temporaryOutput],
		{ stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
	);
	const entry = fs.lstatSync(temporaryOutput, { throwIfNoEntry: false });
	if (!entry?.isFile() || entry.isSymbolicLink() || entry.size === 0) {
		throw new Error(`FFmpeg did not create a regular non-empty output: ${temporaryOutput}`);
	}
}

export function publishNoClobber(temporaryPath, destination) {
	ensurePrivateDirectory(path.dirname(destination), 'generated public corpus directory');
	try {
		fs.linkSync(temporaryPath, destination);
		fs.unlinkSync(temporaryPath);
		return { published: true, path: destination };
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
		const temporaryHash = fileSha256(temporaryPath);
		const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
		if (!existing?.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
			throw new Error(`existing generated output is not a safe regular file: ${destination}`);
		}
		if (fileSha256(destination) !== temporaryHash) {
			throw new Error(`refusing to replace different existing generated output: ${destination}`);
		}
		fs.unlinkSync(temporaryPath);
		return { published: false, path: destination };
	}
}

function generatedWav(ffmpegPath, destination, args) {
	ensurePrivateDirectory(path.dirname(destination), 'generated audio directory');
	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination, '.wav')}.tmp-${process.pid}-${randomUUID()}.wav`,
	);
	try {
		runFfmpeg(ffmpegPath, args, temporary);
		publishNoClobber(temporary, destination);
	} catch (error) {
		if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
		throw error;
	}
	return destination;
}

function sameReferenceIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function safeReferenceStatus(status) {
	return status.isFile() && !status.isSymbolicLink() && status.nlink === 1n;
}

function fsyncReferenceDirectory(referencePath) {
	if (process.platform === 'win32') return;
	const descriptor = fs.openSync(
		path.dirname(referencePath),
		fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

function readStableReference(descriptor, status, referencePath) {
	const size = Number(status.size);
	if (!Number.isSafeInteger(size) || size > 16 * 1024 * 1024) {
		throw new Error(`existing public reference is too large: ${referencePath}`);
	}
	const contents = Buffer.alloc(size);
	let read = 0;
	while (read < size) {
		const count = fs.readSync(descriptor, contents, read, size - read, read);
		if (count === 0) break;
		read += count;
	}
	if (read !== size)
		throw new Error(`existing public reference changed while reading: ${referencePath}`);
	return contents;
}

function completeReferenceWrite(descriptor, opened, contents, referencePath) {
	const existing = readStableReference(descriptor, opened, referencePath);
	if (
		existing.length > contents.length ||
		!contents.subarray(0, existing.length).equals(existing)
	) {
		throw new Error(`interrupted public reference is not an exact seed prefix: ${referencePath}`);
	}
	let written = existing.length;
	while (written < contents.length) {
		const count = fs.writeSync(descriptor, contents, written, contents.length - written, written);
		if (count === 0) throw new Error(`seeded public reference write stalled: ${referencePath}`);
		written += count;
	}
	fs.fsyncSync(descriptor);
	const completed = fs.fstatSync(descriptor, { bigint: true });
	if (
		!completed.isFile() ||
		!sameReferenceIdentity(opened, completed) ||
		completed.size !== BigInt(contents.length) ||
		!readStableReference(descriptor, completed, referencePath).equals(contents)
	) {
		throw new Error(`seeded public reference failed content re-attestation: ${referencePath}`);
	}
	return completed;
}

function attestExactReferenceContents(descriptor, opened, contents, referencePath) {
	if (!readStableReference(descriptor, opened, referencePath).equals(contents)) {
		throw new Error(`published public reference does not match its exact seed: ${referencePath}`);
	}
	fs.fsyncSync(descriptor);
	const exact = fs.fstatSync(descriptor, { bigint: true });
	if (
		!exact.isFile() ||
		!sameReferenceIdentity(opened, exact) ||
		exact.size !== BigInt(contents.length) ||
		!readStableReference(descriptor, exact, referencePath).equals(contents)
	) {
		throw new Error(`published public reference failed content re-attestation: ${referencePath}`);
	}
	return exact;
}

function draftPublicationPath(referencePath) {
	return path.join(path.dirname(referencePath), `.${path.basename(referencePath)}.publish`);
}

function recoverInterruptedDraftPublication(referencePath, temporary, contents) {
	const stagedStatus = fs.lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
	if (!stagedStatus) return false;
	const publishedStatus = fs.lstatSync(referencePath, {
		bigint: true,
		throwIfNoEntry: false,
	});
	const descriptor = fs.openSync(
		publishedStatus ? referencePath : temporary,
		fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		if (
			!opened.isFile() ||
			opened.isSymbolicLink() ||
			!stagedStatus.isFile() ||
			stagedStatus.isSymbolicLink() ||
			!sameReferenceIdentity(opened, stagedStatus) ||
			opened.nlink !== (publishedStatus ? 2n : 1n) ||
			(publishedStatus &&
				(publishedStatus.nlink !== 2n || !sameReferenceIdentity(opened, publishedStatus)))
		) {
			throw new Error(
				`interrupted public reference publication is not recoverable: ${referencePath}`,
			);
		}
		const completed = publishedStatus
			? attestExactReferenceContents(descriptor, opened, contents, referencePath)
			: completeReferenceWrite(descriptor, opened, contents, referencePath);
		if (!publishedStatus) {
			fs.linkSync(temporary, referencePath);
			const linked = fs.fstatSync(descriptor, { bigint: true });
			const published = fs.lstatSync(referencePath, { bigint: true });
			if (
				linked.nlink !== 2n ||
				published.nlink !== 2n ||
				!sameReferenceIdentity(completed, linked) ||
				!sameReferenceIdentity(linked, published)
			) {
				throw new Error(`recovered public reference changed during publication: ${referencePath}`);
			}
		}
		fsyncReferenceDirectory(referencePath);
		const stagedBeforeUnlink = fs.lstatSync(temporary, { bigint: true });
		const publishedBeforeUnlink = fs.lstatSync(referencePath, { bigint: true });
		if (
			!sameReferenceIdentity(completed, stagedBeforeUnlink) ||
			!sameReferenceIdentity(completed, publishedBeforeUnlink)
		) {
			throw new Error(`recovered public reference changed before cleanup: ${referencePath}`);
		}
		fs.unlinkSync(temporary);
		fsyncReferenceDirectory(referencePath);
		const recovered = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(referencePath, { bigint: true });
		if (
			recovered.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameReferenceIdentity(completed, recovered) ||
			!sameReferenceIdentity(recovered, named)
		) {
			throw new Error(`public reference did not recover to one stable name: ${referencePath}`);
		}
		return true;
	} finally {
		fs.closeSync(descriptor);
	}
}

function publishNewDraftReference(referencePath, contents) {
	const temporary = draftPublicationPath(referencePath);
	if (recoverInterruptedDraftPublication(referencePath, temporary, contents)) return true;
	if (fs.lstatSync(referencePath, { throwIfNoEntry: false })) return false;
	const descriptor = fs.openSync(
		temporary,
		fs.constants.O_RDWR |
			fs.constants.O_CREAT |
			fs.constants.O_EXCL |
			(fs.constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		const opened = fs.fstatSync(descriptor, { bigint: true });
		completeReferenceWrite(descriptor, opened, contents, referencePath);
		try {
			fs.linkSync(temporary, referencePath);
		} catch (error) {
			if (error.code !== 'EEXIST') throw error;
			const staged = fs.lstatSync(temporary, { bigint: true });
			const current = fs.fstatSync(descriptor, { bigint: true });
			if (current.nlink !== 1n || !sameReferenceIdentity(current, staged)) {
				throw new Error(`public reference staging changed during publication: ${referencePath}`);
			}
			fs.unlinkSync(temporary);
			fsyncReferenceDirectory(referencePath);
			return false;
		}
		const staged = fs.lstatSync(temporary, { bigint: true });
		const published = fs.lstatSync(referencePath, { bigint: true });
		const linked = fs.fstatSync(descriptor, { bigint: true });
		if (
			linked.nlink !== 2n ||
			published.nlink !== 2n ||
			!sameReferenceIdentity(staged, linked) ||
			!sameReferenceIdentity(linked, published)
		) {
			throw new Error(`public reference changed during publication: ${referencePath}`);
		}
		fsyncReferenceDirectory(referencePath);
		fs.unlinkSync(temporary);
		fsyncReferenceDirectory(referencePath);
		const completed = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(referencePath, { bigint: true });
		if (completed.nlink !== 1n || named.nlink !== 1n || !sameReferenceIdentity(completed, named)) {
			throw new Error(`public reference did not publish to one stable name: ${referencePath}`);
		}
		return true;
	} finally {
		fs.closeSync(descriptor);
	}
}

function emptySeedTransactionPath(referencePath, contents) {
	return path.join(
		path.dirname(referencePath),
		`.${path.basename(referencePath)}.seed-empty-${sha256Text(contents.toString('utf8'))}.txn`,
	);
}

function seedExistingEmptyReference(referencePath, expected, contents, options) {
	const transactionPath = emptySeedTransactionPath(referencePath, contents);
	let transaction = fs.lstatSync(transactionPath, { bigint: true, throwIfNoEntry: false });
	const recovering = Boolean(transaction);
	if (!transaction) options.beforeExistingOpen?.();
	const descriptor = fs.openSync(
		referencePath,
		fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		let opened = fs.fstatSync(descriptor, { bigint: true });
		if (recovering) {
			if (
				!transaction.isFile() ||
				transaction.isSymbolicLink() ||
				transaction.nlink !== 2n ||
				opened.nlink !== 2n ||
				!sameReferenceIdentity(transaction, opened) ||
				!sameReferenceIdentity(expected, opened)
			) {
				throw new Error(`empty-reference seed transaction is not recoverable: ${referencePath}`);
			}
		} else {
			if (
				!safeReferenceStatus(opened) ||
				opened.size !== 0n ||
				!sameReferenceIdentity(expected, opened)
			) {
				throw new Error(`empty public reference changed while opening: ${referencePath}`);
			}
			const named = fs.lstatSync(referencePath, { bigint: true });
			if (!sameReferenceIdentity(opened, named)) {
				throw new Error(`empty public reference changed before seeding: ${referencePath}`);
			}
			fs.linkSync(referencePath, transactionPath);
			fsyncReferenceDirectory(referencePath);
			transaction = fs.lstatSync(transactionPath, { bigint: true });
			opened = fs.fstatSync(descriptor, { bigint: true });
			if (
				transaction.nlink !== 2n ||
				opened.nlink !== 2n ||
				!sameReferenceIdentity(transaction, opened)
			) {
				throw new Error(
					`empty-reference seed transaction changed during creation: ${referencePath}`,
				);
			}
		}
		let completed;
		if (recovering) {
			const interruptedContents = readStableReference(descriptor, opened, referencePath);
			if (interruptedContents.length === 0) {
				completed = completeReferenceWrite(descriptor, opened, contents, referencePath);
			} else if (interruptedContents.equals(contents)) {
				completed = attestExactReferenceContents(descriptor, opened, contents, referencePath);
			} else {
				throw new Error(
					`interrupted empty-reference seed contains ambiguous nonempty text; preserving it: ${referencePath}`,
				);
			}
		} else {
			completed = completeReferenceWrite(descriptor, opened, contents, referencePath);
		}
		const transactionBeforeUnlink = fs.lstatSync(transactionPath, { bigint: true });
		const namedBeforeUnlink = fs.lstatSync(referencePath, { bigint: true });
		if (
			completed.nlink !== 2n ||
			!sameReferenceIdentity(completed, transactionBeforeUnlink) ||
			!sameReferenceIdentity(completed, namedBeforeUnlink)
		) {
			throw new Error(`empty-reference seed transaction changed before cleanup: ${referencePath}`);
		}
		fs.unlinkSync(transactionPath);
		fsyncReferenceDirectory(referencePath);
		const seeded = fs.fstatSync(descriptor, { bigint: true });
		const named = fs.lstatSync(referencePath, { bigint: true });
		if (
			seeded.nlink !== 1n ||
			named.nlink !== 1n ||
			!sameReferenceIdentity(completed, seeded) ||
			!sameReferenceIdentity(seeded, named)
		) {
			throw new Error(
				`seeded public reference did not return to one stable name: ${referencePath}`,
			);
		}
		return true;
	} finally {
		fs.closeSync(descriptor);
	}
}

export function writeDraftReference(referencePath, draft, options = {}) {
	ensurePrivateDirectory(path.dirname(referencePath), 'public reference directory');
	const contents = Buffer.from(draft, 'utf8');
	if (publishNewDraftReference(referencePath, contents)) return true;
	const expected = fs.lstatSync(referencePath, { bigint: true, throwIfNoEntry: false });
	const seedTransaction = emptySeedTransactionPath(referencePath, contents);
	const interruptedSeed = fs.lstatSync(seedTransaction, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (interruptedSeed) {
		if (!options.seedEmpty || contents.length === 0 || !expected) {
			throw new Error(`unexpected empty-reference seed transaction: ${referencePath}`);
		}
		return seedExistingEmptyReference(referencePath, expected, contents, options);
	}
	if (!expected || !safeReferenceStatus(expected)) {
		throw new Error(`existing public reference must be a regular file: ${referencePath}`);
	}
	if (!options.seedEmpty || expected.size !== 0n || contents.length === 0) {
		return false;
	}
	return seedExistingEmptyReference(referencePath, expected, contents, options);
}

function artifactMaps(catalog, cacheRoot) {
	const artifactById = new Map(catalog.artifacts.map((artifact) => [artifact.id, artifact]));
	const sourceById = new Map(catalog.sources.map((source) => [source.id, source]));
	const pathByArtifactId = new Map(
		catalog.artifacts.map((artifact) => [artifact.id, artifactCachePath(cacheRoot, artifact)]),
	);
	return { artifactById, sourceById, pathByArtifactId };
}

function sourceArtifacts(source, maps) {
	return source.artifact_ids.map((artifactId) => ({
		artifact: maps.artifactById.get(artifactId),
		path: maps.pathByArtifactId.get(artifactId),
	}));
}

function archiveMemberByBasename(entries, filename) {
	const matches = entries.filter(
		(entry) => entry.type === 'file' && path.posix.basename(entry.path) === filename,
	);
	if (matches.length !== 1) {
		throw new Error(
			`archive must contain exactly one regular '${filename}' member, found ${matches.length}`,
		);
	}
	return matches[0].path;
}

export function publishExtractedDirectory(staging, destination, expectedMembers) {
	const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
	if (!existing) {
		fs.renameSync(staging, destination);
		return destination;
	}
	if (!existing.isDirectory() || existing.isSymbolicLink()) {
		throw new Error(`existing extraction target must be a regular directory: ${destination}`);
	}
	assertExtractedTree(destination);
	for (const member of expectedMembers) {
		const expectedPath = resolveInside(destination, member, 'extracted archive member');
		const stagedPath = resolveInside(staging, member, 'staged archive member');
		const entry = fs.lstatSync(expectedPath, { throwIfNoEntry: false });
		if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
			throw new Error(`existing extraction is missing a safe member: ${member}`);
		}
		if (fileSha256(expectedPath) !== fileSha256(stagedPath)) {
			throw new Error(`existing extraction differs from the pinned archive member: ${member}`);
		}
	}
	fs.rmSync(staging, { recursive: true });
	return destination;
}

function extractPinnedMembers(artifact, archivePath, members, extractionRoot, options = {}) {
	verifyPinnedArtifactFile(archivePath, artifact);
	const entries = listArchiveEntries(archivePath, artifact.archive_format);
	verifyPinnedArtifactFile(archivePath, artifact);
	const normalizedMembers = [...new Set(members)].sort();
	const staging = `${extractionRoot}.staging-${process.pid}-${randomUUID()}`;
	ensurePrivateDirectory(path.dirname(extractionRoot), 'public source extraction root');
	try {
		extractArchiveMembers(archivePath, artifact.archive_format, staging, normalizedMembers, {
			entries,
			maximumExtractedBytes: options.maximumExtractedBytes,
			maximumMemberBytes: options.maximumMemberBytes,
		});
		verifyPinnedArtifactFile(archivePath, artifact);
		return publishExtractedDirectory(staging, extractionRoot, normalizedMembers);
	} catch (error) {
		if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
		throw error;
	}
}

function concatFleursAudio(ffmpegPath, itemPaths, gapSeconds, destination) {
	const inputArgs = itemPaths.flatMap((itemPath) => ['-i', itemPath]);
	const filters = [];
	for (const index of itemPaths.keys()) {
		const padding = index < itemPaths.length - 1 ? `,apad=pad_dur=${gapSeconds}` : '';
		filters.push(
			`[${index}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono${padding}[a${index}]`,
		);
	}
	filters.push(
		`${itemPaths.map((_, index) => `[a${index}]`).join('')}concat=n=${itemPaths.length}:v=0:a=1[out]`,
	);
	return generatedWav(ffmpegPath, destination, [
		...inputArgs,
		'-filter_complex',
		filters.join(';'),
		'-map',
		'[out]',
		'-ar',
		'16000',
		'-ac',
		'1',
		'-c:a',
		'pcm_s16le',
	]);
}

export function measureMeanVolumeDb(ffmpegPath, audioPath) {
	const result = spawnSync(
		ffmpegPath,
		['-hide_banner', '-nostdin', '-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-'],
		{ encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
	);
	if (result.error || result.status !== 0) {
		throw new Error(`FFmpeg volume measurement failed for ${audioPath}`);
	}
	const matches = [...result.stderr.matchAll(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/g)];
	const value = Number(matches.at(-1)?.[1]);
	if (!Number.isFinite(value))
		throw new Error(`FFmpeg did not report mean volume for ${audioPath}`);
	return value;
}

export function noiseGainForSnr(speechMeanDb, noiseMeanDb, targetSnrDb = 10) {
	if (![speechMeanDb, noiseMeanDb, targetSnrDb].every(Number.isFinite) || targetSnrDb <= 0) {
		throw new Error('SNR gain calculation requires finite levels and a positive target');
	}
	return speechMeanDb - noiseMeanDb - targetSnrDb;
}

function officeTransform(ffmpegPath, cleanPath, durationSeconds, seed, destination) {
	const token = `${process.pid}-${randomUUID()}`;
	const speechPath = path.join(path.dirname(destination), `.office-speech-${token}.wav`);
	const noisePath = path.join(path.dirname(destination), `.office-noise-${token}.wav`);
	try {
		runFfmpeg(
			ffmpegPath,
			[
				'-i',
				cleanPath,
				'-af',
				'aecho=0.8:0.75:40:0.12',
				'-ar',
				'16000',
				'-ac',
				'1',
				'-c:a',
				'pcm_s16le',
			],
			speechPath,
		);
		runFfmpeg(
			ffmpegPath,
			[
				'-f',
				'lavfi',
				'-i',
				`anoisesrc=c=pink:a=0.25:r=16000:d=${durationSeconds.toFixed(6)}:s=${seed}`,
				'-ar',
				'16000',
				'-ac',
				'1',
				'-c:a',
				'pcm_s16le',
			],
			noisePath,
		);
		const speechMeanDb = measureMeanVolumeDb(ffmpegPath, speechPath);
		const noiseMeanDb = measureMeanVolumeDb(ffmpegPath, noisePath);
		const noiseGainDb = noiseGainForSnr(speechMeanDb, noiseMeanDb, 10);
		return generatedWav(ffmpegPath, destination, [
			'-i',
			speechPath,
			'-i',
			noisePath,
			'-filter_complex',
			`[1:a]volume=${noiseGainDb.toFixed(4)}dB[noise];` +
				`[0:a][noise]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95,` +
				`atrim=duration=${durationSeconds.toFixed(6)}[out]`,
			'-map',
			'[out]',
			'-ar',
			'16000',
			'-ac',
			'1',
			'-c:a',
			'pcm_s16le',
		]);
	} finally {
		for (const temporary of [speechPath, noisePath]) {
			if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
		}
	}
}

function remoteCallTransform(ffmpegPath, cleanPath, destination) {
	const intermediate = path.join(
		path.dirname(destination),
		`.${path.basename(destination, '.wav')}.mulaw-${process.pid}-${randomUUID()}.wav`,
	);
	try {
		runFfmpeg(
			ffmpegPath,
			['-i', cleanPath, '-ar', '8000', '-ac', '1', '-c:a', 'pcm_mulaw'],
			intermediate,
		);
		return generatedWav(ffmpegPath, destination, [
			'-i',
			intermediate,
			'-af',
			'highpass=f=300,lowpass=f=3400',
			'-ar',
			'16000',
			'-ac',
			'1',
			'-c:a',
			'pcm_s16le',
		]);
	} finally {
		if (fs.existsSync(intermediate)) fs.unlinkSync(intermediate);
	}
}

function overlapTransform(ffmpegPath, items, itemPaths, destination) {
	const timings = planOverlapTimings(items);
	const inputArgs = itemPaths.flatMap((itemPath) => ['-i', itemPath]);
	const filters = timings.map(
		(timing, index) =>
			`[${index}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,` +
			`adelay=${Math.round(timing.onsetSeconds * 1000)}:all=1[a${index}]`,
	);
	filters.push(
		`${timings.map((_, index) => `[a${index}]`).join('')}amix=inputs=${timings.length}:` +
			'duration=longest:normalize=0,alimiter=limit=0.95[out]',
	);
	generatedWav(ffmpegPath, destination, [
		...inputArgs,
		'-filter_complex',
		filters.join(';'),
		'-map',
		'[out]',
		'-ar',
		'16000',
		'-ac',
		'1',
		'-c:a',
		'pcm_s16le',
	]);
	return timings;
}

function excerptAudio(ffmpegPath, sourcePath, startSeconds, durationSeconds, destination) {
	return generatedWav(ffmpegPath, destination, [
		'-ss',
		startSeconds.toFixed(6),
		'-i',
		sourcePath,
		'-t',
		durationSeconds.toFixed(6),
		'-ar',
		'16000',
		'-ac',
		'1',
		'-c:a',
		'pcm_s16le',
	]);
}

function relativeWorkspacePath(workspace, absolutePath) {
	return path.relative(workspace, absolutePath).split(path.sep).join('/');
}

function preparedSample(sample, workspace, audioPath, referencePath, provenance, extra = {}) {
	return {
		id: sample.id,
		...(sample.session_id ? { session_id: sample.session_id } : {}),
		audio_path: relativeWorkspacePath(workspace, audioPath),
		audio_sha256: fileSha256(audioPath),
		reference_path: relativeWorkspacePath(workspace, referencePath),
		language: sample.language,
		whisper_language: sample.whisper_language,
		scenario: sample.scenario,
		noise_condition: sample.noise_condition,
		speakers: sample.speakers,
		duration_seconds: wavDurationSeconds(audioPath),
		provenance,
		...extra,
	};
}

function prepareFleursSources(context) {
	const samples = [];
	const fleurs = context.selection.fleurs;
	for (const sourceSelection of fleurs.sources) {
		const source = context.maps.sourceById.get(sourceSelection.source_id);
		const artifacts = sourceArtifacts(source, context.maps);
		const archiveEntry = artifacts.find(({ artifact }) => artifact.kind === 'audio-archive');
		const indexEntry = artifacts.find(({ artifact }) => artifact.kind === 'index');
		if (!archiveEntry || !indexEntry) {
			throw new Error(`FLEURS source '${source.id}' must have one audio archive and one index`);
		}
		verifyPinnedArtifactFile(indexEntry.path, indexEntry.artifact);
		const rows = parseFleursTsv(fs.readFileSync(indexEntry.path));
		const composites = selectFleursComposites(rows, {
			count: fleurs.composites_per_language,
			minimumSeconds: fleurs.minimum_seconds,
			targetSeconds: fleurs.target_seconds,
			maximumSeconds: fleurs.maximum_seconds,
			gapSeconds: fleurs.inter_utterance_gap_seconds,
		});
		for (const [index, composite] of composites.entries()) {
			const commitment = sourceSelection.composites[index];
			const overlap = planOverlapTimings(composite.items);
			const overlapDuration = overlap.at(-1).onsetSeconds + overlap.at(-1).durationSeconds;
			if (
				commitment.member_count !== composite.items.length ||
				commitment.ordered_members_sha256 !==
					sha256Text(JSON.stringify(composite.items.map((item) => item.filename))) ||
				Math.abs(commitment.clean_duration_seconds - composite.durationSeconds) > 0.000001 ||
				Math.abs(commitment.overlap_duration_seconds - overlapDuration) > 0.000001
			) {
				throw new Error(
					`FLEURS source '${source.id}' composite ${index + 1} does not match its committed member and duration selection`,
				);
			}
		}
		verifyPinnedArtifactFile(archiveEntry.path, archiveEntry.artifact);
		const archiveEntries = listArchiveEntries(
			archiveEntry.path,
			archiveEntry.artifact.archive_format,
		);
		verifyPinnedArtifactFile(archiveEntry.path, archiveEntry.artifact);
		const memberByFilename = new Map();
		for (const composite of composites) {
			for (const item of composite.items) {
				memberByFilename.set(item.filename, archiveMemberByBasename(archiveEntries, item.filename));
			}
		}
		const extractionRoot = path.join(context.workspace, 'sources', source.id);
		extractPinnedMembers(
			archiveEntry.artifact,
			archiveEntry.path,
			[...memberByFilename.values()],
			extractionRoot,
			{
				maximumExtractedBytes: composites
					.flatMap((composite) => composite.items)
					// Pinned FLEURS WAV members use 32-bit samples; retain a small bounded
					// allowance for RIFF metadata around the committed TSV sample count.
					.reduce((total, item) => total + item.sampleCount * 4 + 4096, 0),
				maximumMemberBytes: 64 * 1024 * 1024,
			},
		);

		for (const [index, composite] of composites.entries()) {
			const commitment = sourceSelection.composites[index];
			const baseId = `${sourceSelection.whisper_language}-fleurs-${String(index + 1).padStart(2, '0')}`;
			const itemPaths = composite.items.map((item) =>
				resolveInside(extractionRoot, memberByFilename.get(item.filename), 'FLEURS audio member'),
			);
			const referencePath = path.join(context.workspace, 'references', `${baseId}.txt`);
			writeDraftReference(
				referencePath,
				`${composite.items.map((item) => item.transcript.trim()).join(' ')}\n`,
			);
			const cleanPath = path.join(context.workspace, 'audio', `${baseId}-clean-read.wav`);
			concatFleursAudio(
				context.ffmpegPath,
				itemPaths,
				fleurs.inter_utterance_gap_seconds,
				cleanPath,
			);
			const cleanDuration = wavDurationSeconds(cleanPath);
			if (cleanDuration < fleurs.minimum_seconds || cleanDuration > fleurs.maximum_seconds + 0.01) {
				throw new Error(
					`generated ${baseId} duration ${cleanDuration} is outside the committed FLEURS bounds`,
				);
			}
			const outputByCondition = new Map([['clean-read', cleanPath]]);
			const officePath = path.join(context.workspace, 'audio', `${baseId}-synthetic-office.wav`);
			const seed = Number.parseInt(sha256Text(baseId).slice(0, 8), 16) % 2_147_483_647;
			officeTransform(context.ffmpegPath, cleanPath, cleanDuration, seed, officePath);
			outputByCondition.set('synthetic-office', officePath);
			const remotePath = path.join(
				context.workspace,
				'audio',
				`${baseId}-synthetic-remote-call.wav`,
			);
			remoteCallTransform(context.ffmpegPath, cleanPath, remotePath);
			outputByCondition.set('synthetic-remote-call', remotePath);
			const overlapPath = path.join(context.workspace, 'audio', `${baseId}-synthetic-overlap.wav`);
			overlapTransform(context.ffmpegPath, composite.items, itemPaths, overlapPath);
			outputByCondition.set('synthetic-overlap', overlapPath);

			const sourceItemIds = composite.items.map((item) => `${source.id}:${item.filename}`);
			for (const condition of fleurs.conditions) {
				const expectedDurationSeconds =
					condition.id === 'synthetic-overlap'
						? commitment.overlap_duration_seconds
						: commitment.clean_duration_seconds;
				const sampleDefinition = {
					id: `${baseId}-${condition.id}`,
					language: sourceSelection.language,
					whisper_language: sourceSelection.whisper_language,
					scenario: 'read-speech',
					noise_condition: condition.id,
					speakers: condition.speakers,
				};
				const conditionAudioPath = outputByCondition.get(condition.id);
				if (fileSha256(conditionAudioPath) !== commitment.audio_sha256[condition.id]) {
					throw new Error(
						`generated ${baseId}-${condition.id} does not match its committed deterministic output hash`,
					);
				}
				samples.push(
					preparedSample(
						sampleDefinition,
						context.workspace,
						conditionAudioPath,
						referencePath,
						{
							basis: 'public-license',
							redistribution: 'local-only',
							source_catalog_id: context.catalog.catalog_id,
							source_item_ids: sourceItemIds,
							transform_id: condition.transform_id,
						},
						{
							dataset: 'fleurs',
							source_window: {
								strategy: 'committed-fleurs-composite',
								composite_index: index + 1,
								gap_seconds: fleurs.inter_utterance_gap_seconds,
								member_count: commitment.member_count,
								ordered_members_sha256: commitment.ordered_members_sha256,
								expected_duration_seconds: expectedDurationSeconds,
							},
						},
					),
				);
			}
		}
	}
	return samples;
}

function amiMeetingId(sample) {
	const match = /^ami:([A-Z0-9a-z]+)$/.exec(sample.source_item_id);
	if (!match) throw new Error(`AMI source item '${sample.source_item_id}' is invalid`);
	return match[1];
}

function prepareAmiSources(context, amiSamples) {
	if (amiSamples.length === 0) return [];
	const annotationArtifact = context.catalog.artifacts.find(
		(artifact) => artifact.id === 'ami-manual-annotations-v1-6-2',
	);
	const annotationPath = context.maps.pathByArtifactId.get(annotationArtifact.id);
	verifyPinnedArtifactFile(annotationPath, annotationArtifact);
	const entries = listArchiveEntries(annotationPath, annotationArtifact.archive_format);
	verifyPinnedArtifactFile(annotationPath, annotationArtifact);
	const membersByMeeting = new Map();
	for (const sample of amiSamples) {
		const meetingId = amiMeetingId(sample);
		const expression = new RegExp(`^words/${meetingId}\\.([A-Z])\\.words\\.xml$`);
		const members = entries
			.filter((entry) => entry.type === 'file' && expression.test(entry.path))
			.map((entry) => entry.path)
			.sort();
		if (members.length < 2) {
			throw new Error(`AMI annotations contain too few speakers for ${meetingId}`);
		}
		membersByMeeting.set(meetingId, members);
	}
	const extractionRoot = path.join(context.workspace, 'sources', 'ami-manual-annotations-v1-6-2');
	extractPinnedMembers(
		annotationArtifact,
		annotationPath,
		[...membersByMeeting.values()].flat(),
		extractionRoot,
		{ maximumExtractedBytes: 256 * 1024 * 1024, maximumMemberBytes: 32 * 1024 * 1024 },
	);

	const prepared = [];
	for (const sample of amiSamples) {
		const source = context.maps.sourceById.get(sample.source_id);
		const audioEntry = sourceArtifacts(source, context.maps).find(
			({ artifact }) => artifact.kind === 'audio',
		);
		if (!audioEntry) throw new Error(`AMI source '${source.id}' is missing its audio artifact`);
		verifyPinnedArtifactFile(audioEntry.path, audioEntry.artifact);
		const meetingId = amiMeetingId(sample);
		const documents = membersByMeeting.get(meetingId).map((member) => {
			const match = /\.([A-Z])\.words\.xml$/.exec(member);
			return {
				speakerId: match[1],
				content: fs.readFileSync(resolveInside(extractionRoot, member, 'AMI word document')),
			};
		});
		const words = parseAmiWordDocuments(documents);
		const window = selectDensestTimedWindow(
			words,
			sample.duration_seconds,
			sample.window.grid_seconds,
		);
		const reference = renderTimedReference(words, window.start, window.end);
		if (reference.trim().length === 0) {
			throw new Error(`AMI dense window for ${meetingId} produced an empty draft reference`);
		}
		const activeSpeakers = new Set(
			window.words.filter((word) => !word.punctuation).map((word) => word.speakerId),
		).size;
		if (activeSpeakers < 2) {
			throw new Error(`AMI dense window for ${meetingId} must contain at least two speakers`);
		}
		const annotationMembers = membersByMeeting.get(meetingId);
		if (
			window.start !== sample.window.expected_start_seconds ||
			window.end !== sample.window.expected_end_seconds ||
			window.wordCount !== sample.window.expected_word_count ||
			activeSpeakers !== sample.speakers ||
			annotationMembers.length !== sample.window.annotation_member_count ||
			sha256Text(JSON.stringify(annotationMembers)) !==
				sample.window.ordered_annotation_members_sha256
		) {
			throw new Error(
				`AMI dense window for ${meetingId} does not match the committed window, speaker, or annotation selection`,
			);
		}
		const referencePath = path.join(context.workspace, 'references', `${sample.id}.txt`);
		writeDraftReference(referencePath, reference);
		const audioPath = path.join(context.workspace, 'audio', `${sample.id}.wav`);
		excerptAudio(
			context.ffmpegPath,
			audioEntry.path,
			window.start,
			sample.duration_seconds,
			audioPath,
		);
		if (fileSha256(audioPath) !== sample.audio_sha256) {
			throw new Error(
				`generated ${sample.id} does not match its committed deterministic output hash`,
			);
		}
		prepared.push(
			preparedSample(
				{
					...sample,
					session_id: `session-${source.id}`,
					speakers: activeSpeakers,
				},
				context.workspace,
				audioPath,
				referencePath,
				{
					basis: 'public-license',
					redistribution: 'local-only',
					source_catalog_id: context.catalog.catalog_id,
					source_item_ids: [sample.source_item_id],
					transform_id: sample.transform_id,
				},
				{
					dataset: 'ami',
					source_window: {
						strategy: sample.window.strategy,
						start_seconds: window.start,
						end_seconds: window.end,
						boundary_policy: 'exclude-crossing-words',
						word_count: window.wordCount,
						annotation_member_count: annotationMembers.length,
						ordered_annotation_members_sha256: sample.window.ordered_annotation_members_sha256,
					},
				},
			),
		);
	}
	return prepared;
}

function prepareEarningsSources(context, earningsSamples) {
	const prepared = [];
	for (const sample of earningsSamples) {
		const source = context.maps.sourceById.get(sample.source_id);
		const artifacts = sourceArtifacts(source, context.maps);
		const audioEntry = artifacts.find(({ artifact }) => artifact.kind === 'audio');
		const referenceEntry = artifacts.find(({ artifact }) => artifact.kind === 'reference');
		const alignmentEntry = artifacts.find(
			({ artifact }) => artifact.kind === 'alignment-hypothesis',
		);
		if (!audioEntry || !referenceEntry || !alignmentEntry) {
			throw new Error(
				`Earnings-21 source '${source.id}' must have audio, a human reference, and a timed alignment hypothesis`,
			);
		}
		verifyPinnedArtifactFile(audioEntry.path, audioEntry.artifact);
		verifyPinnedArtifactFile(referenceEntry.path, referenceEntry.artifact);
		verifyPinnedArtifactFile(alignmentEntry.path, alignmentEntry.artifact);
		const startSeconds = sample.window.start_seconds;
		const endSeconds = startSeconds + sample.duration_seconds;
		const audioPath = path.join(context.workspace, 'audio', `${sample.id}.wav`);
		excerptAudio(
			context.ffmpegPath,
			audioEntry.path,
			startSeconds,
			sample.duration_seconds,
			audioPath,
		);
		if (fileSha256(audioPath) !== sample.audio_sha256) {
			throw new Error(
				`generated ${sample.id} does not match its committed deterministic output hash`,
			);
		}
		const alignedReference = deriveEarningsReferenceExcerpt(
			fs.readFileSync(referenceEntry.path),
			fs.readFileSync(alignmentEntry.path),
			{
				startSeconds,
				endSeconds,
				contextSeconds: sample.window.alignment_context_seconds,
			},
		);
		const expectedAlignment = {
			hypothesisTokens: sample.window.expected_alignment_hypothesis_tokens,
			alignedReferenceTokens: sample.window.expected_alignment_reference_tokens,
			editDistance: sample.window.expected_alignment_edit_distance,
			referenceStartTokenIndex: sample.window.expected_reference_start_token_index,
			referenceEndTokenIndex: sample.window.expected_reference_end_token_index,
			referenceTokenCount: sample.window.expected_reference_token_count,
			referenceSeedSha256: sample.window.expected_reference_seed_sha256,
		};
		for (const [field, expected] of Object.entries(expectedAlignment)) {
			if (alignedReference[field] !== expected) {
				throw new Error(
					`Earnings-21 aligned reference '${sample.id}' ${field} drifted: expected ${expected}, got ${alignedReference[field]}`,
				);
			}
		}
		const referencePath = path.join(context.workspace, 'references', `${sample.id}.txt`);
		writeDraftReference(referencePath, alignedReference.text, { seedEmpty: true });
		const contextPath = path.join(
			context.workspace,
			'review-context',
			`${sample.id}-upstream-full-transcript.txt`,
		);
		writeDraftReference(contextPath, renderEarningsContext(fs.readFileSync(referenceEntry.path)));
		prepared.push(
			preparedSample(
				{ ...sample, dataset: 'earnings21' },
				context.workspace,
				audioPath,
				referencePath,
				{
					basis: 'public-license',
					redistribution: 'local-only',
					source_catalog_id: context.catalog.catalog_id,
					source_item_ids: [sample.source_item_id],
					transform_id: sample.transform_id,
				},
				{
					dataset: 'earnings21',
					source_window: {
						strategy: 'fixed',
						start_seconds: startSeconds,
						end_seconds: endSeconds,
						boundary_policy: 'exclude-crossing-anchor-words',
						reference_policy: 'public-human-reference-aligned-to-pinned-timed-hypothesis',
						alignment_artifact_id: alignmentEntry.artifact.id,
						alignment_context_seconds: sample.window.alignment_context_seconds,
						alignment_hypothesis_tokens: alignedReference.hypothesisTokens,
						alignment_reference_tokens: alignedReference.alignedReferenceTokens,
						alignment_edit_distance: alignedReference.editDistance,
						reference_start_token_index: alignedReference.referenceStartTokenIndex,
						reference_end_token_index: alignedReference.referenceEndTokenIndex,
						reference_token_count: alignedReference.referenceTokenCount,
						reference_seed_sha256: alignedReference.referenceSeedSha256,
					},
				},
			),
		);
	}
	return prepared;
}

export async function preparePublicCorpusUnlocked(options) {
	assertPublicCorpusLockOwned(options.lock);
	assertWorkspaceIsUntracked(options.workspace);
	const workspace = ensurePrivateDirectory(options.workspace, 'public corpus workspace');
	assertWorkspaceIsUntracked(workspace);
	const { catalog, selection } = loadPublicCorpusConfig(options.catalogPath, options.selectionPath);
	const cacheRoot = ensurePrivateDirectory(path.join(workspace, 'cache'), 'public corpus cache');
	const diskRequirement = calculatePreparationDiskRequirement(
		catalog,
		cacheRoot,
		options.minimumFreeBytes ?? selection.minimum_free_bytes,
	);
	requireFreeSpace(workspace, diskRequirement);
	await materializeCatalogArtifacts(catalog, cacheRoot, {
		allowNetwork: options.allowNetwork,
		fetchImpl: options.fetchImpl,
	});
	const ffmpeg = resolveApprovedFfmpeg(options.ffmpegPath, selection);
	const ffmpegPath = ffmpeg.executablePath;
	for (const directory of ['audio', 'references', 'review-context', 'sources']) {
		ensurePrivateDirectory(path.join(workspace, directory), `public corpus ${directory}`);
	}
	const context = {
		workspace,
		catalog,
		selection,
		ffmpegPath,
		maps: artifactMaps(catalog, cacheRoot),
	};
	const samples = [
		...prepareFleursSources(context),
		...prepareAmiSources(
			context,
			selection.natural_samples.filter((sample) => sample.source_id.startsWith('ami-')),
		),
		...prepareEarningsSources(
			context,
			selection.natural_samples.filter((sample) => sample.source_id.startsWith('earnings21-')),
		),
	].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	if (samples.length !== 66) {
		throw new Error(
			`public corpus preparation must create exactly 66 samples, got ${samples.length}`,
		);
	}
	const sampleIds = new Set(samples.map((sample) => sample.id));
	if (sampleIds.size !== samples.length)
		throw new Error('public corpus preparation produced duplicate IDs');
	const prepared = {
		schema_version: PUBLIC_PREPARED_SCHEMA_VERSION,
		corpus_id: selection.corpus_id,
		source_catalog_id: catalog.catalog_id,
		source_catalog_sha256: fileSha256(options.catalogPath),
		selection_sha256: fileSha256(options.selectionPath),
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
		ffmpeg: {
			id: ffmpeg.id,
			executable_path: ffmpeg.executablePath,
			sha256: ffmpeg.sha256,
			version: ffmpeg.version,
		},
		samples,
	};
	assertPublicCorpusLockOwned(options.lock);
	const bundle = writePreparedBundle(workspace, prepared);
	return {
		...bundle,
		workspace,
		sampleCount: samples.length,
		alignedReferenceSeedCount: samples.filter((sample) => sample.dataset === 'earnings21').length,
	};
}

export async function preparePublicCorpus(options) {
	assertWorkspaceIsUntracked(options.workspace);
	const workspace = ensurePrivateDirectory(options.workspace, 'public corpus workspace');
	assertWorkspaceIsUntracked(workspace);
	const lock = acquirePreparationLock(workspace);
	try {
		return await preparePublicCorpusUnlocked({ ...options, workspace, lock });
	} finally {
		releasePreparationLock(lock);
	}
}

async function main() {
	try {
		const options = parsePublicPrepareArgs(process.argv.slice(2));
		if (options.help) {
			process.stdout.write(usage());
			return;
		}
		const result = await preparePublicCorpus(options);
		process.stdout.write(
			`Prepared ${result.sampleCount} public ASR samples in ${result.workspace}.\n` +
				`Seeded ${result.alignedReferenceSeedCount} Earnings-21 drafts from aligned public human references.\n` +
				`Complete two independent reviews in ${result.reviewsPath}, then run public-corpus-finalize.ts.\n`,
		);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main();
}
