import fs from 'node:fs';
import path from 'node:path';

import { canonicalFilePath, canonicalManifestPath } from './corpus.ts';

function preparedBundleDirectory(manifestPath, sessionId) {
	return path.join(path.dirname(manifestPath), 'intake', sessionId);
}

function regularPreparedBundle(manifestPath, sessionId) {
	const intakeRoot = path.join(path.dirname(manifestPath), 'intake');
	const rootEntry = fs.lstatSync(intakeRoot, { throwIfNoEntry: false });
	if (!rootEntry) return null;
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`prepared intake root must be a regular directory: ${intakeRoot}`);
	}
	const bundleDirectory = preparedBundleDirectory(manifestPath, sessionId);
	const bundleEntry = fs.lstatSync(bundleDirectory, { throwIfNoEntry: false });
	if (!bundleEntry) return null;
	if (!bundleEntry.isDirectory() || bundleEntry.isSymbolicLink()) {
		throw new Error(`prepared intake bundle must be a regular directory: ${bundleDirectory}`);
	}
	return bundleDirectory;
}

function readPreparedMetadata(bundleDirectory) {
	const metadataPath = path.join(bundleDirectory, 'collection-session.json');
	const metadataEntry = fs.lstatSync(metadataPath, { throwIfNoEntry: false });
	if (!metadataEntry?.isFile() || metadataEntry.isSymbolicLink()) {
		throw new Error(`prepared intake metadata must be a regular file: ${metadataPath}`);
	}
	try {
		return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
	} catch (error) {
		throw new Error(`failed to read prepared intake metadata ${metadataPath}: ${error.message}`);
	}
}

export function preparedBundleForIntake({
	manifestPath,
	audioSource,
	referenceSource,
	consentRecord,
	options,
}) {
	const bundleDirectory = regularPreparedBundle(manifestPath, options.sessionId);
	if (!bundleDirectory) return null;
	const expectedAudio = path.join(bundleDirectory, 'recording.wav');
	const expectedReference = path.join(bundleDirectory, 'reference.txt');
	const canonicalAudioSource = canonicalFilePath(audioSource);
	const canonicalReferenceSource = canonicalFilePath(referenceSource);
	const canonicalConsentRecord = canonicalFilePath(consentRecord);
	const usesPreparedSource =
		canonicalAudioSource === expectedAudio || canonicalReferenceSource === expectedReference;
	if (!usesPreparedSource) return null;
	if (
		canonicalAudioSource !== expectedAudio ||
		canonicalReferenceSource !== expectedReference
	) {
		throw new Error('prepared intake must use both the generated recording and reference paths');
	}

	const metadata = readPreparedMetadata(bundleDirectory);
	const expected = {
		schemaVersion: 1,
		sessionId: options.sessionId,
		consentRecordId: options.consentRecordId,
		sampleId: options.sampleId,
		language: options.language,
		noiseCondition: options.noiseCondition,
		manifestPath,
		audioPath: canonicalAudioSource,
		referencePath: canonicalReferenceSource,
		consentRecordPath: canonicalConsentRecord,
	};
	for (const [field, value] of Object.entries(expected)) {
		let actual = metadata[field];
		if (typeof actual === 'string') {
			if (field === 'manifestPath') {
				actual = canonicalManifestPath(actual, { allowMissing: true });
			} else if (['audioPath', 'referencePath', 'consentRecordPath'].includes(field)) {
				actual = canonicalFilePath(actual);
			}
		}
		if (actual !== value) {
			throw new Error(`prepared intake metadata does not match ${field}: ${bundleDirectory}`);
		}
	}
	return bundleDirectory;
}

export function retirePreparedBundle(bundleDirectory) {
	if (!bundleDirectory) return false;
	fs.rmSync(bundleDirectory, { recursive: true });
	return true;
}

export function retirePreparedBundleForWithdrawal(manifestPath, sessionId) {
	return retirePreparedBundle(regularPreparedBundle(manifestPath, sessionId));
}
