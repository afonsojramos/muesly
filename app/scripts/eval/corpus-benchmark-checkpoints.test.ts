import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	cleanupCorpusBenchmarkAttempt,
	discoverCorpusBenchmarkCheckpoints,
	isCorpusBenchmarkAttemptName,
	isCorpusBenchmarkCheckpointName,
	MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES,
	readCorpusBenchmarkCheckpoint,
} from './corpus-benchmark-checkpoints.ts';

const TASK_DIGEST = '1'.repeat(16);
const ACTUAL_DIGEST = '2'.repeat(16);

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-checkpoints-'));
	t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
	return {
		directory,
		resultsDirectory: path.join(directory, 'results'),
	};
}

function checkpointName({
	provider = 'whisper',
	backend = 'metal',
	taskDigest = TASK_DIGEST,
	actualDigest = ACTUAL_DIGEST,
} = {}) {
	return `run-${provider}-${backend}-${taskDigest}-${actualDigest}.run.json`;
}

function writeCheckpoint(
	resultsDirectory,
	name = checkpointName(),
	report = { schema_version: 8 },
) {
	fs.mkdirSync(resultsDirectory, { recursive: true, mode: 0o700 });
	const contents = `${JSON.stringify(report)}\n`;
	const checkpointPath = path.join(resultsDirectory, name);
	fs.writeFileSync(checkpointPath, contents, { mode: 0o600 });
	return { checkpointPath, contents };
}

function writeManagedPairCheckpoint(
	resultsDirectory,
	name = checkpointName(),
	report = { schema_version: 8 },
) {
	const checkpoint = writeCheckpoint(resultsDirectory, name, report);
	const pairPath = `${checkpoint.checkpointPath}.tmp-${process.pid}-${randomUUID()}`;
	fs.linkSync(checkpoint.checkpointPath, pairPath);
	return { ...checkpoint, pairPath };
}

function attemptName(pid = process.pid, uuid = randomUUID()) {
	return `.benchmark-attempt-${pid}-${uuid}.json`;
}

test('returns no checkpoints when the managed results directory is absent', (t) => {
	const current = fixture(t);
	assert.deepEqual(discoverCorpusBenchmarkCheckpoints(current.resultsDirectory), []);
});

test('requires an existing results path to be a non-symlink directory', async (t) => {
	await t.test('regular file', (t) => {
		const current = fixture(t);
		fs.writeFileSync(current.resultsDirectory, 'not a directory\n');
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/non-symlink directory/,
		);
	});

	await t.test('symbolic link', (t) => {
		if (process.platform === 'win32') {
			return t.skip('symbolic-link setup is not portable on Windows');
		}
		const current = fixture(t);
		const target = path.join(current.directory, 'target');
		fs.mkdirSync(target);
		fs.symlinkSync(target, current.resultsDirectory);
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/non-symlink directory/,
		);
	});
});

test('discovers valid checkpoints in deterministic order with raw-content digests', (t) => {
	const current = fixture(t);
	const second = writeCheckpoint(
		current.resultsDirectory,
		checkpointName({
			provider: 'whisper',
			backend: 'openblas-cpu',
			taskDigest: 'b'.repeat(16),
			actualDigest: 'c'.repeat(16),
		}),
		{ report: 2 },
	);
	const first = writeCheckpoint(
		current.resultsDirectory,
		checkpointName({
			provider: 'parakeet',
			backend: 'onnx-cpu',
			taskDigest: 'a'.repeat(16),
			actualDigest: 'd'.repeat(16),
		}),
		{ report: 1 },
	);
	fs.writeFileSync(path.join(current.resultsDirectory, 'coverage.json'), '{}\n');
	fs.writeFileSync(path.join(current.resultsDirectory, attemptName()), '{"partial":true}\n');

	const records = discoverCorpusBenchmarkCheckpoints(current.resultsDirectory);

	assert.deepEqual(
		records.map(({ name }) => name),
		[path.basename(first.checkpointPath), path.basename(second.checkpointPath)],
	);
	assert.deepEqual(
		records.map(({ report }) => report),
		[{ report: 1 }, { report: 2 }],
	);
	assert.deepEqual(
		records.map(({ path: checkpointPath }) => checkpointPath),
		[first.checkpointPath, second.checkpointPath],
	);
	assert.deepEqual(
		records.map(({ sha256 }) => sha256),
		[
			createHash('sha256').update(first.contents).digest('hex'),
			createHash('sha256').update(second.contents).digest('hex'),
		],
	);
});

test('accepts an exact retained managed checkpoint hard-link pair', (t) => {
	const current = fixture(t);
	const checkpoint = writeManagedPairCheckpoint(current.resultsDirectory, checkpointName(), {
		report: 'managed-pair',
	});
	const records = discoverCorpusBenchmarkCheckpoints(current.resultsDirectory);
	assert.equal(records.length, 1);
	assert.deepEqual(records[0].report, { report: 'managed-pair' });
	assert.equal(records[0].sha256, createHash('sha256').update(checkpoint.contents).digest('hex'));
	assert.equal(fs.statSync(checkpoint.checkpointPath).nlink, 2);
	assert.equal(fs.statSync(checkpoint.pairPath).ino, fs.statSync(checkpoint.checkpointPath).ino);
});

test('rejects managed checkpoint pairs with extra aliases or pair replacement', async (t) => {
	await t.test('extra alias', (t) => {
		const current = fixture(t);
		const checkpoint = writeManagedPairCheckpoint(current.resultsDirectory);
		fs.linkSync(checkpoint.checkpointPath, path.join(current.directory, 'extra-alias.json'));
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/regular single-link file or a valid managed-pair file/,
		);
	});

	await t.test('pair replacement during read', (t) => {
		const current = fixture(t);
		const checkpoint = writeManagedPairCheckpoint(current.resultsDirectory);
		assert.throws(
			() =>
				readCorpusBenchmarkCheckpoint(checkpoint.checkpointPath, {
					onAfterRead: () => {
						fs.renameSync(checkpoint.pairPath, `${checkpoint.pairPath}.displaced`);
						fs.writeFileSync(checkpoint.pairPath, checkpoint.contents, { mode: 0o600 });
					},
				}),
			/checkpoint changed while it was being read/,
		);
	});
});

test('accepts only final hash-suffixed campaign checkpoint names', () => {
	for (const name of [
		checkpointName(),
		checkpointName({ backend: 'coreml-metal' }),
		checkpointName({ provider: 'parakeet', backend: 'onnx-cpu' }),
		checkpointName({ backend: 'openblas-cpu' }),
	]) {
		assert.equal(isCorpusBenchmarkCheckpointName(name), true);
	}
	for (const name of [
		`run-whisper-metal-${TASK_DIGEST}.run.json`,
		`run-whisper-metal-${TASK_DIGEST}-${'a'.repeat(16).toUpperCase()}.run.json`,
		`run-whisper-metal-sample-${TASK_DIGEST}-${ACTUAL_DIGEST}.run.json`,
		`run-whisper--metal-${TASK_DIGEST}-${ACTUAL_DIGEST}.run.json`,
		`run-provider-v2-gpu-backend-v3-${TASK_DIGEST}-${ACTUAL_DIGEST}.run.json`,
		`run-whisper-metal-${TASK_DIGEST}-${ACTUAL_DIGEST}.json`,
		'aggregate.run.json',
	]) {
		assert.equal(isCorpusBenchmarkCheckpointName(name), false, name);
	}
});

test('fails closed when any run-report filename is not campaign-owned', (t) => {
	const current = fixture(t);
	writeCheckpoint(current.resultsDirectory);
	fs.writeFileSync(path.join(current.resultsDirectory, 'manual.run.json'), '{}\n');

	assert.throws(
		() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
		/invalid corpus benchmark checkpoint filename: manual\.run\.json/,
	);
});

test('rejects checkpoint aliases, hardlinks, and non-regular entries', async (t) => {
	await t.test('symbolic link', (t) => {
		if (process.platform === 'win32') {
			return t.skip('symbolic-link setup is not portable on Windows');
		}
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const target = path.join(current.directory, 'target.json');
		fs.writeFileSync(target, '{}\n');
		fs.symlinkSync(target, path.join(current.resultsDirectory, checkpointName()));
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/regular single-link file/,
		);
		assert.equal(fs.readFileSync(target, 'utf8'), '{}\n');
	});

	await t.test('hardlink', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const target = path.join(current.directory, 'target.json');
		fs.writeFileSync(target, '{}\n');
		fs.linkSync(target, path.join(current.resultsDirectory, checkpointName()));
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/regular single-link file/,
		);
	});

	await t.test('directory', (t) => {
		const current = fixture(t);
		fs.mkdirSync(path.join(current.resultsDirectory, checkpointName()), { recursive: true });
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/regular single-link file/,
		);
	});

	await t.test('FIFO', (t) => {
		if (process.platform === 'win32') return t.skip('FIFOs are not available on Windows');
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const fifoPath = path.join(current.resultsDirectory, checkpointName());
		try {
			execFileSync('mkfifo', [fifoPath]);
		} catch {
			return t.skip('mkfifo is unavailable');
		}
		assert.throws(
			() => discoverCorpusBenchmarkCheckpoints(current.resultsDirectory),
			/regular single-link file/,
		);
	});
});

test('bounds checkpoint reads before parsing', (t) => {
	const current = fixture(t);
	fs.mkdirSync(current.resultsDirectory);
	const checkpointPath = path.join(current.resultsDirectory, checkpointName());
	fs.writeFileSync(checkpointPath, Buffer.alloc(MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES + 1, 0x20));

	assert.throws(() => readCorpusBenchmarkCheckpoint(checkpointPath), /checkpoint is too large/);
});

test('rejects invalid UTF-8, malformed JSON, and non-object reports', async (t) => {
	await t.test('invalid UTF-8', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const checkpointPath = path.join(current.resultsDirectory, checkpointName());
		fs.writeFileSync(checkpointPath, Buffer.from([0xc3, 0x28]));
		assert.throws(() => readCorpusBenchmarkCheckpoint(checkpointPath), /not valid UTF-8/);
	});

	await t.test('malformed JSON', (t) => {
		const current = fixture(t);
		const { checkpointPath } = writeCheckpoint(current.resultsDirectory);
		fs.writeFileSync(checkpointPath, '{"incomplete":\n');
		assert.throws(() => readCorpusBenchmarkCheckpoint(checkpointPath), /not valid JSON/);
	});

	for (const [label, value] of [
		['array', []],
		['null', null],
		['number', 1],
	]) {
		await t.test(label, (t) => {
			const current = fixture(t);
			const { checkpointPath } = writeCheckpoint(current.resultsDirectory, checkpointName(), value);
			assert.throws(
				() => readCorpusBenchmarkCheckpoint(checkpointPath),
				/must contain a JSON object/,
			);
		});
	}
});

test('detects a checkpoint changed during its bounded read', (t) => {
	const current = fixture(t);
	const { checkpointPath } = writeCheckpoint(current.resultsDirectory);

	assert.throws(
		() =>
			readCorpusBenchmarkCheckpoint(checkpointPath, {
				onAfterRead: () => fs.appendFileSync(checkpointPath, ' '),
			}),
		/changed while it was being read/,
	);
});

test('detects results directory contents changed during discovery', (t) => {
	const current = fixture(t);
	writeCheckpoint(current.resultsDirectory);

	assert.throws(
		() =>
			discoverCorpusBenchmarkCheckpoints(current.resultsDirectory, {
				onAfterRead: () =>
					fs.writeFileSync(path.join(current.resultsDirectory, 'coverage.json'), '{}\n'),
			}),
		/results directory changed during access/,
	);
});

test('recognizes only exact reserved attempt names with safe PIDs and UUIDs', () => {
	const uuid = randomUUID();
	assert.equal(isCorpusBenchmarkAttemptName(attemptName(42, uuid)), true);
	for (const name of [
		`.benchmark-attempt-0-${uuid}.json`,
		`.benchmark-attempt-999999999999999999999-${uuid}.json`,
		`.benchmark-attempt-42-${uuid.toUpperCase()}.json`,
		`benchmark-attempt-42-${uuid}.json`,
		`.benchmark-attempt-42-${uuid}.run.json`,
	]) {
		assert.equal(isCorpusBenchmarkAttemptName(name), false, name);
	}
});

test('removes only an exact regular single-link reserved attempt', (t) => {
	const current = fixture(t);
	fs.mkdirSync(current.resultsDirectory);
	const attemptPath = path.join(current.resultsDirectory, attemptName());
	assert.equal(cleanupCorpusBenchmarkAttempt(attemptPath), false);
	fs.writeFileSync(attemptPath, '{"partial":true}\n');
	assert.equal(cleanupCorpusBenchmarkAttempt(attemptPath), true);
	assert.equal(fs.existsSync(attemptPath), false);

	const unrelated = path.join(current.resultsDirectory, 'report.json');
	fs.writeFileSync(unrelated, '{"preserved":true}\n');
	assert.throws(
		() => cleanupCorpusBenchmarkAttempt(unrelated),
		/refusing to clean non-reserved benchmark attempt path/,
	);
	assert.equal(fs.readFileSync(unrelated, 'utf8'), '{"preserved":true}\n');
});

test('attempt cleanup never follows file or parent aliases', async (t) => {
	if (process.platform === 'win32') {
		return t.skip('symbolic-link setup is not portable on Windows');
	}
	await t.test('file alias', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const target = path.join(current.directory, 'target.json');
		const attemptPath = path.join(current.resultsDirectory, attemptName());
		fs.writeFileSync(target, '{"preserved":true}\n');
		fs.symlinkSync(target, attemptPath);
		assert.throws(() => cleanupCorpusBenchmarkAttempt(attemptPath), /regular single-link file/);
		assert.equal(fs.readFileSync(target, 'utf8'), '{"preserved":true}\n');
	});

	await t.test('parent alias', (t) => {
		const current = fixture(t);
		const targetDirectory = path.join(current.directory, 'target');
		fs.mkdirSync(targetDirectory);
		const attemptPath = path.join(current.resultsDirectory, attemptName());
		const target = path.join(targetDirectory, path.basename(attemptPath));
		fs.writeFileSync(target, '{"preserved":true}\n');
		fs.symlinkSync(targetDirectory, current.resultsDirectory);
		assert.throws(() => cleanupCorpusBenchmarkAttempt(attemptPath), /non-symlink directory/);
		assert.equal(fs.readFileSync(target, 'utf8'), '{"preserved":true}\n');
	});

	await t.test('parent replaced after attempt open', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const movedDirectory = path.join(current.directory, 'moved-results');
		const attemptPath = path.join(current.resultsDirectory, attemptName());
		fs.writeFileSync(attemptPath, '{"attempt":true}\n');
		assert.throws(
			() =>
				cleanupCorpusBenchmarkAttempt(attemptPath, {
					onBeforeUnlink: () => {
						fs.renameSync(current.resultsDirectory, movedDirectory);
						fs.symlinkSync(movedDirectory, current.resultsDirectory);
					},
				}),
			/results directory changed during access/,
		);
		assert.equal(
			fs.readFileSync(path.join(movedDirectory, path.basename(attemptPath)), 'utf8'),
			'{"attempt":true}\n',
		);
	});

	await t.test('replacement alias', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const target = path.join(current.directory, 'target.json');
		const attemptPath = path.join(current.resultsDirectory, attemptName());
		fs.writeFileSync(target, '{"preserved":true}\n');
		fs.writeFileSync(attemptPath, '{"attempt":true}\n');
		assert.throws(
			() =>
				cleanupCorpusBenchmarkAttempt(attemptPath, {
					onBeforeUnlink: () => {
						fs.unlinkSync(attemptPath);
						fs.symlinkSync(target, attemptPath);
					},
				}),
			/results directory changed during access|changed before cleanup/,
		);
		assert.equal(fs.readFileSync(target, 'utf8'), '{"preserved":true}\n');
	});
});

test('attempt cleanup rejects hardlinks and non-regular reserved entries', async (t) => {
	await t.test('hardlink', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.resultsDirectory);
		const target = path.join(current.directory, 'target.json');
		const attemptPath = path.join(current.resultsDirectory, attemptName());
		fs.writeFileSync(target, '{"preserved":true}\n');
		fs.linkSync(target, attemptPath);
		assert.throws(() => cleanupCorpusBenchmarkAttempt(attemptPath), /regular single-link file/);
		assert.equal(fs.readFileSync(target, 'utf8'), '{"preserved":true}\n');
	});

	await t.test('directory', (t) => {
		const current = fixture(t);
		const attemptPath = path.join(current.resultsDirectory, attemptName());
		fs.mkdirSync(attemptPath, { recursive: true });
		assert.throws(() => cleanupCorpusBenchmarkAttempt(attemptPath), /regular single-link file/);
	});
});
