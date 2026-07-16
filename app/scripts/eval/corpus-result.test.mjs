import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeCorpusBoundJson } from './corpus-result.mjs';
import { corpusFingerprint } from './corpus.mjs';

function localManifest() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-result-'));
	const manifestPath = path.join(directory, 'corpus-local.json');
	fs.mkdirSync(path.join(directory, 'local-corpus'));
	const document = {
		schema_version: 2,
		corpus_id: 'local-consented-meetings',
		description: 'Local consented corpus.',
		distribution: 'local',
		samples: [],
	};
	fs.writeFileSync(manifestPath, JSON.stringify(document));
	return { directory, document, manifestPath };
}

test('atomically writes results bound to the current local corpus revision', () => {
	const { directory, document, manifestPath } = localManifest();
	const outputPath = path.join(directory, 'results', 'run.json');
	const value = { corpus_fingerprint: corpusFingerprint(document) };
	writeCorpusBoundJson({
		manifestPath,
		expectedFingerprint: value.corpus_fingerprint,
		outputPath,
		value,
	});
	assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), value);
	assert(!fs.existsSync(path.join(directory, 'local-corpus', '.intake.lock')));
});

test('refuses to overwrite output after the corpus revision changes', () => {
	const { directory, document, manifestPath } = localManifest();
	const outputPath = path.join(directory, 'results', 'run.json');
	fs.mkdirSync(path.dirname(outputPath));
	fs.writeFileSync(outputPath, 'keep existing output\n');
	const expectedFingerprint = corpusFingerprint(document);
	fs.writeFileSync(
		manifestPath,
		JSON.stringify({ ...document, description: 'Changed local consented corpus.' }),
	);
	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint,
				outputPath,
				value: { corpus_fingerprint: expectedFingerprint },
			}),
		/corpus changed/,
	);
	assert.equal(fs.readFileSync(outputPath, 'utf8'), 'keep existing output\n');
});

test('does not write while a corpus mutation holds the shared lock', () => {
	const { directory, document, manifestPath } = localManifest();
	const outputPath = path.join(directory, 'results', 'run.json');
	const lockPath = path.join(directory, 'local-corpus', '.intake.lock');
	fs.writeFileSync(
		lockPath,
		JSON.stringify({ schema_version: 1, pid: process.pid, created_at: new Date().toISOString() }),
	);
	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpusFingerprint(document),
				outputPath,
				value: { corpus_fingerprint: corpusFingerprint(document) },
			}),
		/another corpus intake is active/,
	);
	assert(!fs.existsSync(outputPath));
});
