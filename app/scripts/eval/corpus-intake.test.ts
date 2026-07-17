import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	acquireLocalCorpusLock,
	abandonedResultPids,
	intakeConsentedSample,
	localCalendarDate,
	parseIntakeArgs,
	releaseLocalCorpusLock,
	wavDurationSeconds,
} from './corpus-intake.ts';
import { acquireCorpusBenchmarkLock, releaseCorpusBenchmarkLock } from './corpus-benchmark-lock.ts';
import {
	createConsentedReviewDirectory,
	recordConsentedReviewAttestation,
} from './corpus-review.ts';
import { canonicalManifestPath, REFERENCE_PROTOCOL_ID, validateCorpusDocument } from './corpus.ts';
import { processOwnsState } from './process-identity.ts';

function writeWav(filePath, durationSeconds = 2) {
	const sampleRate = 16_000;
	const dataBytes = sampleRate * durationSeconds * 2;
	const wav = Buffer.alloc(44 + dataBytes);
	wav.write('RIFF', 0);
	wav.writeUInt32LE(36 + dataBytes, 4);
	wav.write('WAVEfmt ', 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write('data', 36);
	wav.writeUInt32LE(dataBytes, 40);
	fs.writeFileSync(filePath, wav);
}

function waitForPathSync(filePath, label) {
	const signal = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(filePath)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		Atomics.wait(signal, 0, 0, 10);
	}
}

function attestPreparedBundle(current, reviewerId) {
	return recordConsentedReviewAttestation({
		bundleDirectory: current.bundleDirectory,
		audioPath: current.options.audio,
		referencePath: current.options.reference,
		sessionId: current.options.sessionId,
		sampleId: current.options.sampleId,
		reviewerId,
		acceptReviewedReference: true,
		affirmReferenceProtocol: REFERENCE_PROTOCOL_ID,
		reviewedAt: '2026-07-16T12:00:00.000Z',
	});
}

function prepareReviewedBundle(current, { reviewCount = 2, metadataOverride = {} } = {}) {
	const { options } = current;
	const manifestPath = canonicalManifestPath(options.manifestPath, { allowMissing: true });
	const bundleDirectory = path.join(path.dirname(manifestPath), 'intake', options.sessionId);
	fs.mkdirSync(bundleDirectory, { recursive: true, mode: 0o700 });
	fs.chmodSync(bundleDirectory, 0o700);
	const audio = path.join(bundleDirectory, 'recording.wav');
	const reference = path.join(bundleDirectory, 'reference.txt');
	if (path.resolve(options.audio) !== audio) fs.renameSync(options.audio, audio);
	if (path.resolve(options.reference) !== reference) fs.renameSync(options.reference, reference);
	fs.chmodSync(audio, 0o600);
	fs.chmodSync(reference, 0o600);
	options.audio = audio;
	options.reference = reference;
	const reviewAttestationsPath = createConsentedReviewDirectory(bundleDirectory);
	const metadataPath = path.join(bundleDirectory, 'collection-session.json');
	fs.writeFileSync(
		metadataPath,
		`${JSON.stringify({
			schemaVersion: 3,
			referenceProtocolId: REFERENCE_PROTOCOL_ID,
			sessionId: options.sessionId,
			consentRecordId: options.consentRecordId,
			sampleId: options.sampleId,
			language: options.language,
			noiseCondition: options.noiseCondition,
			manifestPath,
			audioPath: audio,
			referencePath: reference,
			reviewAttestationsPath,
			consentRecordPath: fs.realpathSync(options.consentRecord),
			...metadataOverride,
		})}\n`,
		{ mode: 0o600 },
	);
	fs.chmodSync(metadataPath, 0o600);
	current.bundleDirectory = bundleDirectory;
	current.reviewAttestationsPath = reviewAttestationsPath;
	for (let index = 0; index < reviewCount; index += 1) {
		attestPreparedBundle(current, `reviewer-${index + 1}`);
	}
	return current;
}

function intakeFixture({ prepare = true, reviewCount = 2 } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-intake-'));
	const audio = path.join(directory, 'source.wav');
	const reference = path.join(directory, 'source.txt');
	const consentRecord = path.join(directory, 'consent-record.md');
	writeWav(audio);
	fs.writeFileSync(reference, 'Hello from the consented meeting.\n');
	fs.writeFileSync(consentRecord, 'Encrypted-system export or signed affirmative record.\n');
	const current = {
		directory,
		options: {
			manifestPath: path.join(directory, 'corpus-local.json'),
			audio,
			reference,
			sampleId: 'en-clean-001',
			sessionId: 'session-opaque-001',
			consentRecordId: 'consent-opaque-001',
			consentRecord,
			consentDate: '2026-07-15',
			language: 'en',
			noiseCondition: 'clean',
			speakers: 2,
			affirmConsent: true,
			referenceProtocolId: REFERENCE_PROTOCOL_ID,
			today: '2026-07-16',
		},
	};
	return prepare ? prepareReviewedBundle(current, { reviewCount }) : current;
}

function writeSchema3Manifest(manifestPath) {
	fs.writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				schema_version: 3,
				corpus_id: 'consented-meetings-v1',
				reference_protocol_id: REFERENCE_PROTOCOL_ID,
				description: 'Local-only participant-consented multilingual meeting corpus.',
				distribution: 'local',
				samples: [],
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
}

test('reads duration from RIFF/WAVE structure', () => {
	const { directory } = intakeFixture({ prepare: false });
	assert.equal(wavDurationSeconds(path.join(directory, 'source.wav')), 2);
	const invalid = path.join(directory, 'invalid.wav');
	fs.writeFileSync(invalid, 'not wave audio');
	assert.throws(() => wavDurationSeconds(invalid), /RIFF\/WAVE|truncated/);
});

test('requires explicit consent affirmation before writing anything', () => {
	const { directory, options } = intakeFixture({ prepare: false });
	options.affirmConsent = false;
	assert.throws(() => intakeConsentedSample(options), /affirm-all-participants-consented/);
	assert.deepEqual(fs.readdirSync(directory).sort(), [
		'consent-record.md',
		'source.txt',
		'source.wav',
	]);
});

test('requires explicit affirmation of the exact reference protocol', () => {
	const { directory, options } = intakeFixture({ prepare: false });
	delete options.referenceProtocolId;
	assert.throws(() => intakeConsentedSample(options), /affirm-reference-protocol/);
	assert(!fs.existsSync(options.manifestPath));

	options.referenceProtocolId = 'another-reference-v1';
	assert.throws(() => intakeConsentedSample(options), /muesly-meeting-reference-v1/);
	assert.deepEqual(fs.readdirSync(directory).sort(), [
		'consent-record.md',
		'source.txt',
		'source.wav',
	]);
});

test('rejects malformed UTF-8 references before writing anything', () => {
	const { directory, options } = intakeFixture({ prepare: false });
	fs.writeFileSync(options.reference, Buffer.from([0xc3, 0x28]));

	assert.throws(() => intakeConsentedSample(options), /reference transcript must be valid UTF-8/);
	assert.deepEqual(fs.readdirSync(directory).sort(), [
		'consent-record.md',
		'source.txt',
		'source.wav',
	]);
});

test('requires audio, reference, and consent to identify distinct files', () => {
	for (const aliasType of ['symlink', 'hard link']) {
		if (aliasType === 'symlink' && process.platform === 'win32') continue;
		const { directory, options } = intakeFixture({ prepare: false });
		const consentAlias = path.join(directory, `consent-${aliasType.replace(' ', '-')}.md`);
		if (aliasType === 'symlink') {
			fs.symlinkSync(options.reference, consentAlias);
		} else {
			fs.linkSync(options.reference, consentAlias);
		}
		options.consentRecord = consentAlias;

		assert.throws(
			() => intakeConsentedSample(options),
			/audio, reference, and consent record must be three distinct files/,
			aliasType,
		);
		assert(!fs.existsSync(options.manifestPath), aliasType);
		assert(!fs.existsSync(path.join(directory, 'local-corpus')), aliasType);
	}
});

test('requires consent records to remain outside the managed corpus tree', () => {
	const { directory, options } = intakeFixture({ prepare: false });
	const managedConsentRecord = path.join(
		directory,
		'local-corpus',
		options.sessionId,
		'consent.md',
	);
	fs.mkdirSync(path.dirname(managedConsentRecord), { recursive: true });
	fs.writeFileSync(managedConsentRecord, 'affirmative consent record');
	options.consentRecord = managedConsentRecord;

	assert.throws(
		() => intakeConsentedSample(options),
		/consent record must be stored outside managed corpus and results directories/,
	);
	assert(fs.existsSync(managedConsentRecord));
	assert(!fs.existsSync(options.manifestPath));
	assert(!fs.existsSync(path.join(directory, 'local-corpus', '.intake.lock')));
});

test('updates the canonical manifest when intake is invoked through a symlink', (t) => {
	if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
	const current = intakeFixture({ prepare: false });
	const { directory, options } = current;
	const canonicalDirectory = path.join(directory, 'canonical');
	const aliasDirectory = path.join(directory, 'alias');
	fs.mkdirSync(canonicalDirectory);
	fs.mkdirSync(aliasDirectory);
	const canonicalManifest = path.join(canonicalDirectory, 'corpus-local.json');
	const aliasManifest = path.join(aliasDirectory, 'corpus-local.json');
	fs.writeFileSync(
		canonicalManifest,
		JSON.stringify({
			schema_version: 4,
			corpus_id: 'consented-meetings-v1',
			reference_protocol_id: REFERENCE_PROTOCOL_ID,
			description: 'Local-only participant-consented multilingual meeting corpus.',
			distribution: 'local',
			samples: [],
		}),
	);
	fs.symlinkSync(canonicalManifest, aliasManifest);
	options.manifestPath = aliasManifest;
	prepareReviewedBundle(current);

	intakeConsentedSample(options);

	assert(fs.lstatSync(aliasManifest).isSymbolicLink());
	assert.equal(JSON.parse(fs.readFileSync(canonicalManifest, 'utf8')).samples.length, 1);
	assert(fs.existsSync(path.join(canonicalDirectory, 'local-corpus', options.sessionId)));
	assert(!fs.existsSync(path.join(aliasDirectory, 'local-corpus')));
});

test('initializes the target behind a dangling manifest symlink', (t) => {
	if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
	const current = intakeFixture({ prepare: false });
	const { directory, options } = current;
	const canonicalManifest = path.join(directory, 'canonical', 'corpus-local.json');
	const aliasManifest = path.join(directory, 'corpus-alias.json');
	fs.symlinkSync(canonicalManifest, aliasManifest);
	options.manifestPath = aliasManifest;
	prepareReviewedBundle(current);

	intakeConsentedSample(options);

	assert(fs.lstatSync(aliasManifest).isSymbolicLink());
	assert.equal(JSON.parse(fs.readFileSync(canonicalManifest, 'utf8')).samples.length, 1);
	assert(fs.existsSync(path.join(directory, 'canonical', 'local-corpus', options.sessionId)));
});

test('rejects filesystem aliases into the managed corpus tree', (t) => {
	if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
	const { directory, options } = intakeFixture({ prepare: false });
	const corpusDirectory = path.join(directory, 'local-corpus');
	const managedConsentRecord = path.join(corpusDirectory, options.sessionId, 'consent.md');
	fs.mkdirSync(path.dirname(managedConsentRecord), { recursive: true });
	fs.writeFileSync(managedConsentRecord, 'affirmative consent record');
	const aliasedCorpusDirectory = path.join(directory, 'LOCAL-CORPUS');
	if (!fs.existsSync(aliasedCorpusDirectory)) {
		fs.symlinkSync(corpusDirectory, aliasedCorpusDirectory, 'dir');
	}
	options.consentRecord = path.join(aliasedCorpusDirectory, options.sessionId, 'consent.md');

	assert.throws(
		() => intakeConsentedSample(options),
		/consent record must be stored outside managed corpus and results directories/,
	);
	assert(fs.existsSync(managedConsentRecord));
	assert(!fs.existsSync(options.manifestPath));
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
});

test('rejects external file symlinks into the managed corpus tree', (t) => {
	if (process.platform === 'win32') return t.skip('symbolic links are not portable on Windows');
	const { directory, options } = intakeFixture({ prepare: false });
	const corpusDirectory = path.join(directory, 'local-corpus');
	const managedConsentRecord = path.join(corpusDirectory, options.sessionId, 'consent.md');
	fs.mkdirSync(path.dirname(managedConsentRecord), { recursive: true });
	fs.writeFileSync(managedConsentRecord, 'affirmative consent record');
	const consentAlias = path.join(directory, 'consent-alias.md');
	fs.symlinkSync(managedConsentRecord, consentAlias);
	options.consentRecord = consentAlias;

	assert.throws(
		() => intakeConsentedSample(options),
		/consent record must be stored outside managed corpus and results directories/,
	);
	assert(fs.existsSync(managedConsentRecord));
	assert(!fs.existsSync(options.manifestPath));
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
});

test('rejects consent records in managed results through direct paths and aliases', () => {
	for (const alias of [false, true]) {
		if (alias && process.platform === 'win32') continue;
		const { directory, options } = intakeFixture({ prepare: false });
		const resultsDirectory = path.join(directory, 'results');
		const managedConsentRecord = path.join(resultsDirectory, 'consent.md');
		fs.mkdirSync(resultsDirectory);
		fs.writeFileSync(managedConsentRecord, 'affirmative consent record');
		if (alias) {
			const consentAlias = path.join(directory, 'external-consent-alias.md');
			fs.symlinkSync(managedConsentRecord, consentAlias);
			options.consentRecord = consentAlias;
		} else {
			options.consentRecord = managedConsentRecord;
		}

		assert.throws(
			() => intakeConsentedSample(options),
			/consent record must be stored outside managed corpus and results directories/,
		);
		assert(fs.existsSync(managedConsentRecord));
		assert(!fs.existsSync(options.manifestPath));
		assert(!fs.existsSync(path.join(directory, 'local-corpus')));
	}
});

test('rejects direct intake that bypasses generated prepared bundles', () => {
	const { directory, options } = intakeFixture({ prepare: false });

	assert.throws(() => intakeConsentedSample(options), /no prepared intake bundle exists/);
	assert(!fs.existsSync(options.manifestPath));
	assert(!fs.existsSync(path.join(directory, 'local-corpus')));
	assert(fs.existsSync(options.audio));
	assert(fs.existsSync(options.reference));
});

test('requires exactly two accepted reviews before intake', () => {
	for (const reviewCount of [0, 1]) {
		const current = intakeFixture({ reviewCount });
		assert.throws(
			() => intakeConsentedSample(current.options),
			new RegExp(`exactly 2 current review attestations; found ${reviewCount}`),
		);
		assert(!fs.existsSync(current.options.manifestPath));
		assert(fs.existsSync(current.bundleDirectory));
	}
});

test('rejects reviews made stale by later audio or reference edits', () => {
	for (const changedInput of ['audio', 'reference']) {
		const current = intakeFixture();
		if (changedInput === 'audio') writeWav(current.options.audio, 3);
		else fs.writeFileSync(current.options.reference, 'Changed after both reviews.\n');

		assert.throws(
			() => intakeConsentedSample(current.options),
			/stale because the audio or reference changed/,
			changedInput,
		);
		assert(!fs.existsSync(current.options.manifestPath), changedInput);
		assert(fs.existsSync(current.bundleDirectory), changedInput);
	}
});

test('rechecks the reviewed hashes after staging begins', () => {
	const current = intakeFixture();
	current.options.beforePreparedStage = ({ referenceSource }) => {
		fs.writeFileSync(referenceSource, 'Changed after review validation but before staging.\n');
	};

	assert.throws(
		() => intakeConsentedSample(current.options),
		/prepared reference changed after its review attestations/,
	);
	assert(!fs.existsSync(current.options.manifestPath));
	assert(fs.existsSync(current.bundleDirectory));
	assert(!fs.existsSync(path.join(current.directory, 'local-corpus', current.options.sessionId)));
});

test('waits for an active review validation before retiring after intake', async () => {
	const current = intakeFixture();
	const configurationPath = path.join(current.directory, 'held-review.json');
	const enteredPath = path.join(current.directory, 'held-review-entered');
	const releasePath = path.join(current.directory, 'held-review-release');
	fs.writeFileSync(
		configurationPath,
		JSON.stringify({
			mode: 'validate',
			releaseOnContention: true,
			bundleDirectory: current.bundleDirectory,
			audioPath: current.options.audio,
			referencePath: current.options.reference,
			sessionId: current.options.sessionId,
			sampleId: current.options.sampleId,
		}),
		{ mode: 0o600 },
	);
	const holdScript = fileURLToPath(new URL('./fixtures/corpus-review-hold.ts', import.meta.url));
	let attester;
	let attesterExit;
	let attesterError = '';
	current.options.beforePreparedStage = () => {
		attester = spawn('nub', [holdScript, configurationPath, enteredPath, releasePath], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		attester.stderr.on('data', (chunk) => {
			attesterError += chunk;
		});
		attesterExit = once(attester, 'exit');
		waitForPathSync(enteredPath, 'held review validation');
	};

	const sample = intakeConsentedSample(current.options);
	const [attesterCode] = await attesterExit;
	assert.equal(attesterCode, 0, attesterError);
	assert.equal(sample.id, current.options.sampleId);
	assert(!fs.existsSync(current.bundleDirectory));
});

test('atomically imports a consented sample with verified metadata and private files', () => {
	const { bundleDirectory, options } = intakeFixture();
	const sample = intakeConsentedSample(options);
	assert.equal(sample.duration_seconds, 2);
	assert.equal(sample.provenance.consent_record_id, 'consent-opaque-001');
	const document = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
	assert.deepEqual(validateCorpusDocument(document, { manifestPath: options.manifestPath }), []);
	assert.equal(document.schema_version, 4);
	assert.equal(document.reference_protocol_id, REFERENCE_PROTOCOL_ID);
	assert.equal(document.samples.length, 1);
	assert.equal(
		fs.readFileSync(
			path.resolve(path.dirname(options.manifestPath), sample.reference_path),
			'utf8',
		),
		'Hello from the consented meeting.\n',
	);
	const manifestContents = fs.readFileSync(options.manifestPath, 'utf8');
	assert(!manifestContents.includes('signed affirmative record'));
	assert(!manifestContents.includes('reviewer-1'));
	assert(!manifestContents.includes('reviewer-2'));
	assert(!manifestContents.includes('reviewed_at'));
	assert(!fs.existsSync(bundleDirectory));
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(options.manifestPath).mode & 0o777, 0o600);
		assert.equal(
			fs.statSync(path.resolve(path.dirname(options.manifestPath), sample.audio_path)).mode & 0o777,
			0o600,
		);
	}
});

test('atomically migrates a schema-3 local corpus when importing a sample', () => {
	const { options } = intakeFixture();
	writeSchema3Manifest(options.manifestPath);

	intakeConsentedSample(options);

	const document = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
	assert.equal(document.schema_version, 4);
	assert.equal(document.samples.length, 1);
	assert.deepEqual(validateCorpusDocument(document, { manifestPath: options.manifestPath }), []);
	assert.equal(
		fs
			.readdirSync(path.dirname(options.manifestPath))
			.some((entry) => entry.startsWith(`${path.basename(options.manifestPath)}.tmp-`)),
		false,
	);
});

test('leaves a schema-3 manifest unchanged when its atomic migration cannot commit', (t) => {
	const { directory, options } = intakeFixture();
	writeSchema3Manifest(options.manifestPath);
	const before = fs.readFileSync(options.manifestPath, 'utf8');
	const canonicalManifest = canonicalManifestPath(options.manifestPath);
	const originalRenameSync = fs.renameSync;
	t.mock.method(fs, 'renameSync', (sourcePath, destinationPath) => {
		if (typeof sourcePath === 'string' && sourcePath.startsWith(`${canonicalManifest}.tmp-`)) {
			throw new Error('simulated manifest commit failure');
		}
		return originalRenameSync(sourcePath, destinationPath);
	});

	assert.throws(() => intakeConsentedSample(options), /simulated manifest commit failure/);
	assert.equal(fs.readFileSync(options.manifestPath, 'utf8'), before);
	assert(!fs.existsSync(path.join(directory, 'local-corpus', options.sessionId)));
	assert.equal(
		fs.readdirSync(directory).some((entry) => entry.startsWith('corpus-local.json.tmp-')),
		false,
	);
});

test('retires a matching prepared source bundle after successful intake', () => {
	const { bundleDirectory, directory, options } = intakeFixture();

	intakeConsentedSample(options);

	assert(!fs.existsSync(bundleDirectory));
	assert(fs.existsSync(path.join(directory, 'local-corpus', options.sessionId)));
	assert(fs.existsSync(options.consentRecord));
});

test('rejects legacy or differently versioned prepared reference metadata', () => {
	for (const metadataOverride of [
		{ schemaVersion: 1 },
		{ schemaVersion: 2 },
		{ referenceProtocolId: 'another-reference-v1' },
	]) {
		const { directory, options } = intakeFixture({ prepare: false });
		const bundleDirectory = path.join(directory, 'intake', options.sessionId);
		fs.mkdirSync(bundleDirectory, { recursive: true, mode: 0o700 });
		const audio = path.join(bundleDirectory, 'recording.wav');
		const reference = path.join(bundleDirectory, 'reference.txt');
		fs.renameSync(options.audio, audio);
		fs.renameSync(options.reference, reference);
		options.audio = audio;
		options.reference = reference;
		fs.writeFileSync(
			path.join(bundleDirectory, 'collection-session.json'),
			JSON.stringify({
				schemaVersion: 3,
				referenceProtocolId: REFERENCE_PROTOCOL_ID,
				sessionId: options.sessionId,
				manifestPath: options.manifestPath,
				...metadataOverride,
			}),
			{ mode: 0o600 },
		);

		assert.throws(
			() => intakeConsentedSample(options),
			/unsupported schema|unsupported reference protocol/,
		);
		assert(!fs.existsSync(options.manifestPath));
		assert(fs.existsSync(bundleDirectory));
	}
});

test('rejects duplicate audio without changing the existing corpus', () => {
	const current = intakeFixture();
	const { directory, options } = current;
	const imported = intakeConsentedSample(options);
	const before = fs.readFileSync(options.manifestPath, 'utf8');
	const duplicateAudio = path.join(directory, 'duplicate-source.wav');
	const duplicateReference = path.join(directory, 'duplicate-source.txt');
	fs.copyFileSync(
		path.resolve(path.dirname(options.manifestPath), imported.audio_path),
		duplicateAudio,
	);
	fs.copyFileSync(
		path.resolve(path.dirname(options.manifestPath), imported.reference_path),
		duplicateReference,
	);
	const duplicate = prepareReviewedBundle({
		directory,
		options: {
			...options,
			audio: duplicateAudio,
			reference: duplicateReference,
			sampleId: 'en-office-002',
			sessionId: 'session-opaque-002',
			noiseCondition: 'office',
		},
	});
	assert.throws(() => intakeConsentedSample(duplicate.options), /audio_sha256 duplicates sample/);
	assert.equal(fs.readFileSync(options.manifestPath, 'utf8'), before);
	assert(fs.existsSync(duplicate.bundleDirectory));
	assert(
		!fs.existsSync(
			path.join(path.dirname(options.manifestPath), 'local-corpus/session-opaque-002'),
		),
	);
});

test('rejects future consent dates and incomplete CLI values', () => {
	const { options } = intakeFixture({ prepare: false });
	options.consentDate = '2026-07-17';
	assert.throws(() => intakeConsentedSample(options), /non-future/);
	assert.throws(
		() => parseIntakeArgs(['--audio', '--reference', 'ref.txt'], 'manifest.json'),
		/--audio requires a value/,
	);
});

test('derives consent-day boundaries from the operator local calendar', () => {
	assert.equal(
		localCalendarDate({
			getFullYear: () => 2026,
			getMonth: () => 6,
			getDate: () => 16,
		}),
		'2026-07-16',
	);
});

test('rejects path-like identifiers before creating intake directories', () => {
	const { directory, options } = intakeFixture({ prepare: false });
	options.sessionId = '../../outside';
	assert.throws(() => intakeConsentedSample(options), /opaque session/);
	assert(!fs.existsSync(path.join(directory, 'local-corpus')));
});

test('serializes manifest updates with an exclusive local intake lock', (t) => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	fs.mkdirSync(corpusDirectory);
	const lockPath = path.join(corpusDirectory, '.intake.lock');
	const lockContents = JSON.stringify({
		schema_version: 1,
		pid: process.pid,
		created_at: new Date().toISOString(),
	});
	fs.writeFileSync(lockPath, lockContents);
	const originalRenameSync = fs.renameSync;
	let replacementAttempted = false;
	t.mock.method(fs, 'renameSync', (sourcePath, destinationPath) => {
		if (
			typeof sourcePath === 'string' &&
			sourcePath.includes('.intake.lock.pending-') &&
			destinationPath === lockPath
		) {
			replacementAttempted = true;
			fs.rmSync(lockPath, { force: true });
		}
		return originalRenameSync(sourcePath, destinationPath);
	});
	assert.throws(() => intakeConsentedSample(options), /another corpus intake is active/);
	assert.equal(replacementAttempted, false);
	assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents);
	assert.equal(fs.lstatSync(lockPath).isFile(), true);
	assert(!fs.existsSync(options.manifestPath));
});

test('reclaims a provably dead benchmark before starting a supported corpus mutation', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	const benchmarkLockPath = path.join(corpusDirectory, '.benchmark.lock');
	const mutationLockPath = path.join(corpusDirectory, '.intake.lock');
	fs.mkdirSync(benchmarkLockPath, { recursive: true, mode: 0o700 });
	fs.writeFileSync(options.manifestPath, '{}\n', { mode: 0o600 });
	fs.writeFileSync(
		path.join(benchmarkLockPath, 'owner.json'),
		`${JSON.stringify({
			schema_version: 1,
			pid: 999_999_999,
			process_identity: 'dead-benchmark-process',
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: canonicalManifestPath(options.manifestPath),
			created_at: '2026-07-16T00:00:00.000Z',
		})}\n`,
		{ mode: 0o600 },
	);

	const mutationToken = acquireLocalCorpusLock(
		mutationLockPath,
		corpusDirectory,
		options.manifestPath,
		{
			operation: 'withdrawal',
			sessionId: 'session-withdraw',
		},
		{
			benchmarkAccessOptions: {
				isAlive: () => false,
			},
		},
	);
	try {
		assert.equal(fs.existsSync(benchmarkLockPath), false);
		assert.equal(
			fs.readdirSync(corpusDirectory).filter((name) => name.startsWith('.benchmark.lock.stale-'))
				.length,
			1,
		);
	} finally {
		releaseLocalCorpusLock(mutationLockPath, mutationToken);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('rejects a benchmark contender before it can hold the mutation lock or run recovery', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-precheck-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const corpusDirectory = path.join(directory, 'local-corpus');
	const mutationLockPath = path.join(corpusDirectory, '.intake.lock');
	const stalePath = path.join(
		corpusDirectory,
		'.intake.lock.stale-00000000-0000-4000-8000-000000000002',
	);
	const stagedDirectory = path.join(corpusDirectory, 'session-race');
	const stagedPath = path.join(
		stagedDirectory,
		'sample.wav.tmp-999999999-00000000-0000-4000-8000-000000000003',
	);
	fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
	fs.mkdirSync(stalePath, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(stalePath, 'owner.json'),
		`${JSON.stringify({
			schema_version: 3,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000002',
			manifest_path: canonicalManifestPath(manifestPath),
			operation: 'result-write',
			created_at: '2026-07-16T00:00:00.000Z',
		})}\n`,
		{ mode: 0o600 },
	);
	fs.mkdirSync(stagedDirectory, { mode: 0o700 });
	fs.writeFileSync(stagedPath, 'private interrupted bytes', { mode: 0o600 });
	const benchmark = acquireCorpusBenchmarkLock(manifestPath);
	try {
		assert.throws(
			() =>
				acquireLocalCorpusLock(mutationLockPath, corpusDirectory, manifestPath, {
					operation: 'benchmark-start',
				}),
			/another corpus benchmark is active/,
		);
		assert.equal(fs.existsSync(mutationLockPath), false);
		assert.deepEqual(
			fs.readdirSync(corpusDirectory).filter((name) => name.startsWith('.intake.lock.pending-')),
			[],
		);
		assert.equal(fs.existsSync(`${stalePath}.recovered`), false);
		assert.equal(fs.existsSync(stagedPath), true);
	} finally {
		assert.equal(releaseCorpusBenchmarkLock(benchmark.lockPath, benchmark.token), true);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('labels concurrent benchmark-start mutation-lock contention accurately', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-start-race-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const corpusDirectory = path.join(directory, 'local-corpus');
	const mutationLockPath = path.join(corpusDirectory, '.intake.lock');
	fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
	fs.mkdirSync(mutationLockPath, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(mutationLockPath, 'owner.json'),
		`${JSON.stringify({
			schema_version: 3,
			pid: process.pid,
			token: '00000000-0000-4000-8000-000000000005',
			manifest_path: canonicalManifestPath(manifestPath),
			operation: 'benchmark-start',
			created_at: '2026-07-16T00:00:00.000Z',
		})}\n`,
		{ mode: 0o600 },
	);
	try {
		assert.throws(
			() =>
				acquireLocalCorpusLock(mutationLockPath, corpusDirectory, manifestPath, {
					operation: 'benchmark-start',
				}),
			/another corpus benchmark is starting/,
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('authorized benchmark writers retry the narrow precheck-to-install contender race', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-writer-lock-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const corpusDirectory = path.join(directory, 'local-corpus');
	const mutationLockPath = path.join(corpusDirectory, '.intake.lock');
	const contenderToken = '00000000-0000-4000-8000-000000000004';
	fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
	fs.mkdirSync(mutationLockPath, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(mutationLockPath, 'owner.json'),
		`${JSON.stringify({
			schema_version: 3,
			pid: process.pid,
			token: contenderToken,
			manifest_path: canonicalManifestPath(manifestPath),
			operation: 'benchmark-start',
			created_at: '2026-07-16T00:00:00.000Z',
		})}\n`,
		{ mode: 0o600 },
	);
	const benchmark = acquireCorpusBenchmarkLock(manifestPath);
	let contenderReleased = false;
	let waits = 0;
	let writerToken;
	try {
		writerToken = acquireLocalCorpusLock(
			mutationLockPath,
			corpusDirectory,
			manifestPath,
			{
				operation: 'result-write',
				benchmarkToken: benchmark.token,
			},
			{
				benchmarkContentionAttempts: 2,
				benchmarkContentionDelayMs: 0,
				waitForRetry: () => {
					waits += 1;
					releaseLocalCorpusLock(mutationLockPath, contenderToken);
					contenderReleased = true;
				},
			},
		);
		assert.equal(waits, 1);
		assert.equal(fs.existsSync(mutationLockPath), true);
	} finally {
		if (writerToken) releaseLocalCorpusLock(mutationLockPath, writerToken);
		if (!contenderReleased) releaseLocalCorpusLock(mutationLockPath, contenderToken);
		assert.equal(releaseCorpusBenchmarkLock(benchmark.lockPath, benchmark.token), true);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('distinguishes a reused live PID only with a cross-process identity', () => {
	const owner = { pid: 1234, process_identity: 'original-process' };
	assert.equal(
		processOwnsState(owner, {
			isAlive: () => true,
			identityForPid: () => 'reused-process',
		}),
		false,
	);
	assert.equal(
		processOwnsState(owner, {
			isAlive: () => true,
			identityForPid: () => null,
		}),
		true,
	);
});

test('does not PID-clean result files for a reused live process', () => {
	const owners = [{ pid: 1234 }, { pid: 5678 }];
	assert.deepEqual(
		abandonedResultPids(owners, (pid) => pid === 1234),
		new Set([5678]),
	);
});

test('blocks intake until an interrupted withdrawal is resumed', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	fs.mkdirSync(corpusDirectory);
	const markerPath = path.join(corpusDirectory, '.withdrawal-session-withdraw.json');
	fs.writeFileSync(markerPath, '{}');

	assert.throws(() => intakeConsentedSample(options), /corpus withdrawal is pending/);
	assert(fs.existsSync(markerPath));
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
	assert(!fs.existsSync(options.manifestPath));
});

test('blocks intake on a non-regular withdrawal marker', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	fs.mkdirSync(path.join(corpusDirectory, '.withdrawal-session-withdraw.json'), {
		recursive: true,
	});

	assert.throws(() => intakeConsentedSample(options), /corpus withdrawal is pending/);
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
	assert(!fs.existsSync(options.manifestPath));
});

test('does not reclaim a durable withdrawal intent for new intake', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	const sessionDirectory = path.join(corpusDirectory, options.sessionId);
	fs.mkdirSync(sessionDirectory, { recursive: true });
	const promotedAudio = path.join(sessionDirectory, `${options.sampleId}.wav`);
	const promotedReference = path.join(sessionDirectory, `${options.sampleId}.txt`);
	fs.copyFileSync(options.audio, promotedAudio);
	fs.copyFileSync(options.reference, promotedReference);
	fs.writeFileSync(
		options.manifestPath,
		JSON.stringify({
			schema_version: 4,
			corpus_id: 'consented-meetings-v1',
			reference_protocol_id: REFERENCE_PROTOCOL_ID,
			description: 'Local-only participant-consented multilingual meeting corpus.',
			distribution: 'local',
			samples: [],
		}),
	);
	const lockPath = path.join(corpusDirectory, '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: options.manifestPath,
			operation: 'withdrawal',
			session_id: options.sessionId,
			orphan_cleanup: true,
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	assert.throws(() => intakeConsentedSample(options), /corpus withdrawal.*is pending/);
	assert(fs.existsSync(lockPath));
	assert(fs.existsSync(promotedAudio));
	assert(fs.existsSync(promotedReference));
	assert.deepEqual(JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')).samples, []);
});

test('reclaims interrupted intake files whether staged or already promoted', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	const sessionDirectory = path.join(corpusDirectory, options.sessionId);
	fs.mkdirSync(sessionDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(corpusDirectory, '.intake.lock'),
		JSON.stringify({ schema_version: 1, pid: 999_999_999, created_at: '2026-07-15T00:00:00Z' }),
	);
	const promotedAudio = path.join(sessionDirectory, `${options.sampleId}.wav`);
	const stagedReference = path.join(
		sessionDirectory,
		`${options.sampleId}.txt.tmp-123-123e4567-e89b-12d3-a456-426614174000`,
	);
	fs.copyFileSync(options.audio, promotedAudio);
	fs.writeFileSync(stagedReference, 'private staged bytes');

	intakeConsentedSample(options);
	assert(!fs.existsSync(stagedReference));
	assert(fs.existsSync(promotedAudio));
	assert.equal(JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')).samples.length, 1);
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
});

test('preserves unrelated untracked media during stale-lock recovery', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	const unrelatedDirectory = path.join(corpusDirectory, 'session-not-yet-imported');
	fs.mkdirSync(unrelatedDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(corpusDirectory, '.intake.lock'),
		JSON.stringify({ schema_version: 1, pid: 999_999_999, created_at: '2026-07-15T00:00:00Z' }),
	);
	const unrelatedAudio = path.join(unrelatedDirectory, 'only-copy.wav');
	const unrelatedReference = path.join(unrelatedDirectory, 'only-copy.txt');
	fs.writeFileSync(unrelatedAudio, 'only copy of consented audio');
	fs.writeFileSync(unrelatedReference, 'only copy of its reference');

	intakeConsentedSample(options);

	assert(fs.existsSync(unrelatedAudio));
	assert(fs.existsSync(unrelatedReference));
});

test('preserves recordings when stale-lock recovery finds an invalid manifest', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	const sessionDirectory = path.join(corpusDirectory, 'session-preserve');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(corpusDirectory, '.intake.lock'),
		JSON.stringify({ schema_version: 1, pid: 999_999_999, created_at: '2026-07-15T00:00:00Z' }),
	);
	const onlyCopy = path.join(sessionDirectory, 'only-copy.wav');
	fs.writeFileSync(onlyCopy, 'only copy of consented audio');
	fs.writeFileSync(
		options.manifestPath,
		JSON.stringify({
			schema_version: 4,
			corpus_id: 'consented-meetings-v1',
			reference_protocol_id: REFERENCE_PROTOCOL_ID,
			distribution: 'local',
			samples: {},
		}),
	);

	assert.throws(() => intakeConsentedSample(options), /existing corpus manifest is invalid/);
	assert(fs.existsSync(onlyCopy));
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
});

test('CLI imports through the documented consent-gated path', () => {
	const { bundleDirectory, options } = intakeFixture({ reviewCount: 0 });
	const cwd = fileURLToPath(new URL('../../..', import.meta.url));
	for (const reviewer of ['reviewer-cli-one', 'reviewer-cli-two']) {
		const attestation = spawnSync(
			'nub',
			[
				'run',
				'eval:corpus:attest',
				'--manifest',
				options.manifestPath,
				'--session-id',
				options.sessionId,
				'--reviewer',
				reviewer,
				'--accept-reviewed-reference',
				'--affirm-reference-protocol',
				REFERENCE_PROTOCOL_ID,
			],
			{ encoding: 'utf8', cwd },
		);
		assert.equal(attestation.status, 0, attestation.stderr);
		assert.match(attestation.stdout, /Recorded review [12]\/2/);
	}
	const run = spawnSync(
		'nub',
		[
			'run',
			'eval:corpus:intake',
			'--manifest',
			options.manifestPath,
			'--audio',
			options.audio,
			'--reference',
			options.reference,
			'--sample-id',
			options.sampleId,
			'--session-id',
			options.sessionId,
			'--consent-record-id',
			options.consentRecordId,
			'--consent-record',
			options.consentRecord,
			'--consent-date',
			options.consentDate,
			'--language',
			options.language,
			'--noise-condition',
			options.noiseCondition,
			'--speakers',
			String(options.speakers),
			'--affirm-all-participants-consented',
			'--affirm-reference-protocol',
			REFERENCE_PROTOCOL_ID,
		],
		{ encoding: 'utf8', cwd },
	);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /added en-clean-001: en \/ clean, 2\.0s, 2 speakers/);
	assert.equal(JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')).samples.length, 1);
	assert(!fs.existsSync(bundleDirectory));
});
