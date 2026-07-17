import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	canonicalManifestPath,
	corpusFingerprint,
	fileSha256,
	loadCorpus,
	REFERENCE_PROTOCOL_ID,
	validateCorpusDocument,
	whisperLanguageForSample,
} from './corpus.ts';

function hash(value) {
	return createHash('sha256').update(value).digest('hex');
}

function fixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-'));
	const sessionDirectory = path.join(
		directory,
		'local-corpus',
		'session-example-001',
	);
	fs.mkdirSync(sessionDirectory, { recursive: true });
	fs.writeFileSync(path.join(sessionDirectory, 'meeting-en-clean.wav'), 'audio');
	fs.writeFileSync(path.join(sessionDirectory, 'meeting-en-clean.txt'), 'hello');
	return {
		directory,
		document: {
			schema_version: 4,
			corpus_id: 'test-corpus',
			reference_protocol_id: REFERENCE_PROTOCOL_ID,
			distribution: 'local',
			samples: [
				{
					id: 'meeting-en-clean',
					session_id: 'session-example-001',
					audio_path:
						'local-corpus/session-example-001/meeting-en-clean.wav',
					audio_sha256: hash('audio'),
					reference_path:
						'local-corpus/session-example-001/meeting-en-clean.txt',
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
	assert.equal(
		corpus.samples[0].audio_file,
		fs.realpathSync(
			path.join(
				directory,
				'local-corpus',
				'session-example-001',
				'meeting-en-clean.wav',
			),
		),
	);
	assert(fs.lstatSync(manifestAlias).isSymbolicLink());
});

test('loads a schema-3 local manifest as a strict in-memory schema-4 projection', () => {
	const { directory, document } = fixture();
	const manifestPath = path.join(directory, 'corpus-local.json');
	const previous = { ...document, schema_version: 3 };
	fs.writeFileSync(manifestPath, JSON.stringify(previous));

	const corpus = loadCorpus(manifestPath);

	assert.equal(corpus.schema_version, 4);
	assert.equal(corpus.corpus_fingerprint, corpusFingerprint({ ...previous, schema_version: 4 }));
	assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).schema_version, 3);
	assert.deepEqual(validateCorpusDocument(previous, { manifestPath }), [
		'schema_version must be 4',
	]);
	assert.throws(
		() => {
			fs.writeFileSync(
				manifestPath,
				JSON.stringify({ ...previous, distribution: 'repository' }),
			);
			loadCorpus(manifestPath);
		},
		/schema_version must be 4/,
	);
});

test('resolves a dangling manifest symlink to its intended missing target', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-dangling-'));
	const targetPath = path.join(directory, 'target', 'corpus-local.json');
	const aliasPath = path.join(directory, 'corpus-alias.json');
	fs.symlinkSync(targetPath, aliasPath);

	assert.equal(
		canonicalManifestPath(aliasPath, { allowMissing: true }),
		fs.realpathSync(directory) + path.sep + 'target' + path.sep + 'corpus-local.json',
	);
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
		schema_version: 4,
		corpus_id: 'consented-meetings-v1',
		reference_protocol_id: REFERENCE_PROTOCOL_ID,
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

test('rejects legacy and differently versioned reference manifests without upgrading them', () => {
	const { document } = fixture();
	const legacy = { ...document, schema_version: 2 };
	delete legacy.reference_protocol_id;
	assert.deepEqual(validateCorpusDocument(legacy, { checkFiles: false }), [
		'schema_version must be 4',
		`reference_protocol_id must be '${REFERENCE_PROTOCOL_ID}'`,
	]);
	assert.equal(legacy.schema_version, 2);
	assert.equal(legacy.reference_protocol_id, undefined);

	assert.match(
		validateCorpusDocument(
			{ ...document, reference_protocol_id: 'another-reference-v1' },
			{ checkFiles: false },
		).join('\n'),
		/reference_protocol_id must be 'muesly-meeting-reference-v1'/,
	);
});

test('rejects empty speech references outside the checked-in synthetic silence fixture', () => {
	const { directory, document } = fixture();
	fs.writeFileSync(
		path.join(
			directory,
			'local-corpus',
			'session-example-001',
			'meeting-en-clean.txt',
		),
		'   \n',
	);
	document.samples[0].reference_sha256 = hash('   \n');
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('must contain a speech reference')));

	document.samples[0].scenario = 'dictation';
	const dictationErrors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(dictationErrors.some((error) => error.includes('must contain a speech reference')));

	document.samples[0] = {
		...document.samples[0],
		id: 'und-synthetic-silence',
		scenario: 'silence',
		provenance: {
			basis: 'synthetic',
			generation_method:
				'Deterministic approximately -60 dBFS noise generated for hallucination testing',
			redistribution: 'local-only',
		},
	};
	const impostorErrors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(impostorErrors.some((error) => error.includes('must contain a speech reference')));

	const committedManifestPath = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		'corpus-manifest.json',
	);
	const committedManifest = JSON.parse(fs.readFileSync(committedManifestPath, 'utf8'));
	assert.deepEqual(
		validateCorpusDocument(committedManifest, { manifestPath: committedManifestPath }),
		[],
	);
});

test('rejects invalid UTF-8 in every checked reference', () => {
	const { directory, document } = fixture();
	const referencePath = path.join(
		directory,
		'local-corpus',
		'session-example-001',
		'meeting-en-clean.txt',
	);
	const invalidUtf8 = Buffer.from([0xc3, 0x28]);
	fs.writeFileSync(referencePath, invalidUtf8);
	document.samples[0].reference_sha256 = hash(invalidUtf8);
	document.samples[0].scenario = 'dictation';

	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(errors.some((error) => error.includes('reference_path must be valid UTF-8')));
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
	assert(
		errors.some((error) =>
			error.includes('participant-consent or public-license for meeting recordings'),
		),
	);
});

test('accepts open-licensed meeting audio only when it is bound to a source catalog', () => {
	const { directory, document } = fixture();
	document.source_catalog_sha256 = 'a'.repeat(64);
	document.samples[0].provenance = {
		basis: 'public-license',
		redistribution: 'local-only',
		source_catalog_id: 'ami',
		source_item_ids: ['EN2001a/headset-mix/00:02:00-00:05:00'],
		transform_id: 'clean',
	};
	assert.deepEqual(
		validateCorpusDocument(document, { manifestPath: path.join(directory, 'manifest.json') }),
		[],
	);

	delete document.source_catalog_sha256;
	assert(
		validateCorpusDocument(document, {
			manifestPath: path.join(directory, 'manifest.json'),
		}).includes('source_catalog_sha256 is required for public-license samples'),
	);
});

test('rejects ambiguous or unbounded public-license source bindings', () => {
	const { document } = fixture();
	document.source_catalog_sha256 = 'not-a-digest';
	document.samples[0].provenance = {
		basis: 'public-license',
		redistribution: 'repository',
		source_catalog_id: 'AMI',
		source_item_ids: ['item-1', 'item-1', 'x'.repeat(257)],
		transform_id: 'Clean',
	};
	const errors = validateCorpusDocument(document, { checkFiles: false });
	assert(errors.includes('source_catalog_sha256 must be a lowercase SHA-256 digest'));
	assert(errors.some((error) => error.includes('source_catalog_id must be a lowercase slug')));
	assert(errors.some((error) => error.includes("contains duplicate 'item-1'")));
	assert(errors.some((error) => error.includes('bounded single-line string')));
	assert(errors.some((error) => error.includes('transform_id must be a lowercase slug')));
	assert(
		errors.some((error) => error.includes('redistribution must be local-only for public-license')),
	);
});

test('rejects identity fields and changed fixture contents', () => {
	const { directory, document } = fixture();
	document.samples[0].provenance.participants = [{ email: 'person@example.com' }];
	fs.writeFileSync(
		path.join(
			directory,
			'local-corpus',
			'session-example-001',
			'meeting-en-clean.wav',
		),
		'changed',
	);
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
	assert(errors.some((error) => error.includes('valid, non-future YYYY-MM-DD date')));
	assert(errors.some((error) => error.includes('cannot be local-only in a repository manifest')));
});

test('rejects future consent dates when a local manifest is revalidated', () => {
	const { directory, document } = fixture();
	document.samples[0].provenance.consent_date = '2026-07-17';
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
		today: '2026-07-16',
	});
	assert(errors.some((error) => error.includes('valid, non-future YYYY-MM-DD date')));
});

test('requires local participant files to remain in their opaque session directory', () => {
	const { directory, document } = fixture();
	const externalAudio = path.join(directory, 'external.wav');
	fs.writeFileSync(externalAudio, 'audio');
	document.samples[0].audio_path = 'external.wav';
	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(
		errors.some((error) =>
			error.includes(
				'audio_path must be local-corpus/session-example-001/meeting-en-clean.wav',
			),
		),
	);
});

test('requires non-meeting participant recordings to use managed session custody too', () => {
	const { directory, document } = fixture();
	const sample = document.samples[0];
	sample.scenario = 'dictation';
	sample.speakers = 1;
	delete sample.session_id;
	sample.audio_path = 'outside.wav';
	sample.reference_path = 'outside.txt';
	fs.writeFileSync(path.join(directory, 'outside.wav'), 'audio');
	fs.writeFileSync(path.join(directory, 'outside.txt'), 'hello');

	const errors = validateCorpusDocument(document, {
		manifestPath: path.join(directory, 'manifest.json'),
	});
	assert(
		errors.some((error) =>
			error.includes('session_id is required for local participant recordings'),
		),
	);
});

test('rejects symlinked and hard-linked participant files in managed sessions', () => {
	for (const aliasType of ['symbolic', 'hard']) {
		const { directory, document } = fixture();
		const sessionDirectory = path.join(
			directory,
			'local-corpus',
			'session-example-001',
		);
		const audioPath = path.join(sessionDirectory, 'meeting-en-clean.wav');
		const externalAudio = path.join(directory, `${aliasType}-source.wav`);
		fs.writeFileSync(externalAudio, 'audio');
		fs.rmSync(audioPath);
		if (aliasType === 'symbolic') fs.symlinkSync(externalAudio, audioPath);
		else fs.linkSync(externalAudio, audioPath);

		const errors = validateCorpusDocument(document, {
			manifestPath: path.join(directory, 'manifest.json'),
		});
		assert(
			errors.some((error) =>
				error.includes(aliasType === 'symbolic' ? 'symbolic link' : 'hard-linked'),
			),
			aliasType,
		);
	}
});

test('rejects symlinked local corpus and session directories', () => {
	for (const aliasLevel of ['corpus', 'session']) {
		const { directory, document } = fixture();
		const localCorpusRoot = path.join(directory, 'local-corpus');
		const sessionDirectory = path.join(localCorpusRoot, 'session-example-001');
		if (aliasLevel === 'corpus') {
			const externalCorpusRoot = path.join(directory, 'external-corpus');
			fs.renameSync(localCorpusRoot, externalCorpusRoot);
			fs.symlinkSync(externalCorpusRoot, localCorpusRoot, 'dir');
		} else {
			const externalSession = path.join(directory, 'external-session');
			fs.renameSync(sessionDirectory, externalSession);
			fs.symlinkSync(externalSession, sessionDirectory, 'dir');
		}

		const errors = validateCorpusDocument(document, {
			manifestPath: path.join(directory, 'manifest.json'),
		});
		assert(
			errors.some((error) =>
				error.includes(
					aliasLevel === 'corpus'
						? 'local corpus directory must be a regular directory'
						: 'session directory must be a regular directory',
				),
			),
			aliasLevel,
		);
	}
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
	const otherProtocol = { ...document, reference_protocol_id: 'another-reference-v1' };
	assert.notEqual(corpusFingerprint(document), corpusFingerprint(otherProtocol));
});
