import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	abandonedResultPids,
	intakeConsentedSample,
	localCalendarDate,
	parseIntakeArgs,
	wavDurationSeconds,
} from './corpus-intake.ts';
import { validateCorpusDocument } from './corpus.ts';
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

function intakeFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-intake-'));
	const audio = path.join(directory, 'source.wav');
	const reference = path.join(directory, 'source.txt');
	const consentRecord = path.join(directory, 'consent-record.md');
	writeWav(audio);
	fs.writeFileSync(reference, 'Hello from the consented meeting.\n');
	fs.writeFileSync(consentRecord, 'Encrypted-system export or signed affirmative record.\n');
	return {
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
			today: '2026-07-16',
		},
	};
}

test('reads duration from RIFF/WAVE structure', () => {
	const { directory } = intakeFixture();
	assert.equal(wavDurationSeconds(path.join(directory, 'source.wav')), 2);
	const invalid = path.join(directory, 'invalid.wav');
	fs.writeFileSync(invalid, 'not wave audio');
	assert.throws(() => wavDurationSeconds(invalid), /RIFF\/WAVE|truncated/);
});

test('requires explicit consent affirmation before writing anything', () => {
	const { directory, options } = intakeFixture();
	options.affirmConsent = false;
	assert.throws(() => intakeConsentedSample(options), /affirm-all-participants-consented/);
	assert.deepEqual(fs.readdirSync(directory).sort(), [
		'consent-record.md',
		'source.txt',
		'source.wav',
	]);
});

test('rejects malformed UTF-8 references before writing anything', () => {
	const { directory, options } = intakeFixture();
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
		const { directory, options } = intakeFixture();
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
	const { directory, options } = intakeFixture();
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

test('updates the canonical manifest when intake is invoked through a symlink', () => {
	const { directory, options } = intakeFixture();
	const canonicalDirectory = path.join(directory, 'canonical');
	const aliasDirectory = path.join(directory, 'alias');
	fs.mkdirSync(canonicalDirectory);
	fs.mkdirSync(aliasDirectory);
	const canonicalManifest = path.join(canonicalDirectory, 'corpus-local.json');
	const aliasManifest = path.join(aliasDirectory, 'corpus-local.json');
	fs.writeFileSync(
		canonicalManifest,
		JSON.stringify({
			schema_version: 2,
			corpus_id: 'consented-meetings-v1',
			description: 'Local-only participant-consented multilingual meeting corpus.',
			distribution: 'local',
			samples: [],
		}),
	);
	fs.symlinkSync(canonicalManifest, aliasManifest);
	options.manifestPath = aliasManifest;

	intakeConsentedSample(options);

	assert(fs.lstatSync(aliasManifest).isSymbolicLink());
	assert.equal(JSON.parse(fs.readFileSync(canonicalManifest, 'utf8')).samples.length, 1);
	assert(fs.existsSync(path.join(canonicalDirectory, 'local-corpus', options.sessionId)));
	assert(!fs.existsSync(path.join(aliasDirectory, 'local-corpus')));
});

test('initializes the target behind a dangling manifest symlink', () => {
	const { directory, options } = intakeFixture();
	const canonicalManifest = path.join(directory, 'canonical', 'corpus-local.json');
	const aliasManifest = path.join(directory, 'corpus-alias.json');
	fs.symlinkSync(canonicalManifest, aliasManifest);
	options.manifestPath = aliasManifest;

	intakeConsentedSample(options);

	assert(fs.lstatSync(aliasManifest).isSymbolicLink());
	assert.equal(JSON.parse(fs.readFileSync(canonicalManifest, 'utf8')).samples.length, 1);
	assert(fs.existsSync(path.join(directory, 'canonical', 'local-corpus', options.sessionId)));
});

test('rejects filesystem aliases into the managed corpus tree', () => {
	const { directory, options } = intakeFixture();
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

test('rejects external file symlinks into the managed corpus tree', () => {
	const { directory, options } = intakeFixture();
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
		const { directory, options } = intakeFixture();
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

test('atomically imports a consented sample with verified metadata and private files', () => {
	const { options } = intakeFixture();
	const sample = intakeConsentedSample(options);
	assert.equal(sample.duration_seconds, 2);
	assert.equal(sample.provenance.consent_record_id, 'consent-opaque-001');
	const document = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'));
	assert.deepEqual(validateCorpusDocument(document, { manifestPath: options.manifestPath }), []);
	assert.equal(document.samples.length, 1);
	assert.equal(
		fs.readFileSync(
			path.resolve(path.dirname(options.manifestPath), sample.reference_path),
			'utf8',
		),
		'Hello from the consented meeting.\n',
	);
	assert(!fs.readFileSync(options.manifestPath, 'utf8').includes('signed affirmative record'));
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(options.manifestPath).mode & 0o777, 0o600);
		assert.equal(
			fs.statSync(path.resolve(path.dirname(options.manifestPath), sample.audio_path)).mode & 0o777,
			0o600,
		);
	}
});

test('retires a matching prepared source bundle after successful intake', () => {
	const { directory, options } = intakeFixture();
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
			schemaVersion: 1,
			sessionId: options.sessionId,
			consentRecordId: options.consentRecordId,
			sampleId: options.sampleId,
			language: options.language,
			noiseCondition: options.noiseCondition,
			manifestPath: options.manifestPath,
			audioPath: audio,
			referencePath: reference,
			consentRecordPath: options.consentRecord,
		}),
	);

	intakeConsentedSample(options);

	assert(!fs.existsSync(bundleDirectory));
	assert(fs.existsSync(path.join(directory, 'local-corpus', options.sessionId)));
	assert(fs.existsSync(options.consentRecord));
});

test('rejects duplicate audio without changing the existing corpus', () => {
	const { options } = intakeFixture();
	intakeConsentedSample(options);
	const before = fs.readFileSync(options.manifestPath, 'utf8');
	assert.throws(
		() =>
			intakeConsentedSample({
				...options,
				sampleId: 'en-office-002',
				sessionId: 'session-opaque-002',
				noiseCondition: 'office',
			}),
		/audio_sha256 duplicates sample/,
	);
	assert.equal(fs.readFileSync(options.manifestPath, 'utf8'), before);
	assert(
		!fs.existsSync(
			path.join(path.dirname(options.manifestPath), 'local-corpus/session-opaque-002'),
		),
	);
});

test('rejects future consent dates and incomplete CLI values', () => {
	const { options } = intakeFixture();
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
	const { directory, options } = intakeFixture();
	options.sessionId = '../../outside';
	assert.throws(() => intakeConsentedSample(options), /opaque session/);
	assert(!fs.existsSync(path.join(directory, 'local-corpus')));
});

test('serializes manifest updates with an exclusive local intake lock', () => {
	const { directory, options } = intakeFixture();
	const corpusDirectory = path.join(directory, 'local-corpus');
	fs.mkdirSync(corpusDirectory);
	fs.writeFileSync(
		path.join(corpusDirectory, '.intake.lock'),
		JSON.stringify({ schema_version: 1, pid: process.pid, created_at: new Date().toISOString() }),
	);
	assert.throws(() => intakeConsentedSample(options), /another corpus intake is active/);
	assert(!fs.existsSync(options.manifestPath));
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
			schema_version: 2,
			corpus_id: 'consented-meetings-v1',
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
			schema_version: 2,
			corpus_id: 'consented-meetings-v1',
			distribution: 'local',
			samples: {},
		}),
	);

	assert.throws(() => intakeConsentedSample(options), /existing corpus manifest is invalid/);
	assert(fs.existsSync(onlyCopy));
	assert(!fs.existsSync(path.join(corpusDirectory, '.intake.lock')));
});

test('CLI imports through the documented consent-gated path', () => {
	const { options } = intakeFixture();
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
		],
		{ encoding: 'utf8', cwd: fileURLToPath(new URL('../../..', import.meta.url)) },
	);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /added en-clean-001: en \/ clean, 2\.0s, 2 speakers/);
	assert.equal(JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')).samples.length, 1);
});
