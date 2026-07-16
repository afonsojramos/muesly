import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireCorpusBenchmarkLock, releaseCorpusBenchmarkLock } from './corpus-benchmark-lock.ts';
import { writeCorpusBoundFiles, writeCorpusBoundJson } from './corpus-result.ts';
import { corpusFingerprint } from './corpus.ts';

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

function interruptedTransaction(directory, state) {
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	const pid = 999_999_999;
	const token = '00000000-0000-4000-8000-000000000010';
	const outputs = ['aggregate.json', 'aggregate.md'].map((file, index) => ({
		file,
		staged_file: `${file}.tmp-${pid}-00000000-0000-4000-8000-00000000001${index}`,
		backup_file: `${file}.bak-${pid}-${token}`,
		had_original: true,
	}));
	for (const output of outputs) {
		fs.writeFileSync(path.join(resultsDirectory, output.backup_file), `old ${output.file}\n`);
		fs.writeFileSync(path.join(resultsDirectory, output.file), `new ${output.file}\n`);
		fs.writeFileSync(path.join(resultsDirectory, output.staged_file), `staged ${output.file}\n`);
	}
	const markerPath = path.join(resultsDirectory, `.result-transaction-${pid}-${token}.json`);
	fs.writeFileSync(markerPath, JSON.stringify({ schema_version: 1, pid, token, state, outputs }));
	return { markerPath, outputs, resultsDirectory };
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

test('keeps the managed results directory and report files private', () => {
	const { directory, document, manifestPath } = localManifest();
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory, { mode: 0o755 });
	const outputPath = path.join(resultsDirectory, 'run.json');

	writeCorpusBoundJson({
		manifestPath,
		expectedFingerprint: corpusFingerprint(document),
		outputPath,
		value: { complete: false },
	});

	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(resultsDirectory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
	}
});

test('allows only the owning benchmark campaign to write while its lock is active', () => {
	const { directory, document, manifestPath } = localManifest();
	const outputPath = path.join(directory, 'results', 'run.json');
	const lock = acquireCorpusBenchmarkLock(manifestPath);
	try {
		assert.throws(
			() =>
				writeCorpusBoundJson({
					manifestPath,
					expectedFingerprint: corpusFingerprint(document),
					outputPath,
					value: { complete: false },
				}),
			/a corpus benchmark is active/,
		);
		writeCorpusBoundJson({
			manifestPath,
			expectedFingerprint: corpusFingerprint(document),
			benchmarkLockToken: lock.token,
			outputPath,
			value: { complete: true },
		});
		assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), { complete: true });
	} finally {
		assert.equal(releaseCorpusBenchmarkLock(lock.lockPath, lock.token), true);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('initializes managed storage for an empty local manifest', () => {
	const { directory, document, manifestPath } = localManifest();
	fs.rmdirSync(path.join(directory, 'local-corpus'));
	const outputPath = path.join(directory, 'results', 'coverage.json');

	writeCorpusBoundJson({
		manifestPath,
		expectedFingerprint: corpusFingerprint(document),
		outputPath,
		value: { complete: false },
	});

	assert(fs.statSync(path.join(directory, 'local-corpus')).isDirectory());
	assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), { complete: false });
});

test('binds results to the canonical manifest behind a symlink', () => {
	const { directory, document, manifestPath } = localManifest();
	const manifestAlias = path.join(directory, 'corpus-alias.json');
	const outputPath = path.join(directory, 'results', 'run.json');
	fs.symlinkSync(manifestPath, manifestAlias);

	writeCorpusBoundJson({
		manifestPath: manifestAlias,
		expectedFingerprint: corpusFingerprint(document),
		outputPath,
		value: { complete: true },
	});

	assert(fs.lstatSync(manifestAlias).isSymbolicLink());
	assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), { complete: true });
});

test('rejects result-file symlinks without modifying their targets', () => {
	const { directory, document, manifestPath } = localManifest();
	const resultsDirectory = path.join(directory, 'results');
	const targetPath = path.join(resultsDirectory, 'existing.json');
	const outputPath = path.join(resultsDirectory, 'run.json');
	fs.mkdirSync(resultsDirectory);
	fs.writeFileSync(targetPath, '{"preserved":true}\n');
	fs.symlinkSync(targetPath, outputPath);

	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpusFingerprint(document),
				outputPath,
				value: { changed: true },
			}),
		/result output cannot be a symbolic link/,
	);
	assert.equal(fs.readFileSync(targetPath, 'utf8'), '{"preserved":true}\n');
	assert(fs.lstatSync(outputPath).isSymbolicLink());
});

test('writes multiple corpus-bound outputs while holding one revision lock', () => {
	const { directory, document, manifestPath } = localManifest();
	const fingerprint = corpusFingerprint(document);
	const jsonPath = path.join(directory, 'results', 'aggregate.json');
	const markdownPath = path.join(directory, 'results', 'aggregate.md');
	writeCorpusBoundFiles({
		manifestPath,
		expectedFingerprint: fingerprint,
		outputs: [
			{ outputPath: jsonPath, contents: '{"complete":true}\n' },
			{ outputPath: markdownPath, contents: '# Complete\n' },
		],
	});
	assert.equal(fs.readFileSync(jsonPath, 'utf8'), '{"complete":true}\n');
	assert.equal(fs.readFileSync(markdownPath, 'utf8'), '# Complete\n');
	assert(!fs.existsSync(path.join(directory, 'local-corpus', '.intake.lock')));
});

test('rolls back an interrupted result-set promotion before the next write', () => {
	const { directory, document, manifestPath } = localManifest();
	const transaction = interruptedTransaction(directory, 'prepared');
	fs.writeFileSync(
		manifestPath,
		JSON.stringify({ ...document, description: 'Changed local consented corpus.' }),
	);
	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpusFingerprint(document),
				outputPath: path.join(directory, 'results', 'next.json'),
				value: { stale: true },
			}),
		/corpus changed/,
	);
	for (const output of transaction.outputs) {
		assert.equal(
			fs.readFileSync(path.join(transaction.resultsDirectory, output.file), 'utf8'),
			`old ${output.file}\n`,
		);
		assert(!fs.existsSync(path.join(transaction.resultsDirectory, output.backup_file)));
		assert(!fs.existsSync(path.join(transaction.resultsDirectory, output.staged_file)));
	}
	assert(!fs.existsSync(transaction.markerPath));
});

test('finishes cleaning an interrupted committed result set before the next write', () => {
	const { directory, document, manifestPath } = localManifest();
	const transaction = interruptedTransaction(directory, 'committed');
	fs.writeFileSync(
		manifestPath,
		JSON.stringify({ ...document, description: 'Changed local consented corpus.' }),
	);
	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpusFingerprint(document),
				outputPath: path.join(directory, 'results', 'next.json'),
				value: { stale: true },
			}),
		/corpus changed/,
	);
	for (const output of transaction.outputs) {
		assert.equal(
			fs.readFileSync(path.join(transaction.resultsDirectory, output.file), 'utf8'),
			`new ${output.file}\n`,
		);
		assert(!fs.existsSync(path.join(transaction.resultsDirectory, output.backup_file)));
		assert(!fs.existsSync(path.join(transaction.resultsDirectory, output.staged_file)));
	}
	assert(!fs.existsSync(transaction.markerPath));
});

test('confines local corpus outputs to direct files in the managed results directory', () => {
	const { directory, document, manifestPath } = localManifest();
	for (const outputPath of [
		path.join(directory, 'outside.json'),
		path.join(directory, 'results', 'nested', 'run.json'),
	]) {
		assert.throws(
			() =>
				writeCorpusBoundJson({
					manifestPath,
					expectedFingerprint: corpusFingerprint(document),
					outputPath,
					value: { corpus_fingerprint: corpusFingerprint(document) },
				}),
			/managed results directory/,
		);
		assert(!fs.existsSync(outputPath));
	}
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

test('does not reclaim an interrupted withdrawal to write against its old manifest', () => {
	const { directory, document, manifestPath } = localManifest();
	const localCorpusRoot = path.join(directory, 'local-corpus');
	const outputPath = path.join(directory, 'results', 'run.json');
	const quarantine = '.withdrawal-results-session-withdraw-00000000-0000-4000-8000-000000000000';
	fs.mkdirSync(path.join(localCorpusRoot, quarantine));
	fs.writeFileSync(
		path.join(localCorpusRoot, '.withdrawal-session-withdraw.json'),
		JSON.stringify({
			schema_version: 2,
			session_id: 'session-withdraw',
			removed_samples: 1,
			results_quarantine: quarantine,
			started_at: '2026-07-16T00:00:00Z',
		}),
	);
	const lockPath = path.join(localCorpusRoot, '.intake.lock');
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
	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpusFingerprint(document),
				outputPath,
				value: { corpus_fingerprint: corpusFingerprint(document) },
			}),
		/withdrawal is pending/,
	);
	assert(!fs.existsSync(outputPath));
});

test('preserves valid reports when reclaiming a dead result-writer lock', () => {
	const { directory, document, manifestPath } = localManifest();
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory);
	const existingReport = path.join(resultsDirectory, 'existing.json');
	fs.writeFileSync(existingReport, '{"valid":true}\n');
	const abandonedReport = path.join(
		resultsDirectory,
		'existing.json.tmp-999999999-00000000-0000-4000-8000-000000000002',
	);
	fs.writeFileSync(abandonedReport, '{"partial":true}\n');
	const activeReport = path.join(
		resultsDirectory,
		`active.json.tmp-${process.pid}-00000000-0000-4000-8000-000000000003`,
	);
	fs.writeFileSync(activeReport, '{"active":true}\n');
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

	writeCorpusBoundJson({
		manifestPath,
		expectedFingerprint: corpusFingerprint(document),
		outputPath: path.join(resultsDirectory, 'new.json'),
		value: { corpus_fingerprint: corpusFingerprint(document) },
	});

	assert.equal(fs.readFileSync(existingReport, 'utf8'), '{"valid":true}\n');
	assert(!fs.existsSync(abandonedReport));
	assert.equal(fs.readFileSync(activeReport, 'utf8'), '{"active":true}\n');
	assert(fs.existsSync(path.join(resultsDirectory, 'new.json')));
});

test('blocks result writes on non-regular withdrawal markers', () => {
	const { directory, document, manifestPath } = localManifest();
	fs.mkdirSync(path.join(directory, 'local-corpus', '.withdrawal-session-fake.json'));
	const outputPath = path.join(directory, 'results', 'run.json');
	assert.throws(
		() =>
			writeCorpusBoundJson({
				manifestPath,
				expectedFingerprint: corpusFingerprint(document),
				outputPath,
				value: { corpus_fingerprint: corpusFingerprint(document) },
			}),
		/withdrawal is pending/,
	);
	assert(!fs.existsSync(outputPath));
});
