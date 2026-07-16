import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCorpusDocument, whisperLanguageForSample } from './corpus.mjs';

function hash(value) {
	return createHash('sha256').update(value).digest('hex');
}

function fixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-'));
	fs.writeFileSync(path.join(directory, 'audio.wav'), 'audio');
	fs.writeFileSync(path.join(directory, 'reference.txt'), 'hello');
	return {
		directory,
		document: {
			schema_version: 2,
			corpus_id: 'test-corpus',
			distribution: 'local',
			samples: [
				{
					id: 'meeting-en-clean',
					session_id: 'session-example-001',
					audio_path: 'audio.wav',
					audio_sha256: hash('audio'),
					reference_path: 'reference.txt',
					reference_sha256: hash('hello'),
					language: 'en-US',
					scenario: 'meeting',
					noise_condition: 'clean',
					speakers: 2,
					duration_seconds: 12.5,
					provenance: {
						basis: 'participant-consent',
						consent_record_id: 'consent-example-001',
						consent_date: '2026-07-16',
						consented_uses: ['asr-benchmarking'],
						redistribution: 'local-only',
					},
				},
			],
		},
	};
}

test('accepts an explicitly consented meeting sample', () => {
	const { directory, document } = fixture();
	assert.deepEqual(
		validateCorpusDocument(document, { manifestPath: path.join(directory, 'manifest.json') }),
		[],
	);
});

test('rejects meeting audio without participant consent', () => {
	const { directory, document } = fixture();
	document.samples[0].provenance = {
		basis: 'synthetic',
		generation_method: 'test generator',
		redistribution: 'repository',
	};
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('participant-consent for meeting recordings')));
});

test('rejects identity fields and changed fixture contents', () => {
	const { directory, document } = fixture();
	document.samples[0].provenance.participants = [{ email: 'person@example.com' }];
	fs.writeFileSync(path.join(directory, 'audio.wav'), 'changed');
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('participants is not an allowed field')));
	assert(errors.some((error) => error.includes('audio_sha256 does not match')));
});

test('rejects invalid consent dates and local-only entries in repository manifests', () => {
	const { directory, document } = fixture();
	document.distribution = 'repository';
	document.samples[0].provenance.consent_date = 'tomorrow';
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('valid YYYY-MM-DD date')));
	assert(errors.some((error) => error.includes('cannot be local-only in a repository manifest')));
});

test('requires opaque meeting sessions, multiple speakers, and local-only participant audio', () => {
	const { directory, document } = fixture();
	delete document.samples[0].session_id;
	document.samples[0].speakers = 1;
	document.samples[0].provenance.redistribution = 'repository';
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('session_id is required')));
	assert(errors.some((error) => error.includes('speakers must be at least 2')));
	assert(errors.some((error) => error.includes('must be local-only for participant')));
});

test('requires every discovered audio fixture to be declared', () => {
	const { directory, document } = fixture();
	const extraAudio = path.join(directory, 'unlisted.wav');
	fs.writeFileSync(extraAudio, 'audio');
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
		requiredAudioFiles: [path.join(directory, 'audio.wav'), extraAudio],
	});
	assert(errors.some((error) => error.includes('audio fixture is missing from the manifest')));
});

test('rejects nested consent-use data and reports invalid paths without throwing', () => {
	const { directory, document } = fixture();
	document.samples[0].provenance.consented_uses.push({ participants: [{ email: 'person@example.com' }] });
	document.samples[0].audio_path = 42;
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('may only contain known string values')));
	assert(errors.some((error) => error.includes('audio_path must be a non-empty string')));
});

test('normalizes BCP-47 locales and supports explicit Whisper mappings', () => {
	assert.equal(whisperLanguageForSample({ language: 'en-US' }), 'en');
	assert.equal(whisperLanguageForSample({ language: 'und' }), null);
	assert.equal(
		whisperLanguageForSample({ language: 'cmn-Hans', whisper_language: 'zh' }),
		'zh',
	);
});
