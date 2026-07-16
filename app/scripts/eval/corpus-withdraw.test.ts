import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { intakeConsentedSample } from './corpus-intake.ts';
import { withdrawConsentedSession } from './corpus-withdraw.ts';
import { validateCorpusDocument } from './corpus.ts';

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

test('withdraws files promoted by an interrupted intake before manifest commit', () => {
	const { directory, manifestPath } = corpusFixture();
	const before = fs.readFileSync(manifestPath, 'utf8');
	const orphanDirectory = path.join(directory, 'local-corpus', 'session-orphan');
	fs.mkdirSync(orphanDirectory);
	fs.writeFileSync(path.join(orphanDirectory, 'orphan.wav'), 'private promoted audio');
	fs.writeFileSync(path.join(orphanDirectory, 'orphan.txt'), 'private promoted transcript');
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(path.join(resultsDirectory, 'existing.json'), '{}');
	fs.writeFileSync(
		path.join(directory, 'local-corpus', '.intake.lock'),
		JSON.stringify({
			schema_version: 1,
			pid: 999_999_999,
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-orphan',
		confirmWithdrawal: true,
	});

	assert.deepEqual(result, {
		sessionId: 'session-orphan',
		removedSamples: 0,
		resumed: false,
	});
	assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
	assert(!fs.existsSync(orphanDirectory));
	assert(fs.existsSync(path.join(resultsDirectory, 'existing.json')));
	assert(!fs.existsSync(path.join(directory, 'local-corpus', '.intake.lock')));
});

test('withdraws a first interrupted intake before any manifest exists', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-first-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const orphanDirectory = path.join(directory, 'local-corpus', 'session-first');
	fs.mkdirSync(orphanDirectory, { recursive: true });
	fs.writeFileSync(path.join(orphanDirectory, 'first.wav'), 'private promoted audio');
	fs.writeFileSync(path.join(orphanDirectory, 'first.txt'), 'private promoted transcript');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'intake',
			session_id: 'session-first',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-first',
		confirmWithdrawal: true,
	});

	assert.deepEqual(result, {
		sessionId: 'session-first',
		removedSamples: 0,
		resumed: false,
	});
	assert(!fs.existsSync(manifestPath));
	assert(!fs.existsSync(orphanDirectory));
});

test('resumes orphan cleanup when withdrawal stops before its marker is written', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-orphan-retry-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const orphanDirectory = path.join(directory, 'local-corpus', 'session-first');
	fs.mkdirSync(orphanDirectory, { recursive: true });
	fs.writeFileSync(path.join(orphanDirectory, 'first.wav'), 'private promoted audio');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'withdrawal',
			session_id: 'session-first',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-first',
		confirmWithdrawal: true,
	});

	assert.deepEqual(result, {
		sessionId: 'session-first',
		removedSamples: 0,
		resumed: false,
	});
	assert(!fs.existsSync(manifestPath));
	assert(!fs.existsSync(orphanDirectory));
});

test('completes an orphan withdrawal whose cleanup finished before lock release', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-orphan-complete-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const localCorpusRoot = path.join(directory, 'local-corpus');
	fs.mkdirSync(localCorpusRoot);
	const lockPath = path.join(localCorpusRoot, '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'withdrawal',
			session_id: 'session-first',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-first',
		confirmWithdrawal: true,
	});

	assert.deepEqual(result, {
		sessionId: 'session-first',
		removedSamples: 0,
		resumed: true,
	});
	assert(!fs.existsSync(manifestPath));
	assert(!fs.existsSync(lockPath));
});

test('resumes orphan withdrawal intent after its lock was moved stale', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-orphan-stale-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const localCorpusRoot = path.join(directory, 'local-corpus');
	const sessionDirectory = path.join(localCorpusRoot, 'session-first');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	fs.writeFileSync(path.join(sessionDirectory, 'first.wav'), 'private promoted audio');
	const staleLockPath = path.join(
		localCorpusRoot,
		'.intake.lock.stale-00000000-0000-4000-8000-000000000001',
	);
	fs.mkdirSync(staleLockPath);
	fs.writeFileSync(
		path.join(staleLockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'withdrawal',
			session_id: 'session-first',
			orphan_cleanup: true,
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-first',
		confirmWithdrawal: true,
	});

	assert.deepEqual(result, {
		sessionId: 'session-first',
		removedSamples: 0,
		resumed: false,
	});
	assert(!fs.existsSync(sessionDirectory));
	assert(fs.existsSync(`${staleLockPath}.recovered`));
});

test('does not reuse consumed stale-lock evidence for orphan cleanup', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-consumed-stale-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const localCorpusRoot = path.join(directory, 'local-corpus');
	const sessionDirectory = path.join(localCorpusRoot, 'session-first');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	const recording = path.join(sessionDirectory, 'only-copy.wav');
	fs.writeFileSync(recording, 'unrelated private recording');
	const staleLockPath = path.join(
		localCorpusRoot,
		'.intake.lock.stale-00000000-0000-4000-8000-000000000001',
	);
	fs.mkdirSync(staleLockPath);
	fs.writeFileSync(
		path.join(staleLockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'intake',
			session_id: 'session-first',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);
	fs.writeFileSync(`${staleLockPath}.recovered`, '{}');

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-first',
				confirmWithdrawal: true,
			}),
		/corpus manifest does not exist/,
	);
	assert(fs.existsSync(recording));
	assert(fs.existsSync(sessionDirectory));
});

test('completes an orphan withdrawal against an existing manifest after cleanup', () => {
	const { directory, manifestPath } = corpusFixture();
	const before = fs.readFileSync(manifestPath, 'utf8');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'withdrawal',
			session_id: 'session-orphan',
			orphan_cleanup: true,
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-orphan',
		confirmWithdrawal: true,
	});

	assert.deepEqual(result, {
		sessionId: 'session-orphan',
		removedSamples: 0,
		resumed: true,
	});
	assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
	assert(!fs.existsSync(lockPath));
});

test('does not treat an interrupted unknown-session check as completed cleanup', () => {
	const { directory, manifestPath } = corpusFixture();
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'withdrawal',
			session_id: 'session-unknown',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-unknown',
				confirmWithdrawal: true,
			}),
		/not present/,
	);
});

test('preserves session data when a missing manifest lacks matching intake evidence', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-typo-'));
	const manifestPath = path.join(directory, 'corpus-typo.json');
	const sessionDirectory = path.join(directory, 'local-corpus', 'session-existing');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	const recording = path.join(sessionDirectory, 'existing.wav');
	fs.writeFileSync(recording, 'private recording');

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-existing',
				confirmWithdrawal: true,
			}),
		/corpus manifest does not exist/,
	);
	assert(fs.existsSync(recording));
	assert(fs.existsSync(sessionDirectory));
});

test('preserves matching intake evidence after a mistyped manifest path', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-retry-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const typoManifestPath = path.join(directory, 'corpus-lcoal.json');
	const sessionDirectory = path.join(directory, 'local-corpus', 'session-first');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	const recording = path.join(sessionDirectory, 'first.wav');
	fs.writeFileSync(recording, 'private promoted audio');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'intake',
			session_id: 'session-first',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath: typoManifestPath,
				sessionId: 'session-first',
				confirmWithdrawal: true,
			}),
		/corpus manifest does not exist/,
	);
	assert(fs.existsSync(lockPath));
	assert(fs.existsSync(recording));

	withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-first',
		confirmWithdrawal: true,
	});
	assert(!fs.existsSync(sessionDirectory));
});

test('requires intake evidence for the exact withdrawn session', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-withdraw-session-lock-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const sessionDirectory = path.join(directory, 'local-corpus', 'session-other');
	fs.mkdirSync(sessionDirectory, { recursive: true });
	const recording = path.join(sessionDirectory, 'other.wav');
	fs.writeFileSync(recording, 'unrelated private audio');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.mkdirSync(lockPath);
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		JSON.stringify({
			schema_version: 2,
			pid: 999_999_999,
			token: '00000000-0000-4000-8000-000000000001',
			manifest_path: manifestPath,
			operation: 'intake',
			session_id: 'session-first',
			created_at: '2026-07-16T00:00:00Z',
		}),
	);

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-other',
				confirmWithdrawal: true,
			}),
		/corpus manifest does not exist/,
	);
	assert(fs.existsSync(lockPath));
	assert(fs.existsSync(recording));
});

test('refuses orphan cleanup when a retained sample reaches it through an alias', () => {
	const { directory, manifestPath } = corpusFixture();
	const orphanDirectory = path.join(directory, 'local-corpus', 'session-orphan');
	fs.mkdirSync(orphanDirectory);
	const retainedAudio = path.join(orphanDirectory, 'retained.wav');
	writeWav(retainedAudio, 4);
	const aliasDirectory = path.join(directory, 'orphan-alias');
	fs.symlinkSync(orphanDirectory, aliasDirectory, 'dir');
	const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	const retained = document.samples.find((sample) => sample.session_id === 'session-keep');
	retained.audio_path = 'orphan-alias/retained.wav';
	retained.audio_sha256 = createHash('sha256').update(fs.readFileSync(retainedAudio)).digest('hex');
	fs.writeFileSync(manifestPath, JSON.stringify(document));

	assert.throws(
		() =>
			withdrawConsentedSession({
				manifestPath,
				sessionId: 'session-orphan',
				confirmWithdrawal: true,
			}),
		/remaining sample es-clean-003 shares its directory/,
	);
	assert(fs.existsSync(retainedAudio));
	assert(fs.existsSync(orphanDirectory));
});

test('completes withdrawal when target files were already partially deleted', () => {
	const { directory, manifestPath } = corpusFixture();
	const missingAudio = path.join(
		directory,
		'local-corpus',
		'session-withdraw',
		'en-clean-001.wav',
	);
	fs.rmSync(missingAudio);
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(path.join(resultsDirectory, 'stale.json'), '{}');

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-withdraw',
		confirmWithdrawal: true,
	});

	assert.equal(result.removedSamples, 2);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(manifestPath, 'utf8')).samples.map((sample) => sample.id),
		['es-clean-003'],
	);
	assert(!fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(!fs.existsSync(resultsDirectory));
});

test('withdraws consent even when an unrelated retained sample file is missing', () => {
	const { directory, manifestPath } = corpusFixture();
	const missingReference = path.join(
		directory,
		'local-corpus',
		'session-keep',
		'es-clean-003.txt',
	);
	fs.rmSync(missingReference);

	const result = withdrawConsentedSession({
		manifestPath,
		sessionId: 'session-withdraw',
		confirmWithdrawal: true,
	});

	assert.equal(result.removedSamples, 2);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(manifestPath, 'utf8')).samples.map((sample) => sample.id),
		['es-clean-003'],
	);
	assert(!fs.existsSync(path.join(directory, 'local-corpus/session-withdraw')));
	assert(!fs.existsSync(missingReference));
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
