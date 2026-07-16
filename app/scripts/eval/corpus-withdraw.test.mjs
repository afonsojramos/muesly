import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeConsentedSample } from './corpus-intake.mjs';
import { withdrawConsentedSession } from './corpus-withdraw.mjs';
import { validateCorpusDocument } from './corpus.mjs';

function writeWav(filePath, durationSeconds) {
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

function corpusFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const consentRecord = path.join(directory, 'consent.md');
	fs.writeFileSync(consentRecord, 'affirmative consent record');
	for (const [index, sample] of [
		['one', { sampleId: 'en-clean-001', sessionId: 'session-withdraw', duration: 1 }],
		['two', { sampleId: 'en-office-002', sessionId: 'session-withdraw', duration: 2 }],
		['three', { sampleId: 'es-clean-003', sessionId: 'session-keep', duration: 3 }],
	]) {
		const audio = path.join(directory, `${index}.wav`);
		const reference = path.join(directory, `${index}.txt`);
		writeWav(audio, sample.duration);
		fs.writeFileSync(reference, `Reference ${index}.\n`);
		intakeConsentedSample({
			manifestPath,
			audio,
			reference,
			sampleId: sample.sampleId,
			sessionId: sample.sessionId,
			consentRecordId: `consent-${index}`,
			consentRecord,
			consentDate: '2026-07-15',
			language: index === 'three' ? 'es' : 'en',
			noiseCondition: index === 'two' ? 'office' : 'clean',
			speakers: 2,
			affirmConsent: true,
			today: '2026-07-16',
		});
	}
	return { directory, manifestPath };
}

test('withdraws every sample in one session and invalidates derived results', () => {
	const { directory, manifestPath } = corpusFixture();
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(path.join(resultsDirectory, 'aggregate.json'), '{}');

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-withdraw',
		confirmWithdrawal: true,
	});
	assert.deepEqual(result, {
		sessionId: 'session-withdraw',
		removedSamples: 2,
		resumed: false,
	});
	const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	assert.deepEqual(validateCorpusDocument(document, { manifestPath }), []);
	assert.deepEqual(document.samples.map((sample) => sample.id), ['es-clean-003']);
	assert(!fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(fs.existsSync(path.join(directory, 'local-corpus/session-keep')));
	assert(!fs.existsSync(resultsDirectory));
});

test('requires explicit confirmation and leaves unknown sessions unchanged', () => {
	const { manifestPath } = corpusFixture();
	const before = fs.readFileSync(manifestPath, 'utf8');
	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-withdraw',
				confirmWithdrawal: false,
			}),
		/confirm-withdrawal/,
	);
	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-missing',
				confirmWithdrawal: true,
			}),
		/not present/,
	);
	assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('refuses to delete files outside the opaque session directory', () => {
	const { directory, manifestPath } = corpusFixture();
	const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const outsideAudio = path.join(directory, 'outside.wav');
	writeWav(outsideAudio, 4);
	document.samples[0].audio_path = 'outside.wav';
	document.samples[0].audio_sha256 = createHash('sha256')
		.update(fs.readFileSync(outsideAudio))
		.digest('hex');
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	assert.deepEqual(validateCorpusDocument(document, { manifestPath }), []);
	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-withdraw',
				confirmWithdrawal: true,
			}),
		/outside session-withdraw/,
	);
	assert(fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(fs.existsSync(outsideAudio));
});

test('refuses to delete a directory shared by a remaining manifest sample', () => {
	const { directory, manifestPath } = corpusFixture();
	const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const sharedReference = path.join(
		directory,
		'local-corpus',
		'session-withdraw',
		'shared-reference.txt',
	);
	fs.writeFileSync(sharedReference, 'Shared reference.\n');
	document.samples[2].reference_path = 'local-corpus/session-withdraw/shared-reference.txt';
	document.samples[2].reference_sha256 = createHash('sha256')
		.update(fs.readFileSync(sharedReference))
		.digest('hex');
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	assert.deepEqual(validateCorpusDocument(document, { manifestPath }), []);

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-withdraw',
				confirmWithdrawal: true,
			}),
		/remaining sample es-clean-003 shares its directory/,
	);
	assert(fs.existsSync(sharedReference));
});

test('resumes cleanup without deleting results regenerated after the manifest commit', () => {
	const { directory, manifestPath } = corpusFixture();
	const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	document.samples = document.samples.filter((sample) => sample.session_id !== 'session-withdraw');
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	const quarantineName = '.withdrawal-results-session-withdraw-00000000-0000-4000-8000-000000000000';
	const markerPath = path.join(
		directory,
		'local-corpus',
		'.withdrawal-session-withdraw.json',
	);
	fs.writeFileSync(
		markerPath,
		JSON.stringify({
			schema_version: 2,
			session_id: 'session-withdraw',
			removed_samples: 2,
			results_quarantine: quarantineName,
			started_at: '2026-07-16T00:00:00Z',
		}),
	);
	const quarantineDirectory = path.join(directory, 'local-corpus', quarantineName);
	fs.mkdirSync(quarantineDirectory);
	fs.writeFileSync(path.join(quarantineDirectory, 'stale.json'), '{}');
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(path.join(resultsDirectory, 'regenerated.json'), '{}');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-withdraw',
		confirmWithdrawal: true,
	});
	assert.deepEqual(result, {
		sessionId: 'session-withdraw',
		removedSamples: 2,
		resumed: true,
	});
	assert(!fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(fs.existsSync(path.join(resultsDirectory, 'regenerated.json')));
	assert(!fs.existsSync(quarantineDirectory));
	assert(!fs.existsSync(markerPath));
});

test('conservatively completes a version 1 post-commit withdrawal marker', () => {
	const { directory, manifestPath } = corpusFixture();
	const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	document.samples = document.samples.filter((sample) => sample.session_id !== 'session-withdraw');
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	const markerPath = path.join(
		directory,
		'local-corpus',
		'.withdrawal-session-withdraw.json',
	);
	fs.writeFileSync(
		markerPath,
		JSON.stringify({
			schema_version: 1,
			session_id: 'session-withdraw',
			removed_samples: 2,
			results_quarantine: '..',
			started_at: '2026-07-16T00:00:00Z',
		}),
	);
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(path.join(resultsDirectory, 'possibly-regenerated.json'), '{}');

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-withdraw',
		confirmWithdrawal: true,
	});
	assert.equal(result.resumed, true);
	assert(fs.existsSync(path.join(resultsDirectory, 'possibly-regenerated.json')));
	assert(fs.existsSync(directory));
	assert(!fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(!fs.existsSync(markerPath));
});

test('migrates a version 1 pre-commit withdrawal marker', () => {
	const { directory, manifestPath } = corpusFixture();
	const markerPath = path.join(
		directory,
		'local-corpus',
		'.withdrawal-session-withdraw.json',
	);
	fs.writeFileSync(
		markerPath,
		JSON.stringify({
			schema_version: 1,
			session_id: 'session-withdraw',
			removed_samples: 2,
			started_at: '2026-07-16T00:00:00Z',
		}),
	);
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(path.join(resultsDirectory, 'stale.json'), '{}');

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-withdraw',
		confirmWithdrawal: true,
	});
	assert.equal(result.resumed, false);
	assert(!fs.existsSync(resultsDirectory));
	assert(!fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(!fs.existsSync(markerPath));
});

test('CLI performs the documented confirmed withdrawal', () => {
	const { manifestPath } = corpusFixture();
	const run = spawnSync(
		'nub',
		[
			'run',
			'eval:corpus:withdraw',
			'--manifest',
			manifestPath,
			'--session-id',
			'session-withdraw',
			'--confirm-withdrawal',
		],
		{ encoding: 'utf8', cwd: fileURLToPath(new URL('../../..', import.meta.url)) },
	);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /withdrew session-withdraw: removed 2 sample\(s\)/);
	assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).samples.length, 1);
});
