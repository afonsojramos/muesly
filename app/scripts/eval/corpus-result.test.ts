import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireCorpusBenchmarkLock, releaseCorpusBenchmarkLock } from './corpus-benchmark-lock.ts';
import {
	assertLeasedCorpusSampleUnchanged,
	createCorpusResultLease,
	writeCorpusBoundFiles,
	writeCorpusBoundJson,
	writeLeasedCorpusBoundJson,
} from './corpus-result.ts';
import { corpusFingerprint, loadCorpus } from './corpus.ts';

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

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

function leasedCorpusFixture(t, options = {}) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-result-lease-')));
	const manifestPath = path.join(directory, 'corpus-local.json');
	const sessionId = 'session-lease-example';
	const sampleId = 'meeting-en-clean';
	const sessionDirectory = path.join(directory, 'local-corpus', sessionId);
	const audioPath = path.join(sessionDirectory, `${sampleId}.wav`);
	const referencePath = path.join(sessionDirectory, `${sampleId}.txt`);
	const audio = Buffer.from('leased audio fixture');
	const reference = Buffer.from('hello from the leased reference');
	fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(audioPath, audio, { mode: 0o600 });
	fs.writeFileSync(referencePath, reference, { mode: 0o600 });
	const document = {
		schema_version: 2,
		corpus_id: 'local-consented-meetings',
		description: 'Local consented corpus.',
		distribution: 'local',
		samples: [
			{
				id: sampleId,
				session_id: sessionId,
				audio_path: `local-corpus/${sessionId}/${sampleId}.wav`,
				audio_sha256: sha256(audio),
				reference_path: `local-corpus/${sessionId}/${sampleId}.txt`,
				reference_sha256: sha256(reference),
				language: 'en-US',
				whisper_language: 'en',
				scenario: 'meeting',
				noise_condition: 'clean',
				speakers: 2,
				duration_seconds: 12.5,
				provenance: {
					basis: 'participant-consent',
					redistribution: 'local-only',
					consent_record_id: 'consent-lease-example',
					consent_date: '2025-01-01',
					consented_uses: ['asr-benchmarking'],
				},
			},
		],
	};
	fs.writeFileSync(manifestPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
	const locks = [];
	const acquireLock = () => {
		const lock = acquireCorpusBenchmarkLock(manifestPath, {
			currentIdentity: 'benchmark-process',
		});
		locks.push(lock);
		return lock;
	};
	const lock = acquireLock();
	const corpus = loadCorpus(manifestPath);
	options.beforeLease?.({
		audioPath,
		corpus,
		directory,
		lock,
		manifestPath,
		referencePath,
		sampleId,
	});
	const lease = createCorpusResultLease({
		corpus,
		benchmarkLockToken: lock.token,
		benchmarkProcessIdentity: lock.processIdentity,
	});
	t.after(() => {
		for (const held of locks.toReversed()) {
			releaseCorpusBenchmarkLock(held.lockPath, held.token, {
				currentIdentity: held.processIdentity,
			});
		}
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return {
		acquireLock,
		audio,
		audioPath,
		corpus,
		directory,
		document,
		lease,
		lock,
		manifestPath,
		reference,
		referencePath,
		sampleId,
	};
}

function interruptedTransaction(directory, state) {
	const resultsDirectory = path.join(directory, 'results');
	fs.mkdirSync(resultsDirectory, { recursive: true });
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

function quarantinedEntries(resultsDirectory) {
	if (!fs.existsSync(resultsDirectory)) return [];
	return fs
		.readdirSync(resultsDirectory)
		.filter((name) => name.startsWith('.lease-quarantine-'))
		.map((name) => path.join(resultsDirectory, name, 'entry'))
		.filter((entryPath) => fs.existsSync(entryPath));
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

test('reuses a validated lease without fully reloading every sample per checkpoint', (t) => {
	const current = leasedCorpusFixture(t);
	const openedSamplePaths = [];
	const originalOpenSync = fs.openSync;
	t.mock.method(fs, 'openSync', (filePath, ...args) => {
		if (
			typeof filePath === 'string' &&
			[filePath, path.resolve(filePath)].some((candidate) =>
				[current.audioPath, current.referencePath].includes(candidate),
			)
		) {
			openedSamplePaths.push(filePath);
		}
		return originalOpenSync(filePath, ...args);
	});

	const resultsDirectory = path.join(current.directory, 'results');
	for (let index = 0; index < 3; index += 1) {
		writeLeasedCorpusBoundJson({
			lease: current.lease,
			outputPath: path.join(resultsDirectory, `checkpoint-${index}.json`),
			value: { checkpoint: index },
		});
	}
	assert.deepEqual(openedSamplePaths, []);
	assert.deepEqual(
		JSON.parse(fs.readFileSync(path.join(resultsDirectory, 'checkpoint-2.json'), 'utf8')),
		{ checkpoint: 2 },
	);
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(resultsDirectory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(resultsDirectory, 'checkpoint-2.json')).mode & 0o777, 0o600);
	}
});

test('rejects wrong and stale benchmark tokens when creating a lease', (t) => {
	const current = leasedCorpusFixture(t);
	assert.throws(
		() =>
			createCorpusResultLease({
				corpus: current.corpus,
				benchmarkLockToken: '00000000-0000-4000-8000-000000000099',
				benchmarkProcessIdentity: current.lock.processIdentity,
			}),
		/does not own the corpus benchmark lock/,
	);

	assert.equal(
		releaseCorpusBenchmarkLock(current.lock.lockPath, current.lock.token, {
			currentIdentity: current.lock.processIdentity,
		}),
		true,
	);
	const replacement = current.acquireLock();
	assert.throws(
		() =>
			createCorpusResultLease({
				corpus: current.corpus,
				benchmarkLockToken: current.lock.token,
				benchmarkProcessIdentity: current.lock.processIdentity,
			}),
		/does not own the corpus benchmark lock/,
	);
	assert.equal(
		releaseCorpusBenchmarkLock(replacement.lockPath, replacement.token, {
			currentIdentity: replacement.processIdentity,
		}),
		true,
	);
});

test('rejects a lease whose benchmark owner process identity was replaced', (t) => {
	const current = leasedCorpusFixture(t);
	const ownerPath = path.join(current.lock.lockPath, 'owner.json');
	const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
	fs.writeFileSync(
		ownerPath,
		`${JSON.stringify({ ...owner, process_identity: 'forged-process-identity' })}\n`,
		{ mode: 0o600 },
	);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/does not own the corpus benchmark lock/,
	);
	assert(!fs.existsSync(outputPath));
});

test('binds a lease to the exact raw manifest bytes', (t) => {
	const current = leasedCorpusFixture(t);
	fs.writeFileSync(current.manifestPath, `${JSON.stringify(current.document, null, 2)}\n`, {
		mode: 0o600,
	});
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/leased corpus manifest changed/,
	);
	assert(!fs.existsSync(outputPath));
});

test('rejects manifest path replacement even when bytes are identical', (t) => {
	const current = leasedCorpusFixture(t);
	const contents = fs.readFileSync(current.manifestPath);
	const displacedPath = `${current.manifestPath}.displaced`;
	fs.renameSync(current.manifestPath, displacedPath);
	fs.writeFileSync(current.manifestPath, contents, { mode: 0o600 });
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/leased corpus manifest changed/,
	);
	assert(!fs.existsSync(outputPath));
});

test('blocks leased writes when a withdrawal becomes pending', (t) => {
	const current = leasedCorpusFixture(t);
	fs.writeFileSync(
		path.join(current.directory, 'local-corpus', '.withdrawal-session-lease-example.json'),
		'{}\n',
		{ mode: 0o600 },
	);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/corpus withdrawal is pending/,
	);
	assert(!fs.existsSync(outputPath));
});

test('confines leased outputs and rejects symbolic-link escapes', async (t) => {
	if (process.platform === 'win32') {
		return t.skip('symbolic-link setup is not portable on Windows');
	}
	await t.test('output symlink', (t) => {
		const current = leasedCorpusFixture(t);
		const resultsDirectory = path.join(current.directory, 'results');
		const outsidePath = path.join(current.directory, 'outside.json');
		const outputPath = path.join(resultsDirectory, 'checkpoint.json');
		fs.writeFileSync(outsidePath, '{"preserved":true}\n');
		fs.symlinkSync(outsidePath, outputPath);
		assert.throws(
			() =>
				writeLeasedCorpusBoundJson({
					lease: current.lease,
					outputPath,
					value: { changed: true },
				}),
			/result output cannot be a symbolic link/,
		);
		assert.equal(fs.readFileSync(outsidePath, 'utf8'), '{"preserved":true}\n');
	});

	await t.test('results directory symlink', (t) => {
		const current = leasedCorpusFixture(t);
		const outsideDirectory = path.join(current.directory, 'outside-results');
		const resultsDirectory = path.join(current.directory, 'results');
		fs.mkdirSync(outsideDirectory);
		fs.rmdirSync(resultsDirectory);
		fs.symlinkSync(outsideDirectory, resultsDirectory);
		assert.throws(
			() =>
				writeLeasedCorpusBoundJson({
					lease: current.lease,
					outputPath: path.join(resultsDirectory, 'checkpoint.json'),
					value: { changed: true },
				}),
			/managed results directory/,
		);
		assert.deepEqual(fs.readdirSync(outsideDirectory), []);
	});
});

test('makes a lease unusable after lock release or replacement', (t) => {
	const current = leasedCorpusFixture(t);
	const copiedOwner = fs.readFileSync(path.join(current.lock.lockPath, 'owner.json'));
	assert.equal(
		releaseCorpusBenchmarkLock(current.lock.lockPath, current.lock.token, {
			currentIdentity: current.lock.processIdentity,
		}),
		true,
	);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/owned corpus benchmark lock is no longer available/,
	);

	fs.mkdirSync(current.lock.lockPath, { mode: 0o700 });
	fs.writeFileSync(path.join(current.lock.lockPath, 'owner.json'), copiedOwner, { mode: 0o600 });
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/benchmark lock changed/,
	);
	assert(!fs.existsSync(outputPath));
});

test('does not accept a forged copy of a validated lease', (t) => {
	const current = leasedCorpusFixture(t);
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: { ...current.lease },
				outputPath: path.join(current.directory, 'results', 'checkpoint.json'),
				value: { complete: false },
			}),
		/validated corpus result lease is required/,
	);
});

test('requires the loaded corpus projection to exactly match planning and inference metadata', (t) => {
	const current = leasedCorpusFixture(t);
	for (const mutate of [
		(corpus) => {
			delete corpus.samples[0].noise_condition;
		},
		(corpus) => {
			corpus.samples[0].duration_seconds = 99;
		},
		(corpus) => {
			corpus.samples[0].reference_file = current.audioPath;
		},
		(corpus) => {
			corpus.description = 'hand-shaped corpus';
		},
		(corpus) => {
			corpus.samples[0].unexpected_planning_field = 'forged';
		},
	]) {
		const corpus = structuredClone(current.corpus);
		mutate(corpus);
		assert.throws(
			() =>
				createCorpusResultLease({
					corpus,
					benchmarkLockToken: current.lock.token,
					benchmarkProcessIdentity: current.lock.processIdentity,
				}),
			/loaded corpus projection does not match/,
		);
	}
});

test('captures reference text only from digest-bound strict UTF-8 bytes', (t) => {
	assert.throws(
		() =>
			leasedCorpusFixture(t, {
				beforeLease: ({ corpus, manifestPath, referencePath }) => {
					const invalidReference = Buffer.from([0xc3, 0x28]);
					fs.writeFileSync(referencePath, invalidReference, { mode: 0o600 });
					const document = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
					document.samples[0].reference_sha256 = sha256(invalidReference);
					fs.writeFileSync(manifestPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
					corpus.samples[0].reference_sha256 = document.samples[0].reference_sha256;
					corpus.corpus_fingerprint = corpusFingerprint(document);
				},
			}),
		/reference_path must be valid UTF-8/,
	);
});

test('revalidates selected sample audio and reference contents around inference', async (t) => {
	await t.test('audio drift', (t) => {
		const current = leasedCorpusFixture(t);
		const selected = assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId);
		assert.equal(selected.audio_file, current.audioPath);
		assert.equal(selected.reference_file, current.referencePath);
		assert.equal(selected.reference_text, current.reference.toString('utf8'));
		assert.equal(selected.noise_condition, 'clean');
		assert(Object.isFrozen(selected));
		assert(Object.isFrozen(selected.provenance));
		assert.throws(() => {
			selected.reference_text = 'mutated';
		}, /read only|Cannot assign/);
		const changed = Buffer.from(current.audio);
		changed[0] ^= 0xff;
		fs.writeFileSync(current.audioPath, changed, { mode: 0o600 });
		assert.throws(
			() => assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId),
			/sample 'meeting-en-clean' audio changed/,
		);
	});

	await t.test('reference drift', (t) => {
		const current = leasedCorpusFixture(t);
		const selected = assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId);
		const changed = Buffer.from(current.reference);
		changed[0] ^= 0xff;
		fs.writeFileSync(current.referencePath, changed, { mode: 0o600 });
		assert.equal(selected.reference_text, current.reference.toString('utf8'));
		assert.throws(
			() => assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId),
			/sample 'meeting-en-clean' reference changed/,
		);
	});

	await t.test('hard-link replacement', (t) => {
		const current = leasedCorpusFixture(t);
		const displaced = `${current.referencePath}.displaced`;
		fs.renameSync(current.referencePath, displaced);
		fs.linkSync(displaced, current.referencePath);
		assert.throws(
			() => assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId),
			/must not be hard linked/,
		);
	});
});

test('binds participant custody to exact private session directory identities', async (t) => {
	if (process.platform !== 'win32') {
		await t.test('mode drift', (t) => {
			const current = leasedCorpusFixture(t);
			const sessionDirectory = path.dirname(current.audioPath);
			fs.chmodSync(sessionDirectory, 0o755);
			assert.throws(
				() => assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId),
				/session directory changed|private 0700 permissions/,
			);
		});
	}

	await t.test('directory replacement', (t) => {
		const current = leasedCorpusFixture(t);
		const sessionDirectory = path.dirname(current.audioPath);
		const displaced = `${sessionDirectory}.displaced`;
		fs.renameSync(sessionDirectory, displaced);
		fs.mkdirSync(sessionDirectory, { mode: 0o700 });
		fs.copyFileSync(path.join(displaced, path.basename(current.audioPath)), current.audioPath);
		fs.copyFileSync(
			path.join(displaced, path.basename(current.referencePath)),
			current.referencePath,
		);
		if (process.platform !== 'win32') {
			fs.chmodSync(current.audioPath, 0o600);
			fs.chmodSync(current.referencePath, 0o600);
		}
		assert.throws(
			() => assertLeasedCorpusSampleUnchanged(current.lease, current.sampleId),
			/session directory changed/,
		);
	});
});

test('rejects results-directory replacement during staged output creation', (t) => {
	const current = leasedCorpusFixture(t);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	const resultsDirectory = path.dirname(outputPath);
	const displaced = `${resultsDirectory}.displaced`;
	const originalOpenSync = fs.openSync;
	let replaced = false;
	t.mock.method(fs, 'openSync', (filePath, ...args) => {
		const descriptor = originalOpenSync(filePath, ...args);
		if (!replaced && typeof filePath === 'string' && filePath.startsWith(`${outputPath}.tmp-`)) {
			replaced = true;
			fs.renameSync(resultsDirectory, displaced);
			fs.mkdirSync(resultsDirectory, { mode: 0o700 });
		}
		return descriptor;
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/results directory changed/,
	);
	assert(!fs.existsSync(outputPath));
});

test('rejects results-directory permission drift before checkpoint staging', (t) => {
	if (process.platform === 'win32') {
		return t.skip('POSIX permission modes are not enforceable on Windows');
	}
	const current = leasedCorpusFixture(t);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	fs.chmodSync(path.dirname(outputPath), 0o755);
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: false },
			}),
		/results directory changed|private 0700 permissions/,
	);
	assert(!fs.existsSync(outputPath));
});

test('publishes a checkpoint as an exact retained hard-link pair', (t) => {
	const current = leasedCorpusFixture(t);
	const resultsDirectory = path.join(current.directory, 'results');
	const outputPath = path.join(resultsDirectory, 'checkpoint.json');
	writeLeasedCorpusBoundJson({
		lease: current.lease,
		outputPath,
		value: { complete: true },
	});
	const managedPairs = fs
		.readdirSync(resultsDirectory)
		.filter((name) => name.startsWith(`${path.basename(outputPath)}.tmp-`));
	assert.equal(managedPairs.length, 1);
	const output = fs.statSync(outputPath);
	const pair = fs.statSync(path.join(resultsDirectory, managedPairs[0]));
	assert.equal(output.ino, pair.ino);
	assert.equal(output.nlink, 2);
	assert.equal(pair.nlink, 2);
	assert.equal(
		fs.readFileSync(outputPath, 'utf8'),
		fs.readFileSync(path.join(resultsDirectory, managedPairs[0]), 'utf8'),
	);
});

test('never clobbers a destination that appears at publication time', (t) => {
	const current = leasedCorpusFixture(t);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	const originalLinkSync = fs.linkSync;
	let injected = false;
	t.mock.method(fs, 'linkSync', (sourcePath, destinationPath) => {
		if (!injected && destinationPath === outputPath) {
			injected = true;
			fs.writeFileSync(outputPath, 'attacker destination\n', { mode: 0o600 });
		}
		return originalLinkSync(sourcePath, destinationPath);
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: true },
			}),
		/EEXIST|file already exists/,
	);
	assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attacker destination\n');
});

test('preserves the exact published pair when final lease validation fails', (t) => {
	const current = leasedCorpusFixture(t);
	const resultsDirectory = path.join(current.directory, 'results');
	const outputPath = path.join(resultsDirectory, 'checkpoint.json');
	const expectedContents = `${JSON.stringify({ complete: true }, null, 2)}\n`;
	const originalLinkSync = fs.linkSync;
	let changed = false;
	t.mock.method(fs, 'linkSync', (sourcePath, destinationPath) => {
		const result = originalLinkSync(sourcePath, destinationPath);
		if (!changed && destinationPath === outputPath) {
			changed = true;
			fs.appendFileSync(current.manifestPath, ' ');
		}
		return result;
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: true },
			}),
		/leased corpus manifest changed/,
	);
	assert.equal(fs.readFileSync(outputPath, 'utf8'), expectedContents);
	const retainedPair = fs
		.readdirSync(resultsDirectory)
		.find((name) => name.startsWith(`${path.basename(outputPath)}.tmp-`));
	assert(retainedPair);
	assert.equal(
		fs.readFileSync(path.join(resultsDirectory, retainedPair), 'utf8'),
		expectedContents,
	);
	const quarantined = quarantinedEntries(resultsDirectory);
	assert.equal(quarantined.length, 2);
	assert(quarantined.every((entryPath) => fs.readFileSync(entryPath, 'utf8') === expectedContents));
});

test('preserves an attacker replacement swapped while failed output is linked into quarantine', (t) => {
	const current = leasedCorpusFixture(t);
	const resultsDirectory = path.join(current.directory, 'results');
	const outputPath = path.join(resultsDirectory, 'checkpoint.json');
	const displacedOutput = path.join(current.directory, 'writer-output-displaced.json');
	const originalLinkSync = fs.linkSync;
	let tampered = false;
	let swapped = false;
	t.mock.method(fs, 'linkSync', (sourcePath, destinationPath) => {
		if (
			!swapped &&
			sourcePath === outputPath &&
			typeof destinationPath === 'string' &&
			destinationPath.includes('.lease-quarantine-')
		) {
			swapped = true;
			fs.renameSync(outputPath, displacedOutput);
			fs.writeFileSync(outputPath, 'attacker replacement\n', { mode: 0o600 });
		}
		const result = originalLinkSync(sourcePath, destinationPath);
		if (!tampered && destinationPath === outputPath) {
			tampered = true;
			fs.appendFileSync(outputPath, 'tamper');
		}
		return result;
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: true },
			}),
		/validation and quarantine|promotion and cleanup|staged cleanup both failed/,
	);
	assert(swapped);
	assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attacker replacement\n');
	assert(fs.existsSync(displacedOutput));
	assert(
		quarantinedEntries(resultsDirectory).some(
			(entryPath) => fs.readFileSync(entryPath, 'utf8') === 'attacker replacement\n',
		),
	);
});

test('preserves a replacement swapped after failed-output quarantine inspection', (t) => {
	const current = leasedCorpusFixture(t);
	const resultsDirectory = path.join(current.directory, 'results');
	const outputPath = path.join(resultsDirectory, 'checkpoint.json');
	const displacedOutput = path.join(current.directory, 'writer-output-displaced.json');
	const expectedContents = `${JSON.stringify({ complete: true }, null, 2)}\n`;
	const originalLinkSync = fs.linkSync;
	const originalRealpathSync = fs.realpathSync;
	let changed = false;
	let swapped = false;
	t.mock.method(fs, 'linkSync', (sourcePath, destinationPath) => {
		const result = originalLinkSync(sourcePath, destinationPath);
		if (!changed && destinationPath === outputPath) {
			changed = true;
			fs.appendFileSync(current.manifestPath, ' ');
		}
		return result;
	});
	t.mock.method(fs, 'realpathSync', (filePath, ...args) => {
		const result = originalRealpathSync(filePath, ...args);
		if (
			!swapped &&
			typeof filePath === 'string' &&
			filePath.includes('.lease-quarantine-') &&
			path.basename(filePath) === 'entry'
		) {
			swapped = true;
			fs.renameSync(outputPath, displacedOutput);
			fs.writeFileSync(outputPath, 'attacker replacement\n', { mode: 0o600 });
		}
		return result;
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: true },
			}),
		/leased corpus manifest changed/,
	);
	assert(swapped);
	assert.equal(fs.readFileSync(outputPath, 'utf8'), 'attacker replacement\n');
	assert.equal(fs.readFileSync(displacedOutput, 'utf8'), expectedContents);
	const quarantined = quarantinedEntries(resultsDirectory);
	assert.equal(quarantined.length, 2);
	assert(quarantined.every((entryPath) => fs.readFileSync(entryPath, 'utf8') === expectedContents));
});

test('never overwrites evidence planted at a quarantine destination', (t) => {
	const current = leasedCorpusFixture(t);
	const resultsDirectory = path.join(current.directory, 'results');
	const outputPath = path.join(resultsDirectory, 'checkpoint.json');
	const originalLinkSync = fs.linkSync;
	let changed = false;
	let plantedPath = null;
	t.mock.method(fs, 'linkSync', (sourcePath, destinationPath) => {
		if (!changed && destinationPath === outputPath) {
			const result = originalLinkSync(sourcePath, destinationPath);
			changed = true;
			fs.appendFileSync(current.manifestPath, ' ');
			return result;
		}
		if (
			plantedPath === null &&
			typeof destinationPath === 'string' &&
			destinationPath.includes('.lease-quarantine-')
		) {
			plantedPath = destinationPath;
			fs.writeFileSync(plantedPath, 'planted quarantine evidence\n', { mode: 0o600 });
		}
		return originalLinkSync(sourcePath, destinationPath);
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: true },
			}),
		/validation and quarantine|staged cleanup both failed/,
	);
	assert(plantedPath);
	assert.equal(fs.readFileSync(plantedPath, 'utf8'), 'planted quarantine evidence\n');
	assert(fs.existsSync(outputPath));
});

test('closes a staged descriptor and preserves its path when initial fstat fails', (t) => {
	const current = leasedCorpusFixture(t);
	const outputPath = path.join(current.directory, 'results', 'checkpoint.json');
	const originalOpenSync = fs.openSync;
	const originalFstatSync = fs.fstatSync;
	let stagedDescriptor = null;
	let stagedPath = null;
	t.mock.method(fs, 'openSync', (filePath, ...args) => {
		const descriptor = originalOpenSync(filePath, ...args);
		if (typeof filePath === 'string' && filePath.startsWith(`${outputPath}.tmp-`)) {
			stagedDescriptor = descriptor;
			stagedPath = filePath;
		}
		return descriptor;
	});
	t.mock.method(fs, 'fstatSync', (descriptor, ...args) => {
		if (descriptor === stagedDescriptor) throw new Error('injected staged fstat failure');
		return originalFstatSync(descriptor, ...args);
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { complete: true },
			}),
		/injected staged fstat failure/,
	);
	assert(stagedPath);
	assert(fs.existsSync(stagedPath));
	assert.throws(() => originalFstatSync(stagedDescriptor), /EBADF|bad file descriptor/i);
	assert(!fs.existsSync(outputPath));
});

test('rejects staged symlink and hardlink swaps at no-clobber publication', async (t) => {
	if (process.platform === 'win32') {
		return t.skip('symbolic-link and hard-link setup is not portable on Windows');
	}
	for (const kind of ['symlink', 'hardlink']) {
		await t.test(kind, (t) => {
			const current = leasedCorpusFixture(t);
			const outputPath = path.join(current.directory, 'results', `checkpoint-${kind}.json`);
			const outsidePath = path.join(current.directory, `outside-${kind}.json`);
			const expectedContents = `${JSON.stringify({ complete: false }, null, 2)}\n`;
			fs.writeFileSync(outsidePath, expectedContents, { mode: 0o600 });
			const originalLinkSync = fs.linkSync;
			let swapped = false;
			t.mock.method(fs, 'linkSync', (sourcePath, destinationPath) => {
				if (
					!swapped &&
					typeof sourcePath === 'string' &&
					sourcePath.startsWith(`${outputPath}.tmp-`) &&
					destinationPath === outputPath
				) {
					swapped = true;
					fs.rmSync(sourcePath);
					if (kind === 'symlink') {
						fs.symlinkSync(outsidePath, sourcePath);
					} else {
						originalLinkSync(outsidePath, sourcePath);
					}
				}
				return originalLinkSync(sourcePath, destinationPath);
			});
			assert.throws(
				() =>
					writeLeasedCorpusBoundJson({
						lease: current.lease,
						outputPath,
						value: { complete: false },
					}),
				/regular file|hard-link count|changed during promotion|validation and quarantine|staged cleanup both failed/,
			);
			assert(swapped);
			assert.equal(fs.readFileSync(outputPath, 'utf8'), expectedContents);
			assert.equal(fs.readFileSync(outsidePath, 'utf8'), expectedContents);
		});
	}
});

test('refuses to bind a lease while a legacy result transaction needs recovery', (t) => {
	let transaction;
	assert.throws(
		() =>
			leasedCorpusFixture(t, {
				beforeLease: ({ directory }) => {
					transaction = interruptedTransaction(directory, 'prepared');
				},
			}),
		/requires recovery outside the corpus result lease/,
	);
	for (const output of transaction.outputs) {
		assert.equal(
			fs.readFileSync(path.join(transaction.resultsDirectory, output.file), 'utf8'),
			`new ${output.file}\n`,
		);
		assert(fs.existsSync(path.join(transaction.resultsDirectory, output.backup_file)));
		assert(fs.existsSync(path.join(transaction.resultsDirectory, output.staged_file)));
	}
	assert(fs.existsSync(transaction.markerPath));
});

test('fails closed when a result transaction appears after lease creation', (t) => {
	const current = leasedCorpusFixture(t);
	const transaction = interruptedTransaction(current.directory, 'prepared');
	const outputPath = path.join(transaction.resultsDirectory, 'checkpoint.json');
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { recovered: false },
			}),
		/requires recovery outside the corpus result lease/,
	);
	for (const output of transaction.outputs) {
		assert.equal(
			fs.readFileSync(path.join(transaction.resultsDirectory, output.file), 'utf8'),
			`new ${output.file}\n`,
		);
	}
	assert(fs.existsSync(transaction.markerPath));
	assert(!fs.existsSync(outputPath));
});

test('detects a result transaction marker created during directory scanning', (t) => {
	const current = leasedCorpusFixture(t);
	const resultsDirectory = path.join(current.directory, 'results');
	const outputPath = path.join(resultsDirectory, 'checkpoint.json');
	const originalReaddirSync = fs.readdirSync;
	let transaction = null;
	t.mock.method(fs, 'readdirSync', (directoryPath, ...args) => {
		const entries = originalReaddirSync(directoryPath, ...args);
		if (transaction === null && directoryPath === resultsDirectory) {
			transaction = interruptedTransaction(current.directory, 'prepared');
		}
		return entries;
	});
	assert.throws(
		() =>
			writeLeasedCorpusBoundJson({
				lease: current.lease,
				outputPath,
				value: { recovered: false },
			}),
		/results directory during transaction preflight changed after validation/,
	);
	assert(transaction);
	assert(fs.existsSync(transaction.markerPath));
	assert(!fs.existsSync(outputPath));
});

test('does not recover transactions from a swapped attacker results directory', (t) => {
	let attackerTransaction;
	let attackerResults;
	const originalReaddirSync = fs.readdirSync;
	assert.throws(
		() =>
			leasedCorpusFixture(t, {
				beforeLease: ({ directory }) => {
					const attackerParent = path.join(directory, 'attacker');
					attackerTransaction = interruptedTransaction(attackerParent, 'prepared');
					attackerResults = attackerTransaction.resultsDirectory;
					const resultsDirectory = path.join(directory, 'results');
					const trustedDisplaced = `${resultsDirectory}.trusted`;
					let swapped = false;
					t.mock.method(fs, 'readdirSync', (directoryPath, ...args) => {
						if (!swapped && directoryPath === resultsDirectory) {
							swapped = true;
							fs.renameSync(resultsDirectory, trustedDisplaced);
							fs.renameSync(attackerResults, resultsDirectory);
						}
						return originalReaddirSync(directoryPath, ...args);
					});
				},
			}),
		/results directory during transaction preflight changed after validation/,
	);
	const installedAttackerResults = path.join(path.dirname(attackerResults), '..', 'results');
	for (const output of attackerTransaction.outputs) {
		assert.equal(
			fs.readFileSync(path.join(installedAttackerResults, output.file), 'utf8'),
			`new ${output.file}\n`,
		);
	}
	assert(
		fs.existsSync(
			path.join(installedAttackerResults, path.basename(attackerTransaction.markerPath)),
		),
	);
});
