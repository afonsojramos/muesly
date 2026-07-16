import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	EVALUATOR_REVISION_PROTOCOL_ID,
	evaluatorRevision,
	evaluatorRevisionSha256,
	validateEvaluatorRevision,
} from './evaluator-revision.ts';

function git(repositoryRoot, args) {
	return execFileSync('git', ['-C', repositoryRoot, ...args], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function createRepository(t) {
	const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-evaluator-revision-'));
	t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
	git(repositoryRoot, ['init', '--quiet']);
	git(repositoryRoot, ['config', 'user.name', 'Muesly Evaluator Test']);
	git(repositoryRoot, ['config', 'user.email', 'evaluator-test@muesly.invalid']);
	git(repositoryRoot, ['config', 'commit.gpgSign', 'false']);
	fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), 'ignored/\n');
	fs.writeFileSync(path.join(repositoryRoot, 'Cargo.lock'), 'version = 4\n');
	fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'tracked evaluator source\n');
	git(repositoryRoot, ['add', '.gitignore', 'Cargo.lock', 'tracked.txt']);
	git(repositoryRoot, ['commit', '--quiet', '-m', 'test: initialize evaluator repository']);
	return repositoryRoot;
}

function deterministicOptions(overrides = {}) {
	return {
		buildEnv: {
			CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
			POSTHOG_API_KEY: 'private-build-secret',
			RUSTFLAGS: '-C target-cpu=x86-64',
			UNRELATED_PRIVATE_VALUE: 'must-not-affect-provenance',
		},
		cargoFeatures: ['metal', 'audio', 'metal'],
		...overrides,
	};
}

test('returns stable, privacy-safe provenance for a clean evaluator tree', (t) => {
	const repositoryRoot = createRepository(t);
	const first = evaluatorRevision(repositoryRoot, deterministicOptions());
	const second = evaluatorRevision(repositoryRoot, deterministicOptions());

	assert.deepEqual(second, first);
	assert.equal(first.revision.schema_version, 1);
	assert.equal(first.revision.protocol_id, EVALUATOR_REVISION_PROTOCOL_ID);
	assert.match(first.revision.git_commit, /^[a-f0-9]{40}$/);
	assert.match(first.revision.cargo_lock_sha256, /^[a-f0-9]{64}$/);
	assert.match(first.revision.build_env_sha256, /^[a-f0-9]{64}$/);
	assert.match(first.sha256, /^[a-f0-9]{64}$/);
	assert.equal(first.revision.build_profile, 'release');
	assert.equal(first.revision.target_triple, 'x86_64-unknown-linux-gnu');
	assert.deepEqual(first.revision.cargo_features, ['audio', 'metal']);
	assert.equal(
		first.sha256,
		createHash('sha256').update(JSON.stringify(first.revision)).digest('hex'),
	);
	assert.deepEqual(validateEvaluatorRevision(first.revision), []);

	const serialized = JSON.stringify(first);
	assert(!serialized.includes('version = 4'));
	assert(!serialized.includes('private-build-secret'));
	assert(!serialized.includes('must-not-affect-provenance'));
});

test('validates and hashes persisted evaluator revisions canonically', (t) => {
	const repositoryRoot = createRepository(t);
	const { revision, sha256 } = evaluatorRevision(repositoryRoot, deterministicOptions());
	const reordered = {
		build_env_sha256: revision.build_env_sha256,
		cargo_features: revision.cargo_features,
		target_triple: revision.target_triple,
		build_profile: revision.build_profile,
		rustc_vv: revision.rustc_vv,
		cargo_lock_sha256: revision.cargo_lock_sha256,
		git_commit: revision.git_commit,
		protocol_id: revision.protocol_id,
		schema_version: revision.schema_version,
	};
	assert.deepEqual(validateEvaluatorRevision(reordered), []);
	assert.equal(evaluatorRevisionSha256(reordered), sha256);

	const invalid = { ...revision, private_transcript: 'must never be persisted' };
	assert.deepEqual(validateEvaluatorRevision(invalid), [
		'evaluator_revision.private_transcript is not allowed',
	]);
	assert.throws(() => evaluatorRevisionSha256(invalid), /invalid evaluator revision/);
});

test('Cargo features and allowlisted build inputs deterministically change the digest', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({ cargoFeatures: ['audio', 'metal'] }),
	);
	const reordered = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({ cargoFeatures: ['metal', 'audio'] }),
	);
	const changedFeature = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({ cargoFeatures: ['audio', 'cuda'] }),
	);
	const changedAllowedEnvironment = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				RUSTFLAGS: '-C target-cpu=native',
			},
			cargoFeatures: ['audio', 'metal'],
		}),
	);
	const changedUnlistedEnvironment = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				POSTHOG_API_KEY: 'private-build-secret',
				RUSTFLAGS: '-C target-cpu=x86-64',
				UNRELATED_PRIVATE_VALUE: 'different ignored value',
			},
			cargoFeatures: ['audio', 'metal'],
		}),
	);

	assert.equal(reordered.sha256, baseline.sha256);
	assert.notEqual(changedFeature.sha256, baseline.sha256);
	assert.notEqual(changedAllowedEnvironment.sha256, baseline.sha256);
	assert.equal(changedUnlistedEnvironment.sha256, baseline.sha256);
});

test('target-scoped Cargo and compiler inputs change the evaluator digest', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=x86-64',
				CC_x86_64_unknown_linux_gnu: 'clang',
			},
		}),
	);
	const changedCargoTarget = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=native',
				CC_x86_64_unknown_linux_gnu: 'clang',
			},
		}),
	);
	const changedCompiler = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=x86-64',
				CC_x86_64_unknown_linux_gnu: 'zig cc',
			},
		}),
	);

	assert.notEqual(changedCargoTarget.sha256, baseline.sha256);
	assert.notEqual(changedCompiler.sha256, baseline.sha256);
});

test('refuses tracked unstaged evaluator changes without exposing their path or content', (t) => {
	const repositoryRoot = createRepository(t);
	fs.appendFileSync(path.join(repositoryRoot, 'tracked.txt'), 'private transcript fragment\n');

	assert.throws(
		() => evaluatorRevision(repositoryRoot, deterministicOptions()),
		(error) => {
			assert.match(error.message, /requires a clean Git worktree/);
			assert(!error.message.includes('tracked.txt'));
			assert(!error.message.includes('private transcript fragment'));
			return true;
		},
	);
});

test('refuses staged evaluator changes', (t) => {
	const repositoryRoot = createRepository(t);
	fs.appendFileSync(path.join(repositoryRoot, 'tracked.txt'), 'staged change\n');
	git(repositoryRoot, ['add', 'tracked.txt']);

	assert.throws(
		() => evaluatorRevision(repositoryRoot, deterministicOptions()),
		/requires a clean Git worktree/,
	);
});

test('refuses non-ignored untracked files and symbolic links', async (t) => {
	await t.test('regular file', (subtest) => {
		const repositoryRoot = createRepository(subtest);
		fs.writeFileSync(path.join(repositoryRoot, 'private-untracked.txt'), 'untracked transcript\n');
		assert.throws(
			() => evaluatorRevision(repositoryRoot, deterministicOptions()),
			/requires a clean Git worktree/,
		);
	});

	await t.test('symbolic link', (subtest) => {
		const repositoryRoot = createRepository(subtest);
		const targetPath = path.join(repositoryRoot, 'outside-private-audio.wav');
		fs.writeFileSync(targetPath, 'not real audio');
		git(repositoryRoot, ['add', 'outside-private-audio.wav']);
		git(repositoryRoot, ['commit', '--quiet', '-m', 'test: add symlink target']);
		try {
			fs.symlinkSync('outside-private-audio.wav', path.join(repositoryRoot, 'private-audio-link'));
		} catch (error) {
			if (error.code === 'EPERM' || error.code === 'EACCES') {
				subtest.skip('symbolic links are unavailable on this platform');
				return;
			}
			throw error;
		}
		assert.throws(
			() => evaluatorRevision(repositoryRoot, deterministicOptions()),
			/requires a clean Git worktree/,
		);
	});
});

test('ignored files do not change clean evaluator provenance', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(repositoryRoot, deterministicOptions());
	fs.mkdirSync(path.join(repositoryRoot, 'ignored'));
	fs.writeFileSync(path.join(repositoryRoot, 'ignored', 'private-corpus.wav'), 'private audio');
	const after = evaluatorRevision(repositoryRoot, deterministicOptions());
	assert.deepEqual(after, baseline);
});

test('fails clearly outside Git and when evaluator state is incomplete', async (t) => {
	await t.test('non-Git directory', (subtest) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-evaluator-no-git-'));
		subtest.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		assert.throws(() => evaluatorRevision(directory, deterministicOptions()), /not a Git worktree/);
	});

	await t.test('missing tracked Cargo.lock', (subtest) => {
		const repositoryRoot = createRepository(subtest);
		git(repositoryRoot, ['rm', '--quiet', 'Cargo.lock']);
		git(repositoryRoot, ['commit', '--quiet', '-m', 'test: remove Cargo lock']);
		assert.throws(
			() => evaluatorRevision(repositoryRoot, deterministicOptions()),
			/requires a tracked Cargo.lock/,
		);
	});
});

test('rejects malformed Cargo features and target triples', (t) => {
	const repositoryRoot = createRepository(t);
	assert.throws(
		() =>
			evaluatorRevision(
				repositoryRoot,
				deterministicOptions({ cargoFeatures: ['metal', 'private feature value'] }),
			),
		/valid Cargo feature names/,
	);
	assert.throws(
		() =>
			evaluatorRevision(
				repositoryRoot,
				deterministicOptions({ targetTriple: '../private-target.json' }),
			),
		/valid Rust target triple/,
	);
});
