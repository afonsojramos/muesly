import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeConsentedSample, parseIntakeArgs, wavDurationSeconds } from './corpus-intake.mjs';
import { validateCorpusDocument } from './corpus.mjs';

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
	fs.writeFileSync(path.join(corpusDirectory, '.intake.lock'), 'busy');
	assert.throws(() => intakeConsentedSample(options), /another corpus intake is active/);
	assert(!fs.existsSync(options.manifestPath));
});

test('CLI imports through the documented consent-gated path', () => {
	const { options } = intakeFixture();
	const command = fileURLToPath(new URL('./corpus-intake.mjs', import.meta.url));
	const run = spawnSync(
		process.execPath,
		[
			command,
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
		{ encoding: 'utf8' },
	);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /added en-clean-001: en \/ clean, 2\.0s, 2 speakers/);
	assert.equal(JSON.parse(fs.readFileSync(options.manifestPath, 'utf8')).samples.length, 1);
});
