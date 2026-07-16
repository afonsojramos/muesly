#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	acquireLocalCorpusLock,
	releaseLocalCorpusLock,
} from './corpus-intake.mjs';
import { validateCorpusDocument } from './corpus.mjs';

function isWithinDirectory(directory, filePath) {
	const relative = path.relative(directory, filePath);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function readLocalManifest(manifestPath) {
	let document;
	try {
		document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read corpus manifest ${manifestPath}: ${error.message}`);
	}
	const errors = validateCorpusDocument(document, { manifestPath });
	if (errors.length > 0) throw new Error(`invalid corpus manifest:\n- ${errors.join('\n- ')}`);
	if (document.distribution !== 'local') throw new Error('withdrawal requires a local corpus manifest');
	return document;
}

function validateWithdrawalOptions(options) {
	if (!options.confirmWithdrawal) throw new Error('--confirm-withdrawal is required');
	if (!/^session-[a-z0-9][a-z0-9-]*$/.test(options.sessionId ?? '')) {
		throw new Error('--session-id must be an opaque session-* identifier');
	}
}

function readWithdrawalMarker(markerPath, sessionId) {
	if (!fs.existsSync(markerPath)) return null;
	let marker;
	try {
		marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read pending withdrawal ${markerPath}: ${error.message}`);
	}
	if (
		marker.schema_version !== 1 ||
		marker.session_id !== sessionId ||
		!Number.isInteger(marker.removed_samples) ||
		marker.removed_samples < 1
	) {
		throw new Error(`pending withdrawal record is invalid: ${markerPath}`);
	}
	return marker;
}

function finishWithdrawal(localCorpusRoot, manifestPath, sessionId, markerPath) {
	fs.rmSync(path.join(localCorpusRoot, sessionId), { recursive: true, force: true });
	fs.rmSync(path.join(path.dirname(manifestPath), 'results'), { recursive: true, force: true });
	fs.rmSync(markerPath, { force: true });
}

export function withdrawConsentedSession(options) {
	validateWithdrawalOptions(options);
	const manifestPath = path.resolve(options.manifestPath);
	if (!fs.existsSync(manifestPath)) throw new Error(`corpus manifest does not exist: ${manifestPath}`);
	const localCorpusRoot = path.join(path.dirname(manifestPath), 'local-corpus');
	if (fs.lstatSync(localCorpusRoot, { throwIfNoEntry: false })?.isSymbolicLink()) {
		throw new Error(`corpus directory cannot be a symbolic link: ${localCorpusRoot}`);
	}
	if (!fs.statSync(localCorpusRoot, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`local corpus directory does not exist: ${localCorpusRoot}`);
	}

	const lockPath = path.join(localCorpusRoot, '.intake.lock');
	const lockToken = acquireLocalCorpusLock(lockPath, localCorpusRoot, manifestPath);
	const stagedManifest = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
	const markerPath = path.join(localCorpusRoot, `.withdrawal-${options.sessionId}.json`);
	try {
		if (fs.lstatSync(markerPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`pending withdrawal record cannot be a symbolic link: ${markerPath}`);
		}
		const document = readLocalManifest(manifestPath);
		const withdrawn = document.samples.filter((sample) => sample.session_id === options.sessionId);
		if (withdrawn.length === 0) {
			const marker = readWithdrawalMarker(markerPath, options.sessionId);
			if (!marker) throw new Error(`session is not present in the corpus: ${options.sessionId}`);
			finishWithdrawal(localCorpusRoot, manifestPath, options.sessionId, markerPath);
			return { sessionId: options.sessionId, removedSamples: marker.removed_samples, resumed: true };
		}

		const sessionDirectory = path.join(localCorpusRoot, options.sessionId);
		if (fs.lstatSync(sessionDirectory, { throwIfNoEntry: false })?.isSymbolicLink()) {
			throw new Error(`session directory cannot be a symbolic link: ${sessionDirectory}`);
		}
		for (const sample of withdrawn) {
			for (const field of ['audio_path', 'reference_path']) {
				const filePath = path.resolve(path.dirname(manifestPath), sample[field]);
				if (!isWithinDirectory(sessionDirectory, filePath)) {
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
				if (isWithinDirectory(sessionDirectory, filePath)) {
					throw new Error(
						`refusing to withdraw ${options.sessionId}: remaining sample ${sample.id} shares its directory`,
					);
				}
			}
		}
		const nextDocument = { ...document, samples: remaining };
		const errors = validateCorpusDocument(nextDocument, { manifestPath });
		if (errors.length > 0) {
			throw new Error(`withdrawal would leave an invalid corpus:\n- ${errors.join('\n- ')}`);
		}

		fs.writeFileSync(
			markerPath,
			`${JSON.stringify({
				schema_version: 1,
				session_id: options.sessionId,
				removed_samples: withdrawn.length,
				started_at: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(stagedManifest, `${JSON.stringify(nextDocument, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(stagedManifest, manifestPath);
		finishWithdrawal(localCorpusRoot, manifestPath, options.sessionId, markerPath);
		return { sessionId: options.sessionId, removedSamples: withdrawn.length, resumed: false };
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
