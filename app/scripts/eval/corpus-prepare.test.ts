import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	parsePrepareArgs,
	planCollectionCells,
	prepareCollectionSession,
} from './corpus-prepare.ts';

const targets = {
	schema_version: 1,
	target_id: 'test-targets',
	languages: ['en', 'es'],
	noise_conditions: ['clean', 'office'],
	benchmark_variants: [{ provider: 'whisper', model: 'test', backend: 'cpu' }],
	min_sessions_per_language_noise_cell: 2,
};

function sample(language, noiseCondition, sessionId) {
	return {
		id: `${language}-${noiseCondition}-${sessionId}`,
		session_id: sessionId,
		language,
		noise_condition: noiseCondition,
		scenario: 'meeting',
		provenance: { basis: 'participant-consent' },
	};
}

function hash(value) {
	return createHash('sha256').update(value).digest('hex');
}

function fixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-prepare-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const targetsPath = path.join(directory, 'corpus-targets.json');
	const templatePath = path.join(directory, 'consent-record.example.md');
	const consentRecordsDir = fs.mkdtempSync(
		path.join(os.tmpdir(), 'muesly-corpus-consent-records-'),
	);
	fs.writeFileSync(targetsPath, JSON.stringify(targets));
	fs.writeFileSync(
		templatePath,
		[
			'- Consent record ID: `consent-...` (the only value copied into the corpus manifest)',
			'- Meeting/session ID: `session-...` (opaque; no title, customer, or participant names)',
			'- Languages:',
			'- Benchmark condition: `clean` / `office` / `remote-call` / `overlapping-speech`',
			'- [ ] Every audible participant made a clear affirmative choice to participate.',
		].join('\n'),
	);
	return { directory, manifestPath, targetsPath, templatePath, consentRecordsDir };
}

function prepareOptions(current, overrides = {}) {
	return {
		manifestPath: current.manifestPath,
		targetsPath: current.targetsPath,
		templatePath: current.templatePath,
		consentRecordsDir: current.consentRecordsDir,
		repositoryRoot: current.directory,
		repositoryIntakeRoot: current.directory,
		...overrides,
	};
}

test('balances preparation toward the least-covered target cell', () => {
	const corpus = {
		samples: [
			sample('en', 'clean', 'session-en-clean-1'),
			sample('en', 'clean', 'session-en-clean-2'),
			sample('en', 'office', 'session-en-office-1'),
		],
	};
	const cells = planCollectionCells(corpus, targets);
	assert.deepEqual(
		cells.map(
			(cell) => `${cell.language}/${cell.noiseCondition}:${cell.collected}+${cell.prepared}`,
		),
		['es/clean:0+0', 'es/office:0+0', 'en/office:1+0'],
	);
});

test('balances repeated preparation across pending session bundles', () => {
	const corpus = { samples: [] };
	const cells = planCollectionCells(corpus, targets, [
		{
			sessionId: 'session-pending',
			language: 'en',
			noiseCondition: 'clean',
		},
	]);
	assert.equal(`${cells[0].language}/${cells[0].noiseCondition}`, 'en/office');
	assert.equal(cells.at(-1).prepared, 1);
});

test('creates a private, consent-neutral collection bundle for the next cell', () => {
	const current = fixture();
	const { directory, manifestPath } = current;
	const id = '00000000-0000-4000-8000-000000000001';
	const session = prepareCollectionSession(
		prepareOptions(current, {
			idFactory: () => id,
		}),
	);

	assert.equal(session.sessionId, `session-${id}`);
	assert.equal(session.consentRecordId, `consent-${id}`);
	assert.equal(session.sampleId, `en-clean-${id}`);
	assert.equal(session.remainingUnpreparedObservations, 7);
	assert(!fs.existsSync(session.audioPath));
	assert.equal(fs.readFileSync(session.referencePath, 'utf8'), '');
	const consent = fs.readFileSync(session.consentRecordPath, 'utf8');
	assert.match(consent, new RegExp(session.consentRecordId));
	assert.match(consent, new RegExp(session.sessionId));
	assert.match(consent, /Languages: en/);
	assert.match(consent, /Benchmark condition: `clean`/);
	assert.match(consent, /\[ \] Every audible participant/);
	const readme = fs.readFileSync(
		path.join(directory, 'intake', session.sessionId, 'README.md'),
		'utf8',
	);
	assert.match(readme, /Preparing this bundle does not establish consent/);
	assert.match(readme, /--affirm-all-participants-consented/);
	assert.equal(fs.statSync(path.join(directory, 'intake')).mode & 0o777, 0o700);
	assert.equal(fs.statSync(session.consentRecordPath).mode & 0o777, 0o600);
	assert(!fs.existsSync(manifestPath));
});

test('allows selecting a specific still-underfilled collection cell', () => {
	const current = fixture();
	const session = prepareCollectionSession(
		prepareOptions(current, {
			language: 'es',
			noiseCondition: 'office',
			idFactory: () => '00000000-0000-4000-8000-000000000002',
		}),
	);
	assert.equal(session.language, 'es');
	assert.equal(session.noiseCondition, 'office');
});

test('prepares the next cell after accounting for an existing private bundle', () => {
	const current = fixture();
	prepareCollectionSession(
		prepareOptions(current, {
			idFactory: () => '00000000-0000-4000-8000-000000000003',
		}),
	);
	const second = prepareCollectionSession(
		prepareOptions(current, {
			idFactory: () => '00000000-0000-4000-8000-000000000004',
		}),
	);
	assert.equal(`${second.language}/${second.noiseCondition}`, 'en/office');
});

test('rejects incomplete selectors and already-complete cells', () => {
	const current = fixture();
	const { manifestPath } = current;
	assert.throws(
		() =>
			prepareCollectionSession(
				prepareOptions(current, {
					language: 'en',
				}),
			),
		/must be provided together/,
	);
	const audioContents = ['audio one', 'audio two'];
	const referenceContents = ['reference one', 'reference two'];
	for (let index = 0; index < 2; index += 1) {
		fs.writeFileSync(
			path.join(path.dirname(manifestPath), `audio-${index}.wav`),
			audioContents[index],
		);
		fs.writeFileSync(
			path.join(path.dirname(manifestPath), `reference-${index}.txt`),
			referenceContents[index],
		);
	}
	fs.writeFileSync(
		manifestPath,
		JSON.stringify({
			schema_version: 2,
			corpus_id: 'consented-meetings-v1',
			description: 'Local corpus.',
			distribution: 'local',
			samples: [
				sample('en', 'clean', 'session-en-clean-1'),
				sample('en', 'clean', 'session-en-clean-2'),
			].map((entry, index) => ({
				...entry,
				audio_path: `audio-${index}.wav`,
				audio_sha256: hash(audioContents[index]),
				reference_path: `reference-${index}.txt`,
				reference_sha256: hash(referenceContents[index]),
				speakers: 2,
				duration_seconds: 10,
				provenance: {
					basis: 'participant-consent',
					redistribution: 'local-only',
					consent_record_id: `consent-${index + 1}`,
					consent_date: '2026-07-16',
					consented_uses: ['asr-benchmarking'],
				},
			})),
		}),
	);
	assert.throws(
		() =>
			prepareCollectionSession(
				prepareOptions(current, {
					language: 'en',
					noiseCondition: 'clean',
				}),
			),
		/already complete or not targeted/,
	);
});

test('refuses collection roots that are symbolic links', () => {
	const current = fixture();
	const { directory } = current;
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-corpus-outside-'));
	fs.symlinkSync(outside, path.join(directory, 'intake'));
	assert.throws(
		() => prepareCollectionSession(prepareOptions(current)),
		/intake directory must be a regular directory/,
	);
});

test('never deletes a pre-existing consent record on an ID collision', () => {
	const current = fixture();
	const id = '00000000-0000-4000-8000-000000000005';
	const consentPath = path.join(current.consentRecordsDir, `consent-${id}.md`);
	fs.writeFileSync(consentPath, 'existing affirmative evidence');

	assert.throws(
		() =>
			prepareCollectionSession(
				prepareOptions(current, {
					idFactory: () => id,
				}),
			),
		/consent record already exists/,
	);
	assert.equal(fs.readFileSync(consentPath, 'utf8'), 'existing affirmative evidence');
});

test('requires an explicit external consent records directory', () => {
	const current = fixture();
	assert.throws(
		() =>
			prepareCollectionSession({
				manifestPath: current.manifestPath,
				targetsPath: current.targetsPath,
				templatePath: current.templatePath,
				repositoryRoot: current.directory,
			}),
		/consent-records-dir/,
	);
	assert.throws(
		() =>
			prepareCollectionSession({
				...prepareOptions(current),
				consentRecordsDir: path.join(current.directory, 'consent-records'),
			}),
		/must be outside the Git repository/,
	);
});

test('refuses repository-local manifests other than the ignored corpus-local filename', () => {
	const current = fixture();
	const evalDirectory = path.join(current.directory, 'app', 'scripts', 'eval');
	const unignoredManifests = [
		path.join(current.directory, 'app', 'corpus-local.json'),
		path.join(evalDirectory, 'team-corpus.json'),
	];
	for (const unignoredManifest of unignoredManifests) {
		assert.throws(
			() =>
				prepareCollectionSession(
					prepareOptions(current, {
						manifestPath: unignoredManifest,
						repositoryIntakeRoot: evalDirectory,
					}),
				),
			/repository-local collection requires the ignored manifest/,
		);
		assert(!fs.existsSync(path.join(path.dirname(unignoredManifest), 'intake')));
	}
	assert.deepEqual(fs.readdirSync(current.consentRecordsDir), []);
});

test('rejects repository-distributed manifests before creating collection files', () => {
	const current = fixture();
	const audio = path.join(current.directory, 'public.wav');
	const reference = path.join(current.directory, 'public.txt');
	fs.writeFileSync(audio, 'public audio');
	fs.writeFileSync(reference, 'public reference');
	fs.writeFileSync(
		current.manifestPath,
		JSON.stringify({
			schema_version: 2,
			corpus_id: 'repository-corpus',
			description: 'Repository fixture.',
			distribution: 'repository',
			samples: [
				{
					id: 'public-speech',
					audio_path: 'public.wav',
					audio_sha256: hash('public audio'),
					reference_path: 'public.txt',
					reference_sha256: hash('public reference'),
					language: 'en',
					scenario: 'speech',
					noise_condition: 'clean',
					speakers: 1,
					duration_seconds: 10,
					provenance: {
						basis: 'public-domain',
						redistribution: 'repository',
						source_url: 'https://example.test/audio',
						license: 'CC0',
					},
				},
			],
		}),
	);
	assert.throws(
		() => prepareCollectionSession(prepareOptions(current)),
		/requires a local corpus manifest/,
	);
	assert(!fs.existsSync(path.join(current.directory, 'intake')));
	assert.deepEqual(fs.readdirSync(current.consentRecordsDir), []);
});

test('rejects custom target values that the intake command cannot accept', () => {
	const current = fixture();
	fs.writeFileSync(
		current.targetsPath,
		JSON.stringify({
			...targets,
			languages: ['it'],
			noise_conditions: ['stadium'],
		}),
	);
	assert.throws(
		() => prepareCollectionSession(prepareOptions(current)),
		/unsupported intake language 'it'/,
	);
	assert(!fs.existsSync(path.join(current.directory, 'intake')));
	assert.deepEqual(fs.readdirSync(current.consentRecordsDir), []);
});

test('parses targeted preparation options without accepting unknown flags', () => {
	assert.deepEqual(
		parsePrepareArgs(['--language', 'pt', '--noise-condition', 'remote-call'], {
			manifestPath: 'manifest.json',
			targetsPath: 'targets.json',
			consentRecordsDir: '/secure/records',
		}),
		{
			manifestPath: 'manifest.json',
			targetsPath: 'targets.json',
			consentRecordsDir: '/secure/records',
			language: 'pt',
			noiseCondition: 'remote-call',
		},
	);
	assert.throws(
		() => parsePrepareArgs(['--unexpected'], { manifestPath: 'a', targetsPath: 'b' }),
		/unknown option/,
	);
});
