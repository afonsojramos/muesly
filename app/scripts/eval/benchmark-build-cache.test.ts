import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCohortBenchmarkBuild } from './benchmark-build-cache.ts';

const REVISION = 'a'.repeat(64);
const OTHER_REVISION = 'b'.repeat(64);

function sha256File(filePath) {
	return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-build-cache-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return { directory };
}

function fakeDependencies(calls) {
	return {
		buildBenchmarkExecutable: (_repoRoot, options = {}) => {
			calls.builds += 1;
			const executablePath = path.join(calls.repoRoot, `built-${calls.builds}.bin`);
			fs.writeFileSync(executablePath, `binary-${calls.builds}-${options.backend ?? 'cpu'}`);
			return { cargoFeatures: ['metal'], executablePath };
		},
		benchmarkExecutableSha256: sha256File,
		cargoFeaturesForBenchmark: () => ['metal'],
	};
}

test('builds once per evaluator revision and reuses the attested bytes', (t) => {
	const { directory } = fixture(t);
	const calls = { builds: 0, repoRoot: directory };
	const build = createCohortBenchmarkBuild({
		repoRoot: directory,
		revisionSha256: REVISION,
		...fakeDependencies(calls),
	});
	const first = build(directory, { provider: 'whisper', backend: 'cpu' });
	const second = build(directory, { provider: 'whisper', backend: 'cpu' });
	assert.equal(calls.builds, 1);
	assert.equal(first.executablePath, second.executablePath);
	assert.deepEqual(second.cargoFeatures, ['metal']);
	assert.equal(
		fs.readFileSync(`${second.executablePath}.sha256`, 'utf8').trim(),
		sha256File(second.executablePath),
	);
});

test('a different evaluator revision selects a fresh cache entry', (t) => {
	const { directory } = fixture(t);
	const calls = { builds: 0, repoRoot: directory };
	const dependencies = fakeDependencies(calls);
	const first = createCohortBenchmarkBuild({
		repoRoot: directory,
		revisionSha256: REVISION,
		...dependencies,
	})(directory, { provider: 'whisper', backend: 'cpu' });
	const second = createCohortBenchmarkBuild({
		repoRoot: directory,
		revisionSha256: OTHER_REVISION,
		...dependencies,
	})(directory, { provider: 'whisper', backend: 'cpu' });
	assert.equal(calls.builds, 2);
	assert.notEqual(first.executablePath, second.executablePath);
});

test('rebuilds when the cached bytes do not match the recorded digest', (t) => {
	const { directory } = fixture(t);
	const calls = { builds: 0, repoRoot: directory };
	const build = createCohortBenchmarkBuild({
		repoRoot: directory,
		revisionSha256: REVISION,
		...fakeDependencies(calls),
	});
	const first = build(directory, { provider: 'whisper', backend: 'cpu' });
	assert.equal(calls.builds, 1);
	fs.writeFileSync(first.executablePath, 'tampered bytes');
	const second = build(directory, { provider: 'whisper', backend: 'cpu' });
	assert.equal(calls.builds, 2);
	assert.equal(fs.readFileSync(second.executablePath, 'utf8'), 'binary-2-cpu');
});

test('rebuilds when the recorded digest is missing or malformed', (t) => {
	const { directory } = fixture(t);
	const calls = { builds: 0, repoRoot: directory };
	const build = createCohortBenchmarkBuild({
		repoRoot: directory,
		revisionSha256: REVISION,
		...fakeDependencies(calls),
	});
	const first = build(directory, { provider: 'whisper', backend: 'cpu' });
	fs.writeFileSync(`${first.executablePath}.sha256`, 'not-a-digest\n');
	build(directory, { provider: 'whisper', backend: 'cpu' });
	assert.equal(calls.builds, 2);
});

test('rejects invalid constructor options', () => {
	assert.throws(() => createCohortBenchmarkBuild({}), /buildBenchmarkExecutable/);
	assert.throws(
		() =>
			createCohortBenchmarkBuild({
				repoRoot: '/tmp',
				revisionSha256: 'not-a-sha',
				buildBenchmarkExecutable: () => {},
				benchmarkExecutableSha256: () => {},
				cargoFeaturesForBenchmark: () => {},
			}),
		/revision SHA-256/,
	);
});
