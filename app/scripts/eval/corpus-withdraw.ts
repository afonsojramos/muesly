#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	acquireLocalCorpusLock,
	completeLocalCorpusWithdrawalRecovery,
	markLocalCorpusOrphanCleanup,
	markLocalCorpusWithdrawalCommitted,
	releaseLocalCorpusLock,
} from './corpus-intake.ts';
import {
	preparedBundleForWithdrawal,
	retirePreparedBundle,
	retirePreparedBundleForWithdrawal,
} from './corpus-prepared-bundle.ts';
import { canonicalManifestPath, validateCorpusDocument } from './corpus.ts';

function isWithinDirectory(directory, filePath) {
	const relative = path.relative(directory, filePath);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function isWithinExistingDirectory(directory, filePath) {
	if (isWithinDirectory(directory, filePath)) return true;
	const directoryStatus = fs.statSync(directory, { throwIfNoEntry: false });
	const fileStatus = fs.statSync(filePath, { throwIfNoEntry: false });
	if (!directoryStatus?.isDirectory() || !fileStatus?.isFile()) return false;

	let current = path.dirname(fs.realpathSync(filePath));
	for (;;) {
		const currentStatus = fs.statSync(current, { throwIfNoEntry: false });
		if (
			currentStatus?.isDirectory() &&
			currentStatus.dev === directoryStatus.dev &&
			currentStatus.ino === directoryStatus.ino
		) {
			return true;
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function readLocalManifest(manifestPath, allowMissing = false) {
	if (!fs.existsSync(manifestPath)) {
		if (!allowMissing) throw new Error(`corpus manifest does not exist: ${manifestPath}`);
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
	const errors = validateCorpusDocument(document, { manifestPath, checkFiles: false });
	if (errors.length > 0) throw new Error(`invalid corpus manifest:\n- ${errors.join('\n- ')}`);
	if (document.distribution !== 'local')
		throw new Error('withdrawal requires a local corpus manifest');
	return document;
}

function interruptedOrphanCleanupTargetsManifest(lockPath, manifestPath, sessionId) {
	const localCorpusRoot = path.dirname(lockPath);
	const candidates = [
		lockPath,
		...fs
			.readdirSync(localCorpusRoot)
			.filter(
				(name) =>
					name.startsWith('.intake.lock.stale-') &&
					!name.endsWith('.recovered') &&
					!fs.existsSync(`${path.join(localCorpusRoot, name)}.recovered`),
			)
			.map((name) => path.join(localCorpusRoot, name)),
	];
	for (const candidate of candidates) {
		const lockEntry = fs.lstatSync(candidate, { throwIfNoEntry: false });
		if (!lockEntry?.isDirectory() || lockEntry.isSymbolicLink()) continue;
		try {
			const owner = JSON.parse(fs.readFileSync(path.join(candidate, 'owner.json'), 'utf8'));
			const ownerManifestPath =
				typeof owner.manifest_path === 'string'
					? canonicalManifestPath(owner.manifest_path, { allowMissing: true })
					: null;
			const matches =
				(owner.operation === 'intake' ||
					(owner.operation === 'withdrawal' &&
						(owner.orphan_cleanup === true ||
							owner.withdrawal_committed === true ||
							!fs.existsSync(manifestPath)))) &&
				owner.session_id === sessionId &&
				ownerManifestPath === manifestPath;
			if (matches) return owner;
		} catch {
			continue;
		}
	}
	return null;
}

function validateWithdrawalOptions(options) {
	if (!options.confirmWithdrawal) throw new Error('--confirm-withdrawal is required');
	if (!/^session-[a-z0-9][a-z0-9-]*$/.test(options.sessionId ?? '')) {
		throw new Error('--session-id must be an opaque session-* identifier');
	}
}

function readWithdrawalMarker(markerPath, sessionId, manifestPath) {
	if (!fs.existsSync(markerPath)) return null;
	let marker;
	try {
		marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read pending withdrawal ${markerPath}: ${error.message}`);
	}
	const minimumRemovedSamples = marker.schema_version === 2 ? 0 : 1;
	const commonFieldsValid =
		marker.session_id === sessionId &&
		Number.isInteger(marker.removed_samples) &&
		marker.removed_samples >= minimumRemovedSamples;
	const quarantineValid =
		marker.schema_version === 2 &&
		/^\.withdrawal-results-[a-z0-9-]+-[a-f0-9-]+$/.test(marker.results_quarantine ?? '');
	const manifestValid =
		marker.schema_version !== 2 ||
		marker.manifest_path === undefined ||
		(typeof marker.manifest_path === 'string' &&
			canonicalManifestPath(marker.manifest_path, { allowMissing: true }) === manifestPath);
	if (!commonFieldsValid || (marker.schema_version !== 1 && (!quarantineValid || !manifestValid))) {
		throw new Error(`pending withdrawal record is invalid: ${markerPath}`);
	}
	if (marker.schema_version === 1) {
		return {
			schema_version: 1,
			session_id: marker.session_id,
			removed_samples: marker.removed_samples,
			started_at: marker.started_at,
		};
	}
	return marker;
}

function markerTargetsManifest(markerPath, sessionId, manifestPath) {
	const markerEntry = fs.lstatSync(markerPath, { throwIfNoEntry: false });
	if (!markerEntry?.isFile() || markerEntry.isSymbolicLink()) return false;
	try {
		const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
		return (
			marker.schema_version === 2 &&
			marker.session_id === sessionId &&
			typeof marker.manifest_path === 'string' &&
			canonicalManifestPath(marker.manifest_path, { allowMissing: true }) === manifestPath
		);
	} catch {
		return false;
	}
}

function writeWithdrawalMarker(markerPath, marker) {
	const stagedMarker = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.writeFileSync(stagedMarker, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
		fs.renameSync(stagedMarker, markerPath);
	} finally {
		fs.rmSync(stagedMarker, { force: true });
	}
}

function quarantineResults(localCorpusRoot, manifestPath, marker) {
	const resultsPath = path.join(path.dirname(manifestPath), 'results');
	const quarantinePath = path.join(localCorpusRoot, marker.results_quarantine);
	const quarantineEntry = fs.lstatSync(quarantinePath, { throwIfNoEntry: false });
	if (quarantineEntry?.isSymbolicLink()) {
		throw new Error(`withdrawal results quarantine cannot be a symbolic link: ${quarantinePath}`);
	}
	if (quarantineEntry) return quarantinePath;

	const resultsEntry = fs.lstatSync(resultsPath, { throwIfNoEntry: false });
	if (resultsEntry?.isSymbolicLink()) {
		throw new Error(`results directory cannot be a symbolic link: ${resultsPath}`);
	}
	if (resultsEntry) fs.renameSync(resultsPath, quarantinePath);
	else fs.mkdirSync(quarantinePath);
	return quarantinePath;
}

function finishWithdrawal(localCorpusRoot, manifestPath, sessionId, markerPath, marker) {
	fs.rmSync(path.join(localCorpusRoot, sessionId), { recursive: true, force: true });
	retirePreparedBundleForWithdrawal(manifestPath, sessionId);
	if (marker.schema_version === 2) {
		fs.rmSync(path.join(localCorpusRoot, marker.results_quarantine), {
			recursive: true,
			force: true,
		});
	}
	fs.rmSync(markerPath, { force: true });
}

export function withdrawConsentedSession(options) {
	validateWithdrawalOptions(options);
	const manifestPath = canonicalManifestPath(options.manifestPath, { allowMissing: true });
	const localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
	if (fs.lstatSync(localCorpusRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`corpus directory cannot be a symbolic link: ${localCorpusRoot}`);
	}
	if (!fs.statSync(localCorpusRoot, { throwIfNoEntry: false })?.isDirectory()) {
		if (retirePreparedBundleForWithdrawal(manifestPath, options.sessionId)) {
			return {
				sessionId: options.sessionId,
				removedSamples: 0,
				resumed: false,
			};
		}
		throw new Error(`local corpus directory does not exist: ${localCorpusRoot}`);
	}

	const lockPath = path.join(localCorpusRoot, '.intake.lock');
	const markerPath = path.join(localCorpusRoot, `.withdrawal-${options.sessionId}.json`);
	const manifestExists = fs.existsSync(manifestPath);
	const preparedBundle = preparedBundleForWithdrawal(manifestPath, options.sessionId);
	const interruptedOperation = interruptedOrphanCleanupTargetsManifest(
		lockPath,
		manifestPath,
		options.sessionId,
	);
	const allowMissingManifest =
		interruptedOperation !== null ||
		markerTargetsManifest(markerPath, options.sessionId, manifestPath) ||
		preparedBundle !== null;
	if (!manifestExists && !allowMissingManifest) {
		throw new Error(`corpus manifest does not exist: ${manifestPath}`);
	}
	const orphanCleanup =
		interruptedOperation?.orphan_cleanup === true ||
		(!manifestExists && interruptedOperation !== null);
	const completedWithdrawal = interruptedOperation?.withdrawal_committed === true;
	const lockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath, {
		operation: 'withdrawal',
		sessionId: options.sessionId,
		orphanCleanup,
	});
	const stagedManifest = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
	const completeRecovery = () => {
		completeLocalCorpusWithdrawalRecovery(localCorpusRoot, manifestPath, options.sessionId);
	};
	try {
		if (fs.lstatSync(markerPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`pending withdrawal record cannot be a symbolic link: ${markerPath}`);
		}
		const document = readLocalManifest(manifestPath, allowMissingManifest);
		const withdrawn = document.samples.filter((sample) => sample.session_id === options.sessionId);
		const pendingMarker = readWithdrawalMarker(markerPath, options.sessionId, manifestPath);
		const sessionDirectory = path.join(localCorpusRoot, options.sessionId);
		if (withdrawn.length === 0) {
			if (pendingMarker) {
				markLocalCorpusWithdrawalCommitted(lockPath, lockToken);
				completeRecovery();
				finishWithdrawal(
					localCorpusRoot,
					manifestPath,
					options.sessionId,
					markerPath,
					pendingMarker,
				);
				return {
					sessionId: options.sessionId,
					removedSamples: pendingMarker.removed_samples,
					resumed: true,
				};
			}
			const sessionEntry = fs.lstatSync(sessionDirectory, { throwIfNoEntry: false });
			if (!sessionEntry) {
				if (orphanCleanup || completedWithdrawal) {
					completeRecovery();
					retirePreparedBundleForWithdrawal(manifestPath, options.sessionId);
					return {
						sessionId: options.sessionId,
						removedSamples: 0,
						resumed: true,
					};
				}
				if (retirePreparedBundle(preparedBundle)) {
					return {
						sessionId: options.sessionId,
						removedSamples: 0,
						resumed: false,
					};
				}
				throw new Error(`session is not present in the corpus: ${options.sessionId}`);
			}
			if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) {
				throw new Error(`session directory is not a regular directory: ${sessionDirectory}`);
			}
			for (const sample of document.samples) {
				for (const field of ['audio_path', 'reference_path']) {
					const filePath = path.resolve(path.dirname(manifestPath), sample[field]);
					if (isWithinExistingDirectory(sessionDirectory, filePath)) {
						throw new Error(
							`refusing to withdraw ${options.sessionId}: remaining sample ${sample.id} shares its directory`,
						);
					}
				}
			}
			markLocalCorpusOrphanCleanup(lockPath, lockToken);
			const orphanMarker = {
				schema_version: 2,
				session_id: options.sessionId,
				removed_samples: 0,
				manifest_path: manifestPath,
				results_quarantine: `.withdrawal-results-${options.sessionId}-${randomUUID()}`,
				started_at: new Date().toISOString(),
			};
			writeWithdrawalMarker(markerPath, orphanMarker);
			markLocalCorpusWithdrawalCommitted(lockPath, lockToken);
			completeRecovery();
			finishWithdrawal(
				localCorpusRoot,
				manifestPath,
				options.sessionId,
				markerPath,
				orphanMarker,
			);
			return {
				sessionId: options.sessionId,
				removedSamples: 0,
				resumed: false,
			};
		}
		if (pendingMarker && pendingMarker.removed_samples !== withdrawn.length) {
			throw new Error(`pending withdrawal sample count changed: ${markerPath}`);
		}

		if (fs.lstatSync(sessionDirectory, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`session directory cannot be a symbolic link: ${sessionDirectory}`);
		}
		for (const sample of withdrawn) {
			for (const field of ['audio_path', 'reference_path']) {
				const filePath = path.resolve(path.dirname(manifestPath), sample[field]);
				if (!isWithinExistingDirectory(sessionDirectory, filePath)) {
					throw new Error(
						`refusing to withdraw ${sample.id}: ${field} is outside ${options.sessionId}`,
					);
				}
			}
		}

		const remaining = document.samples.filter((sample) => sample.session_id !== options.sessionId);
		for (const sample of remaining) {
			for (const field of ['audio_path', 'reference_path']) {
				const filePath = path.resolve(path.dirname(manifestPath), sample[field]);
				if (isWithinExistingDirectory(sessionDirectory, filePath)) {
					throw new Error(
						`refusing to withdraw ${options.sessionId}: remaining sample ${sample.id} shares its directory`,
					);
				}
			}
		}
		const nextDocument = { ...document, samples: remaining };
		const errors = validateCorpusDocument(nextDocument, { manifestPath, checkFiles: false });
		if (errors.length > 0) {
			throw new Error(`withdrawal would leave an invalid corpus:\n- ${errors.join('\n- ')}`);
		}

		let marker = pendingMarker;
		if (marker?.schema_version !== 2) {
			marker = {
				schema_version: 2,
				session_id: options.sessionId,
				removed_samples: withdrawn.length,
				manifest_path: manifestPath,
				results_quarantine: `.withdrawal-results-${options.sessionId}-${randomUUID()}`,
				started_at: pendingMarker?.started_at ?? new Date().toISOString(),
			};
			writeWithdrawalMarker(markerPath, marker);
		}
		quarantineResults(localCorpusRoot, manifestPath, marker);
		fs.writeFileSync(stagedManifest, `${JSON.stringify(nextDocument, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(stagedManifest, manifestPath);
		markLocalCorpusWithdrawalCommitted(lockPath, lockToken);
		completeRecovery();
		finishWithdrawal(localCorpusRoot, manifestPath, options.sessionId, markerPath, marker);
		return {
			sessionId: options.sessionId,
			removedSamples: withdrawn.length,
			resumed: false,
		};
	} finally {
		fs.rmSync(stagedManifest, { force: true });
		releaseLocalCorpusLock(lockPath, lockToken);
	}
}

function requiredValue(args, index, option) {
	const value = args[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
	return value;
}

export function parseWithdrawalArgs(args, defaultManifestPath) {
	const options = { manifestPath: defaultManifestPath, confirmWithdrawal: false };
	for (let index = 0; index < args.length; index += 1) {
		const option = args[index];
		if (index === 0 && option === '--') continue;
		if (option === '--confirm-withdrawal') {
			options.confirmWithdrawal = true;
			continue;
		}
		if (option === '--manifest') options.manifestPath = requiredValue(args, index, option);
		else if (option === '--session-id') options.sessionId = requiredValue(args, index, option);
		else throw new Error(`unknown option: ${option}`);
		index += 1;
	}
	return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const options = parseWithdrawalArgs(
			process.argv.slice(2),
			path.join(here, 'corpus-local.json'),
		);
		const result = withdrawConsentedSession(options);
		console.log(
			`${result.resumed ? 'completed' : 'withdrew'} ${result.sessionId}: ` +
				`removed ${result.removedSamples} sample(s)`,
		);
		console.log('Delete or retain the external consent record according to the approved policy.');
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
}
