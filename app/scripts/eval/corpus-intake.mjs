#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileSha256, validateCorpusDocument } from './corpus.mjs';

const TARGET_LANGUAGES = new Set(['en', 'es', 'pt', 'fr', 'de']);
const TARGET_NOISE_CONDITIONS = new Set(['clean', 'office', 'remote-call', 'overlapping-speech']);
const REQUIRED_OPTIONS = [
	'audio',
	'reference',
	'sampleId',
	'sessionId',
	'consentRecordId',
	'consentRecord',
	'consentDate',
	'language',
	'noiseCondition',
	'speakers',
];

function ensureFile(filePath, label) {
	if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(`${label} does not exist or is not a file: ${filePath}`);
	}
}

export function localCalendarDate(date = new Date()) {
	const year = String(date.getFullYear()).padStart(4, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function processIsRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== 'ESRCH';
	}
}

function removeAbandonedManifestFiles(manifestPath) {
	const directory = path.dirname(manifestPath);
	const prefix = `${path.basename(manifestPath)}.tmp-`;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (
			entry.isFile() &&
			entry.name.startsWith(prefix) &&
			/\.tmp-\d+-[0-9a-f-]+$/.test(entry.name)
		) {
			fs.rmSync(path.join(directory, entry.name), { force: true });
		}
	}
}

function removeAbandonedResultFiles(manifestPath) {
	const removeFrom = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				removeFrom(entryPath);
				continue;
			}
			if (entry.isFile() && /\.tmp-\d+-[0-9a-f-]{36}$/.test(entry.name)) {
				fs.rmSync(entryPath, { force: true });
			}
		}
	};
	const resultsDirectory = path.join(path.dirname(manifestPath), 'results');
	const resultsEntry = fs.lstatSync(resultsDirectory, { throwIfNoEntry: false });
	if (!resultsEntry?.isDirectory() || resultsEntry.isSymbolicLink()) return;
	removeFrom(resultsDirectory);
}

function writePrivateJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function prepareIntakeLock(localCorpusRoot) {
	const token = randomUUID();
	const pendingPath = path.join(localCorpusRoot, `.intake.lock.pending-${token}`);
	fs.mkdirSync(pendingPath, { mode: 0o700 });
	try {
		writePrivateJson(path.join(pendingPath, 'owner.json'), {
			schema_version: 2,
			pid: process.pid,
			token,
			created_at: new Date().toISOString(),
		});
		return { pendingPath, token };
	} catch (error) {
		fs.rmSync(pendingPath, { recursive: true, force: true });
		throw error;
	}
}

function readLockOwner(lockPath) {
	const status = fs.lstatSync(lockPath);
	const ownerPath = status.isDirectory() ? path.join(lockPath, 'owner.json') : lockPath;
	const contents = fs.readFileSync(ownerPath, 'utf8');
	const owner = JSON.parse(contents);
	if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('lock owner PID is invalid');
	const key =
		typeof owner.token === 'string' && /^[0-9a-f-]{36}$/.test(owner.token)
			? owner.token
			: `legacy-${createHash('sha256').update(contents).digest('hex')}`;
	return { owner, key };
}

function removeAbandonedStagedFiles(directory, isRoot = true) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (isRoot && entry.name.startsWith('.')) continue;
		const entryPath = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			removeAbandonedStagedFiles(entryPath, false);
			if (fs.readdirSync(entryPath).length === 0) fs.rmdirSync(entryPath);
			continue;
		}
		if (/\.tmp-\d+-[0-9a-f-]+$/.test(entry.name)) {
			fs.rmSync(entryPath, { force: true });
		}
	}
}

export function hasPendingWithdrawal(localCorpusRoot) {
	return fs
		.readdirSync(localCorpusRoot, { withFileTypes: true })
		.some(
			(entry) =>
				entry.isFile() && /^\.withdrawal-session-[a-z0-9][a-z0-9-]*\.json$/.test(entry.name),
		);
}

function recoverInterruptedIntakes(localCorpusRoot, manifestPath, stalePaths) {
	const unrecovered = stalePaths.filter((stalePath) => !fs.existsSync(`${stalePath}.recovered`));
	if (unrecovered.length === 0) return;
	removeAbandonedStagedFiles(localCorpusRoot);
	removeAbandonedManifestFiles(manifestPath);
	removeAbandonedResultFiles(manifestPath);
	for (const stalePath of unrecovered) {
		writePrivateJson(`${stalePath}.recovered`, {
			recovered_at: new Date().toISOString(),
			recovered_by_pid: process.pid,
		});
	}
}

function stageOrReuseFile(sourcePath, targetPath, stagedPath, label) {
	const targetEntry = fs.lstatSync(targetPath, { throwIfNoEntry: false });
	if (targetEntry) {
		if (!targetEntry.isFile() || targetEntry.isSymbolicLink()) {
			throw new Error(`intake ${label} target is not a regular file: ${targetPath}`);
		}
		if (fileSha256(sourcePath) !== fileSha256(targetPath)) {
			throw new Error(`intake ${label} target already exists with different contents: ${targetPath}`);
		}
		fs.chmodSync(targetPath, 0o600);
		return { workingPath: targetPath, staged: false };
	}
	fs.copyFileSync(sourcePath, stagedPath);
	fs.chmodSync(stagedPath, 0o600);
	return { workingPath: stagedPath, staged: true };
}

export function acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath) {
	const prepared = prepareIntakeLock(localCorpusRoot);
	try {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			let installed = false;
			try {
				fs.renameSync(prepared.pendingPath, lockPath);
				installed = true;
			} catch (error) {
				if (!fs.existsSync(lockPath)) {
					if (error.code === 'ENOENT' || error.code === 'EEXIST' || error.code === 'ENOTEMPTY') {
						continue;
					}
					throw error;
				}
			}
			if (installed) {
				try {
					const stalePaths = fs
						.readdirSync(localCorpusRoot)
						.filter(
							(name) =>
								name.startsWith('.intake.lock.stale-') && !name.endsWith('.recovered'),
						)
						.map((name) => path.join(localCorpusRoot, name));
					recoverInterruptedIntakes(localCorpusRoot, manifestPath, stalePaths);
					return prepared.token;
				} catch (error) {
					releaseLocalCorpusLock(lockPath, prepared.token);
					throw error;
				}
			}

			let observed;
			try {
				observed = readLockOwner(lockPath);
			} catch {
				throw new Error(`another corpus intake is active or left an unreadable lock: ${lockPath}`);
			}
			if (processIsRunning(observed.owner.pid)) {
				throw new Error(`another corpus intake is active: ${lockPath}`);
			}
			const stalePath = `${lockPath}.stale-${observed.key}`;
			try {
				fs.renameSync(lockPath, stalePath);
			} catch (error) {
				if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) continue;
				throw error;
			}
		}
		throw new Error(`could not acquire corpus intake lock: ${lockPath}`);
	} catch (error) {
		fs.rmSync(prepared.pendingPath, { recursive: true, force: true });
		throw error;
	}
}

export function releaseLocalCorpusLock(lockPath, token) {
	try {
		const { owner } = readLockOwner(lockPath);
		if (owner.token !== token || owner.pid !== process.pid) return;
	} catch {
		return;
	}
	fs.rmSync(lockPath, { recursive: true, force: true });
}

export function wavDurationSeconds(filePath) {
	const descriptor = fs.openSync(filePath, 'r');
	const fileSize = fs.fstatSync(descriptor).size;
	const header = Buffer.alloc(12);
	try {
		if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
			throw new Error('WAV header is truncated');
		}
		if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
			throw new Error('audio must be a RIFF/WAVE file');
		}

		let offset = 12;
		let byteRate = null;
		let dataBytes = null;
		const chunkHeader = Buffer.alloc(8);
		while (offset + chunkHeader.length <= fileSize) {
			if (
				fs.readSync(descriptor, chunkHeader, 0, chunkHeader.length, offset) !== chunkHeader.length
			) {
				break;
			}
			const chunkId = chunkHeader.toString('ascii', 0, 4);
			const chunkSize = chunkHeader.readUInt32LE(4);
			const chunkStart = offset + chunkHeader.length;
			if (chunkStart + chunkSize > fileSize) throw new Error(`WAV ${chunkId} chunk is truncated`);
			if (chunkId === 'fmt ') {
				if (chunkSize < 16) throw new Error('WAV fmt chunk is invalid');
				const format = Buffer.alloc(16);
				fs.readSync(descriptor, format, 0, format.length, chunkStart);
				byteRate = format.readUInt32LE(8);
				if (byteRate === 0) throw new Error('WAV byte rate must be positive');
			} else if (chunkId === 'data') {
				dataBytes = chunkSize;
			}
			if (byteRate !== null && dataBytes !== null) return dataBytes / byteRate;
			offset = chunkStart + chunkSize + (chunkSize % 2);
		}
		throw new Error('WAV must contain valid fmt and data chunks');
	} finally {
		fs.closeSync(descriptor);
	}
}

function relativeManifestPath(manifestPath, filePath) {
	return path.relative(path.dirname(manifestPath), filePath).split(path.sep).join('/');
}

function readManifest(manifestPath) {
	if (!fs.existsSync(manifestPath)) {
		return {
			schema_version: 2,
			corpus_id: 'consented-meetings-v1',
			description: 'Local-only participant-consented multilingual meeting corpus.',
			distribution: 'local',
			samples: [],
		};
	}
	let document;
	try {
		document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read corpus manifest ${manifestPath}: ${error.message}`);
	}
	const errors = validateCorpusDocument(document, { manifestPath });
	if (errors.length > 0)
		throw new Error(`existing corpus manifest is invalid:\n- ${errors.join('\n- ')}`);
	if (document.distribution !== 'local') throw new Error('intake requires a local corpus manifest');
	return document;
}

function isIsoDate(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

function validateIntakeOptions(options, today) {
	for (const field of REQUIRED_OPTIONS) {
		if (options[field] === undefined || options[field] === null || options[field] === '') {
			const option = field.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
			throw new Error(`--${option} is required`);
		}
	}
	if (!options.affirmConsent) {
		throw new Error('--affirm-all-participants-consented is required');
	}
	if (!Number.isInteger(options.speakers) || options.speakers < 2) {
		throw new Error('--speakers must be an integer of at least 2');
	}
	if (!/^[a-z0-9][a-z0-9-]*$/.test(options.sampleId)) {
		throw new Error('--sample-id must be a lowercase slug');
	}
	if (!/^session-[a-z0-9][a-z0-9-]*$/.test(options.sessionId)) {
		throw new Error('--session-id must be an opaque session-* identifier');
	}
	if (!/^consent-[a-z0-9][a-z0-9-]*$/.test(options.consentRecordId)) {
		throw new Error('--consent-record-id must be an opaque consent-* identifier');
	}
	if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(options.language)) {
		throw new Error('--language must be a BCP-47-style language tag');
	}
	const primaryLanguage = options.language.split('-')[0].toLowerCase();
	if (!TARGET_LANGUAGES.has(primaryLanguage)) {
		throw new Error(`--language must target one of: ${[...TARGET_LANGUAGES].join(', ')}`);
	}
	if (!TARGET_NOISE_CONDITIONS.has(options.noiseCondition)) {
		throw new Error(`--noise-condition must be one of: ${[...TARGET_NOISE_CONDITIONS].join(', ')}`);
	}
	if (!isIsoDate(options.consentDate) || options.consentDate > today) {
		throw new Error('--consent-date must be a valid, non-future YYYY-MM-DD date');
	}
}

export function intakeConsentedSample(options) {
	const today = options.today ?? localCalendarDate();
	validateIntakeOptions(options, today);
	const manifestPath = path.resolve(options.manifestPath);
	const audioSource = path.resolve(options.audio);
	const referenceSource = path.resolve(options.reference);
	const consentRecord = path.resolve(options.consentRecord);
	ensureFile(audioSource, 'audio');
	ensureFile(referenceSource, 'reference');
	ensureFile(consentRecord, 'consent record');
	if (new Set([audioSource, referenceSource, consentRecord]).size !== 3) {
		throw new Error('audio, reference, and consent record must be three distinct files');
	}
	if (fs.statSync(consentRecord).size === 0) throw new Error('consent record must not be empty');
	if (path.extname(audioSource).toLowerCase() !== '.wav') {
		throw new Error('audio must be a .wav file so duration can be verified locally');
	}
	if (fs.readFileSync(referenceSource, 'utf8').trim().length === 0) {
		throw new Error('reference transcript must not be empty');
	}

	const localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
	if (fs.lstatSync(localCorpusRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`intake directory cannot be a symbolic link: ${localCorpusRoot}`);
	}
	fs.mkdirSync(localCorpusRoot, { recursive: true, mode: 0o700 });
	const lockPath = path.join(localCorpusRoot, '.intake.lock');
	const manifestLockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath);

	try {
		const document = readManifest(manifestPath);
		const sessionDirectory = path.join(localCorpusRoot, options.sessionId);
		if (fs.lstatSync(sessionDirectory, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`intake directory cannot be a symbolic link: ${sessionDirectory}`);
		}
		const audioTarget = path.join(sessionDirectory, `${options.sampleId}.wav`);
		const referenceTarget = path.join(sessionDirectory, `${options.sampleId}.txt`);

		const token = `${process.pid}-${randomUUID()}`;
		const stagedAudio = `${audioTarget}.tmp-${token}`;
		const stagedReference = `${referenceTarget}.tmp-${token}`;
		const stagedManifest = `${manifestPath}.tmp-${token}`;
		const createdSessionDirectory = !fs.existsSync(sessionDirectory);
		const promotedFiles = [];
		fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
		try {
			const preparedAudio = stageOrReuseFile(audioSource, audioTarget, stagedAudio, 'audio');
			const preparedReference = stageOrReuseFile(
				referenceSource,
				referenceTarget,
				stagedReference,
				'reference',
			);
			const sample = {
				id: options.sampleId,
				session_id: options.sessionId,
				audio_path: relativeManifestPath(manifestPath, audioTarget),
				audio_sha256: fileSha256(preparedAudio.workingPath),
				reference_path: relativeManifestPath(manifestPath, referenceTarget),
				reference_sha256: fileSha256(preparedReference.workingPath),
				language: options.language,
				scenario: 'meeting',
				noise_condition: options.noiseCondition,
				speakers: options.speakers,
				duration_seconds: wavDurationSeconds(preparedAudio.workingPath),
				provenance: {
					basis: 'participant-consent',
					consent_record_id: options.consentRecordId,
					consent_date: options.consentDate,
					consented_uses: ['asr-benchmarking'],
					redistribution: 'local-only',
				},
			};
			const nextDocument = { ...document, samples: [...document.samples, sample] };
			const structuralErrors = validateCorpusDocument(nextDocument, {
				manifestPath,
				checkFiles: false,
			});
			if (structuralErrors.length > 0) {
				throw new Error(
					`intake would create an invalid corpus:\n- ${structuralErrors.join('\n- ')}`,
				);
			}

			if (preparedAudio.staged) {
				fs.renameSync(stagedAudio, audioTarget);
				promotedFiles.push(audioTarget);
			}
			if (preparedReference.staged) {
				fs.renameSync(stagedReference, referenceTarget);
				promotedFiles.push(referenceTarget);
			}
			const fileErrors = validateCorpusDocument(nextDocument, { manifestPath });
			if (fileErrors.length > 0) {
				throw new Error(`intake would create an invalid corpus:\n- ${fileErrors.join('\n- ')}`);
			}
			fs.writeFileSync(stagedManifest, `${JSON.stringify(nextDocument, null, 2)}\n`, {
				mode: 0o600,
			});
			fs.renameSync(stagedManifest, manifestPath);
			return sample;
		} catch (error) {
			for (const file of [stagedAudio, stagedReference, stagedManifest, ...promotedFiles]) {
				fs.rmSync(file, { force: true });
			}
			if (createdSessionDirectory) fs.rmSync(sessionDirectory, { recursive: true, force: true });
			throw error;
		}
	} finally {
		releaseLocalCorpusLock(lockPath, manifestLockToken);
	}
}

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
	return value;
}

export function parseIntakeArgs(args, defaultManifestPath) {
	const options = { manifestPath: defaultManifestPath, affirmConsent: false };
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (option === '--affirm-all-participants-consented') {
			options.affirmConsent = true;
			continue;
		}
		const fields = {
			'--manifest': 'manifestPath',
			'--audio': 'audio',
			'--reference': 'reference',
			'--sample-id': 'sampleId',
			'--session-id': 'sessionId',
			'--consent-record-id': 'consentRecordId',
			'--consent-record': 'consentRecord',
			'--consent-date': 'consentDate',
			'--language': 'language',
			'--noise-condition': 'noiseCondition',
			'--speakers': 'speakers',
		};
		const field = fields[option];
		if (!field) throw new Error(`unknown option: ${option}`);
		options[field] = requiredValue(args, index, option);
		index += 1;
	}
	if (options.speakers !== undefined) options.speakers = Number(options.speakers);
	return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const options = parseIntakeArgs(process.argv.slice(2), path.join(here, 'corpus-local.json'));
		const sample = intakeConsentedSample(options);
		console.log(
			`added ${sample.id}: ${sample.language} / ${sample.noise_condition}, ` +
				`${sample.duration_seconds.toFixed(1)}s, ${sample.speakers} speakers`,
		);
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
}
