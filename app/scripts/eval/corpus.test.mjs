import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateCorpusDocument } from './corpus.mjs';

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
			schema_version: 1,
			corpus_id: 'test-corpus',
			samples: [
				{
					id: 'meeting-en-clean',
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
	document.samples[0].provenance.email = 'person@example.com';
	fs.writeFileSync(path.join(directory, 'audio.wav'), 'changed');
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('must not contain participant identity')));
	assert(errors.some((error) => error.includes('audio_sha256 does not match')));
});
