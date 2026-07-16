import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	acquireCorpusBenchmarkLock,
	assertCorpusBenchmarkAccess,
	assertOwnedCorpusBenchmarkLock,
	releaseCorpusBenchmarkLock,
} from './corpus-benchmark-lock.ts';
import { canonicalManifestPath } from './corpus.ts';

const FIRST_TOKEN = '00000000-0000-4000-8000-000000000001';

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-benchmark-lock-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const manifestPath = path.join(directory, 'corpus-local.json');
	fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
	const canonicalDirectory = fs.realpathSync(directory);
	return {
		directory,
		manifestPath,
		localCorpusRoot: path.join(canonicalDirectory, 'local-corpus'),
		lockPath: path.join(canonicalDirectory, 'local-corpus', '.benchmark.lock'),
	};
}

function writeOwnerLock(
	lockPath,
	manifestPath,
	{
		pid = process.pid,
		token = FIRST_TOKEN,
		processIdentity,
		createdAt = '2026-07-16T00:00:00.000Z',
	} = {},
) {
	fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(lockPath, 'owner.json'),
		`${JSON.stringify({
			schema_version: 1,
			pid,
			...(processIdentity ? { process_identity: processIdentity } : {}),
			token,
			manifest_path: canonicalManifestPath(manifestPath, { allowMissing: true }),
			created_at: createdAt,
		})}\n`,
		{ mode: 0o600 },
	);
}

function ownerAt(lockPath) {
	return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
}

test('serializes low-level benchmark lock ownership', (t) => {
	const current = fixture(t);
	fs.mkdirSync(current.localCorpusRoot, { mode: 0o700 });

	const first = acquireCorpusBenchmarkLock(current.manifestPath);
	assert.equal(first.lockPath, current.lockPath);
	assert.throws(
		() => assertCorpusBenchmarkAccess(current.manifestPath),
		/a corpus benchmark is active/,
	);
	assert.doesNotThrow(() => assertCorpusBenchmarkAccess(current.manifestPath, first.token));
	assert.throws(
		() => acquireCorpusBenchmarkLock(current.manifestPath),
		/another corpus benchmark is active/,
	);
	assert.deepEqual(
		fs
			.readdirSync(current.localCorpusRoot)
			.filter((name) => name.startsWith('.benchmark.lock.pending-')),
		[],
	);

	assert.equal(releaseCorpusBenchmarkLock(first.lockPath, first.token), true);
	const second = acquireCorpusBenchmarkLock(current.manifestPath);
	assert.equal(releaseCorpusBenchmarkLock(second.lockPath, second.token), true);
});

test('attests exact current-process ownership for long-lived leases', (t) => {
	const current = fixture(t);
	const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
		currentIdentity: 'benchmark-process',
	});
	const owned = assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
		currentIdentity: 'benchmark-process',
	});
	assert.equal(owned.pid, process.pid);
	assert.equal(owned.processIdentity, 'benchmark-process');
	assert.equal(owned.lockPath, acquired.lockPath);
	assert.equal(owned.manifestPath, acquired.manifestPath);
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, FIRST_TOKEN, {
				currentIdentity: 'benchmark-process',
			}),
		/does not own the corpus benchmark lock/,
	);
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
				currentIdentity: 'different-process',
			}),
		/does not own the corpus benchmark lock/,
	);
	assert.equal(
		releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token, {
			currentIdentity: 'benchmark-process',
		}),
		true,
	);
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
				currentIdentity: 'benchmark-process',
			}),
		/owned corpus benchmark lock is no longer available/,
	);
});

test('requires a recorded and currently verifiable process identity for lease ownership', (t) => {
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath);
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, FIRST_TOKEN, {
				currentIdentity: null,
			}),
		/does not own the corpus benchmark lock/,
	);
	fs.rmSync(current.lockPath, { recursive: true, force: true });

	writeOwnerLock(current.lockPath, current.manifestPath, {
		processIdentity: 'benchmark-process',
	});
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, FIRST_TOKEN, {
				currentIdentity: null,
			}),
		/does not own the corpus benchmark lock/,
	);
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, FIRST_TOKEN, {
				currentIdentity: 'different-process',
			}),
		/does not own the corpus benchmark lock/,
	);
});

test('binds lease ownership to one private opened owner inode', async (t) => {
	await t.test('hard-linked owner', (t) => {
		const current = fixture(t);
		const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
			currentIdentity: 'benchmark-process',
		});
		const ownerPath = path.join(acquired.lockPath, 'owner.json');
		fs.linkSync(ownerPath, path.join(acquired.lockPath, 'owner-alias.json'));
		assert.throws(
			() =>
				assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
					currentIdentity: 'benchmark-process',
				}),
			/must not be hard linked/,
		);
	});

	await t.test('permissive owner mode', (t) => {
		if (process.platform === 'win32') {
			return t.skip('POSIX permission modes are not enforceable on Windows');
		}
		const current = fixture(t);
		const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
			currentIdentity: 'benchmark-process',
		});
		fs.chmodSync(path.join(acquired.lockPath, 'owner.json'), 0o644);
		assert.throws(
			() =>
				assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
					currentIdentity: 'benchmark-process',
				}),
			/private 0600 permissions/,
		);
	});

	await t.test('transient owner path replacement', (t) => {
		const current = fixture(t);
		const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
			currentIdentity: 'benchmark-process',
		});
		const ownerPath = path.join(acquired.lockPath, 'owner.json');
		const displacedPath = path.join(acquired.lockPath, 'owner-original.json');
		const replacementPath = path.join(acquired.lockPath, 'owner-replacement.json');
		const contents = fs.readFileSync(ownerPath);
		const originalOpenSync = fs.openSync;
		let swapped = false;
		t.mock.method(fs, 'openSync', (filePath, ...args) => {
			if (!swapped && filePath === ownerPath) {
				swapped = true;
				fs.renameSync(ownerPath, displacedPath);
				fs.writeFileSync(ownerPath, contents, { mode: 0o600 });
				const descriptor = originalOpenSync(ownerPath, ...args);
				fs.renameSync(ownerPath, replacementPath);
				fs.renameSync(displacedPath, ownerPath);
				return descriptor;
			}
			return originalOpenSync(filePath, ...args);
		});
		assert.throws(
			() =>
				assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
					currentIdentity: 'benchmark-process',
				}),
			/owner changed while it was opened/,
		);
	});
});

test('rejects a transient local-corpus ancestor replacement during owner inspection', (t) => {
	const current = fixture(t);
	const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
		currentIdentity: 'benchmark-process',
	});
	const displacedRoot = `${current.localCorpusRoot}.displaced`;
	const originalReadFileSync = fs.readFileSync;
	let swapped = false;
	t.mock.method(fs, 'readFileSync', (file, ...args) => {
		const contents = originalReadFileSync(file, ...args);
		if (!swapped && typeof file === 'number') {
			swapped = true;
			fs.renameSync(current.localCorpusRoot, displacedRoot);
			fs.renameSync(displacedRoot, current.localCorpusRoot);
		}
		return contents;
	});
	assert.throws(
		() =>
			assertOwnedCorpusBenchmarkLock(current.manifestPath, acquired.token, {
				currentIdentity: 'benchmark-process',
			}),
		(error) => {
			if (process.platform === 'win32') {
				assert.equal(error.code, 'EPERM');
			} else {
				assert.match(
					error.message,
					/benchmark (?:manifest|local corpus) directory changed while benchmark ownership was inspected/,
				);
			}
			return true;
		},
	);
	assert.equal(swapped, true);
	assert.equal(
		releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token, {
			currentIdentity: 'benchmark-process',
		}),
		true,
	);
});

test('recovers a provably dead owner and preserves private evidence', (t) => {
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath, { pid: 999_999_999 });

	const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
		isAlive: () => false,
	});
	const staleEntries = fs
		.readdirSync(current.localCorpusRoot)
		.filter((name) => name.startsWith(`.benchmark.lock.stale-${FIRST_TOKEN}-`));
	assert.equal(staleEntries.length, 1);
	const stalePath = path.join(current.localCorpusRoot, staleEntries[0]);
	assert.equal(ownerAt(stalePath).pid, 999_999_999);
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(stalePath).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(stalePath, 'owner.json')).mode & 0o777, 0o600);
	}
	assert.equal(ownerAt(current.lockPath).pid, process.pid);
	assert.equal(releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token), true);
});

test('lets corpus mutations reclaim a provably dead benchmark owner', (t) => {
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath, {
		pid: 999_999_999,
		processIdentity: 'dead-benchmark-process',
	});

	assert.doesNotThrow(() =>
		assertCorpusBenchmarkAccess(current.manifestPath, null, {
			isAlive: () => false,
		}),
	);
	assert.equal(fs.existsSync(current.lockPath), false);
	const staleEntries = fs
		.readdirSync(current.localCorpusRoot)
		.filter((name) => name.startsWith(`.benchmark.lock.stale-${FIRST_TOKEN}-`));
	assert.equal(staleEntries.length, 1);
	assert.equal(
		ownerAt(path.join(current.localCorpusRoot, staleEntries[0])).process_identity,
		'dead-benchmark-process',
	);
});

test('fails closed when mutation access cannot disprove benchmark ownership', (t) => {
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath, {
		processIdentity: 'possibly-still-running',
	});

	assert.throws(
		() =>
			assertCorpusBenchmarkAccess(current.manifestPath, null, {
				isAlive: () => true,
				identityForPid: () => null,
			}),
		/a corpus benchmark is active/,
	);
	assert.equal(ownerAt(current.lockPath).process_identity, 'possibly-still-running');
});

test('reclaims a reused PID only when its process identity is provably different', (t) => {
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath, {
		processIdentity: 'old-process',
	});

	const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
		currentIdentity: 'new-process',
		isAlive: () => true,
		identityForPid: () => 'new-process',
	});
	assert.equal(ownerAt(current.lockPath).process_identity, 'new-process');
	assert.equal(
		releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token, {
			currentIdentity: 'new-process',
		}),
		true,
	);
});

test('fails closed when a live PID identity cannot be established', (t) => {
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath, {
		processIdentity: 'possibly-still-running',
	});
	assert.throws(
		() =>
			acquireCorpusBenchmarkLock(current.manifestPath, {
				isAlive: () => true,
				identityForPid: () => null,
			}),
		/another corpus benchmark is active/,
	);
});

test('binds ownership to the canonical manifest path', (t) => {
	if (process.platform === 'win32') return t.skip('symbolic-link setup is not portable on Windows');
	const current = fixture(t);
	const aliasPath = path.join(current.directory, 'manifest-alias.json');
	fs.symlinkSync(path.basename(current.manifestPath), aliasPath);

	const acquired = acquireCorpusBenchmarkLock(aliasPath);
	assert.equal(ownerAt(current.lockPath).manifest_path, fs.realpathSync(current.manifestPath));
	assert.equal(acquired.manifestPath, fs.realpathSync(current.manifestPath));
	assert.equal(releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token), true);
});

test('refuses a lock bound to a different canonical manifest', (t) => {
	const current = fixture(t);
	const otherManifest = path.join(current.directory, 'other-corpus.json');
	fs.writeFileSync(otherManifest, '{}\n');
	writeOwnerLock(current.lockPath, otherManifest);

	assert.throws(
		() => acquireCorpusBenchmarkLock(current.manifestPath),
		/benchmark lock is bound to another manifest/,
	);
	assert.equal(ownerAt(current.lockPath).manifest_path, fs.realpathSync(otherManifest));
});

test('fails closed for symlink, non-directory, and malformed locks', async (t) => {
	await t.test('symlink lock', (t) => {
		if (process.platform === 'win32')
			return t.skip('symbolic-link setup is not portable on Windows');
		const current = fixture(t);
		const target = path.join(current.directory, 'lock-target');
		writeOwnerLock(target, current.manifestPath);
		fs.mkdirSync(current.localCorpusRoot, { mode: 0o700 });
		fs.symlinkSync(target, current.lockPath);
		assert.throws(
			() => acquireCorpusBenchmarkLock(current.manifestPath),
			/benchmark lock must be a regular directory/,
		);
	});

	await t.test('regular file lock', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.localCorpusRoot, { mode: 0o700 });
		fs.writeFileSync(current.lockPath, '{}\n');
		assert.throws(
			() => acquireCorpusBenchmarkLock(current.manifestPath),
			/benchmark lock must be a regular directory/,
		);
	});

	await t.test('symlink owner', (t) => {
		if (process.platform === 'win32')
			return t.skip('symbolic-link setup is not portable on Windows');
		const current = fixture(t);
		fs.mkdirSync(current.lockPath, { recursive: true, mode: 0o700 });
		const target = path.join(current.directory, 'owner-target.json');
		fs.writeFileSync(target, '{}\n');
		fs.symlinkSync(target, path.join(current.lockPath, 'owner.json'));
		assert.throws(
			() => acquireCorpusBenchmarkLock(current.manifestPath),
			/benchmark lock owner must be a regular file/,
		);
	});

	await t.test('non-regular owner', (t) => {
		const current = fixture(t);
		fs.mkdirSync(path.join(current.lockPath, 'owner.json'), {
			recursive: true,
			mode: 0o700,
		});
		assert.throws(
			() => acquireCorpusBenchmarkLock(current.manifestPath),
			/benchmark lock owner must be a regular file/,
		);
	});

	await t.test('invalid live owner', (t) => {
		const current = fixture(t);
		fs.mkdirSync(current.lockPath, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			path.join(current.lockPath, 'owner.json'),
			JSON.stringify({ schema_version: 1, pid: process.pid }),
			{ mode: 0o600 },
		);
		assert.throws(
			() =>
				acquireCorpusBenchmarkLock(current.manifestPath, {
					isAlive: () => true,
				}),
			/benchmark lock owner is invalid/,
		);
	});
});

test('fails closed for an unreadable owner when permissions are enforceable', (t) => {
	if (process.platform === 'win32' || process.getuid?.() === 0) {
		return t.skip('POSIX owner permissions are not enforceable in this environment');
	}
	const current = fixture(t);
	writeOwnerLock(current.lockPath, current.manifestPath);
	const ownerPath = path.join(current.lockPath, 'owner.json');
	fs.chmodSync(ownerPath, 0o000);
	try {
		assert.throws(
			() => acquireCorpusBenchmarkLock(current.manifestPath),
			/invalid or unreadable lock/,
		);
	} finally {
		fs.chmodSync(ownerPath, 0o600);
	}
});

test('only the exact pid, token, and identity owner can release', (t) => {
	const current = fixture(t);
	const acquired = acquireCorpusBenchmarkLock(current.manifestPath, {
		currentIdentity: 'benchmark-process',
	});

	assert.equal(
		releaseCorpusBenchmarkLock(acquired.lockPath, FIRST_TOKEN, {
			currentIdentity: 'benchmark-process',
		}),
		false,
	);
	assert(fs.existsSync(current.lockPath));
	assert.equal(
		releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token, {
			currentIdentity: 'different-process',
		}),
		false,
	);
	assert(fs.existsSync(current.lockPath));
	assert.equal(
		releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token, {
			currentIdentity: 'benchmark-process',
		}),
		true,
	);
	assert(!fs.existsSync(current.lockPath));

	writeOwnerLock(current.lockPath, current.manifestPath, {
		pid: process.pid + 1,
		token: acquired.token,
	});
	assert.equal(releaseCorpusBenchmarkLock(current.lockPath, acquired.token), false);
	assert(fs.existsSync(current.lockPath));
});

test('creates the benchmark lock and owner with private modes', (t) => {
	const current = fixture(t);
	const acquired = acquireCorpusBenchmarkLock(current.manifestPath);
	const lockEntry = fs.lstatSync(current.lockPath);
	const ownerEntry = fs.lstatSync(path.join(current.lockPath, 'owner.json'));
	assert(lockEntry.isDirectory());
	assert(!lockEntry.isSymbolicLink());
	assert(ownerEntry.isFile());
	assert(!ownerEntry.isSymbolicLink());
	assert.match(ownerAt(current.lockPath).token, /^[0-9a-f-]{36}$/);
	if (process.platform !== 'win32') {
		assert.equal(fs.statSync(current.localCorpusRoot).mode & 0o777, 0o700);
		assert.equal(fs.statSync(current.lockPath).mode & 0o777, 0o700);
		assert.equal(ownerEntry.mode & 0o777, 0o600);
	}
	assert.equal(releaseCorpusBenchmarkLock(acquired.lockPath, acquired.token), true);
});
