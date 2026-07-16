import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	corpusFingerprint,
	fileSha256,
	loadCorpus,
	validateCorpusDocument,
	whisperLanguageForSample,
} from './corpus.ts';

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

test('loads a manifest through its canonical file identity', () => {
	const { directory, document } = fixture();
	const manifestPath = path.join(directory, 'manifest.json');
	const manifestAlias = path.join(directory, 'manifest-alias.json');
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	fs.symlinkSync(manifestPath, manifestAlias);

	const corpus = loadCorpus(manifestAlias);
	assert.equal(corpus.manifest_path, fs.realpathSync(manifestPath));
	assert.equal(corpus.samples[0].audio_file, fs.realpathSync(path.join(directory, 'audio.wav')));
	assert(fs.lstatSync(manifestAlias).isSymbolicLink());
});

test('hashes corpus files incrementally across multiple buffer reads', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-hash-'));
	const filePath = path.join(directory, 'large.wav');
	const contents = Buffer.alloc(2 * 1024 * 1024 + 137, 0x5a);
	fs.writeFileSync(filePath, contents);
	assert.equal(fileSha256(filePath), createHash('sha256').update(contents).digest('hex'));
});

test('allows an empty local corpus but not an empty repository corpus', () => {
	const local = {
		schema_version: 2,
		corpus_id: 'consented-meetings-v1',
		description: 'Local-only participant-consented multilingual meeting corpus.',
		distribution: 'local',
		samples: [],
	};
	assert.deepEqual(validateCorpusDocument(local, { checkFiles: false }), []);
	assert.deepEqual(
		validateCorpusDocument({ ...local, distribution: 'repository' }, { checkFiles: false }),
		['samples must be non-empty for a repository corpus'],
	);
});

test('rejects meeting samples without a WER reference', () => {
	const { directory, document } = fixture();
	fs.writeFileSync(path.join(directory, 'reference.txt'), '   \n');
	document.samples[0].reference_sha256 = hash('   \n');
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('must contain a meeting transcript')));
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

test('rejects copied audio assigned to another sample', () => {
	const { directory, document } = fixture();
	document.samples.push({
		...structuredClone(document.samples[0]),
		id: 'meeting-en-clean-copy',
		session_id: 'session-example-002',
	});
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('audio_sha256 duplicates sample')));
});

test('rejects copied audio relabeled within the same session', () => {
	const { directory, document } = fixture();
	document.samples.push({
		...structuredClone(document.samples[0]),
		id: 'meeting-en-office-copy',
		noise_condition: 'office',
	});
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('audio_sha256 duplicates sample')));
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
	document.samples[0].provenance.consented_uses.push({
		participants: [{ email: 'person@example.com' }],
	});
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
	assert.equal(whisperLanguageForSample({ language: 'cmn-Hans', whisper_language: 'zh' }), 'zh');
});

test('fingerprints the canonical corpus revision', () => {
	const { document } = fixture();
	const reordered = JSON.parse(JSON.stringify(document));
	reordered.samples[0] = Object.fromEntries(Object.entries(reordered.samples[0]).reverse());
	assert.equal(corpusFingerprint(document), corpusFingerprint(reordered));
	reordered.samples[0].noise_condition = 'remote-call';
	assert.notEqual(corpusFingerprint(document), corpusFingerprint(reordered));
});
