import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	BENCHMARK_RUSTC_WRAPPER_ERROR,
	EVALUATOR_REVISION_PROTOCOL_ID,
	attestedCommandCandidates,
	attestedRustcVersion,
	evaluatorBuildEnvironment,
	evaluatorRevision,
	evaluatorRevisionSha256,
	execAttestedCommandSync,
	resolveAttestedCommand,
	sanitizeAttestedCommandEnvironment,
	validateEvaluatorRevision,
} from './evaluator-revision.ts';

const COMMAND_DISCOVERY_ENVIRONMENT_NAMES = [
	'PATH',
	'Path',
	'PATHEXT',
	'CARGO_HOME',
	'HOME',
	'RUSTUP_HOME',
	'RUSTUP_TOOLCHAIN',
	'SystemRoot',
	'USERPROFILE',
	'WINDIR',
];
const HOSTILE_RUSTC_ENVIRONMENT_NAMES = [
	'DYLD_INSERT_LIBRARIES',
	'DYLD_LIBRARY_PATH',
	'LD_LIBRARY_PATH',
	'LD_PRELOAD',
	'NODE_OPTIONS',
	'PYTHONPATH',
	'RUSTC_BOOTSTRAP',
	'RUSTC_FORCE_INCREMENTAL',
	'RUSTC_LOG',
	'RUSTC_WORKSPACE_WRAPPER',
	'RUSTC_WRAPPER',
	'RUSTFLAGS',
];

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

function commandDiscoveryEnvironment() {
	const environment = {};
	for (const name of COMMAND_DISCOVERY_ENVIRONMENT_NAMES) {
		if (typeof process.env[name] === 'string') environment[name] = process.env[name];
	}
	return environment;
}

function fullyQualifiedAbsolutePath(value) {
	if (!path.isAbsolute(value)) return false;
	if (process.platform !== 'win32') return true;
	return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value);
}

function safeCommandSearchPath() {
	const searchPath = process.env.PATH ?? process.env.Path;
	assert.equal(typeof searchPath, 'string');
	const absoluteEntries = searchPath
		.split(path.delimiter)
		.map((entry) =>
			entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
				? entry.slice(1, -1)
				: entry,
		)
		.filter(fullyQualifiedAbsolutePath);
	assert(absoluteEntries.length > 0);
	return absoluteEntries.join(path.delimiter);
}

function commandSearchEnvironment(searchPath) {
	return {
		PATH: searchPath,
		...(process.platform === 'win32' ? { Path: searchPath } : {}),
	};
}

function writeCommandTrap(directory, command) {
	const executablePath = path.join(
		directory,
		process.platform === 'win32' ? `${command}.exe` : command,
	);
	fs.writeFileSync(executablePath, 'this file must never be executed\n', {
		mode: 0o755,
	});
	return executablePath;
}

function deterministicOptions(overrides = {}) {
	const { buildEnv: buildEnvironmentOverrides = {}, ...optionOverrides } = overrides;
	return {
		buildEnv: {
			...commandDiscoveryEnvironment(),
			CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
			POSTHOG_API_KEY: 'private-build-secret',
			RUSTFLAGS: '-C target-cpu=x86-64',
			UNRELATED_PRIVATE_VALUE: 'must-not-affect-provenance',
			...buildEnvironmentOverrides,
		},
		cargoFeatures: ['metal', 'audio', 'metal'],
		...optionOverrides,
	};
}

function setAmbientEnvironment(t, values) {
	const previous = new Map();
	for (const [name, value] of Object.entries(values)) {
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	t.after(() => {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	});
}

function createRustcEnvironmentProbe(t, { invocationMarker = null } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-rustc-environment-probe-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const sourcePath = path.join(directory, 'probe.rs');
	const executablePath = path.join(
		directory,
		process.platform === 'win32' ? 'rustc-probe.exe' : 'rustc-probe',
	);
	fs.writeFileSync(
		sourcePath,
		`use std::{env, ffi::OsStr, process};

fn main() {
${invocationMarker === null ? '' : `    std::fs::write(${JSON.stringify(invocationMarker)}, b"started").unwrap();\n`}
    let hostile = ${JSON.stringify(HOSTILE_RUSTC_ENVIRONMENT_NAMES)};
    if hostile.iter().any(|name| env::var_os(name).is_some()) {
        process::exit(91);
    }
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.len() != 1 || args[0] != OsStr::new("-vV") {
        process::exit(92);
    }
    print!("rustc 1.85.0 (aaaaaaaaa 2025-02-17)\\n");
    print!("binary: rustc\\n");
    print!("commit-hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n");
    print!("commit-date: 2025-02-17\\n");
    print!("host: x86_64-unknown-linux-gnu\\n");
    print!("release: 1.85.0\\n");
    print!("LLVM version: 19.1.7\\n");
}
`,
	);
	execFileSync('rustc', [sourcePath, '-o', executablePath], {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return executablePath;
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

test('ignores hostile ambient Git repository, index, config, and object overrides', (t) => {
	const repositoryRoot = createRepository(t);
	const attackerRoot = createRepository(t);
	const hostileConfigPath = path.join(attackerRoot, 'hostile.gitconfig');
	const hostileIndexPath = path.join(attackerRoot, 'hostile.index');
	const hostileObjectsPath = path.join(attackerRoot, 'hostile-objects');
	fs.writeFileSync(hostileConfigPath, '[invalid config\n');
	fs.mkdirSync(hostileObjectsPath);
	const options = deterministicOptions();
	const baseline = evaluatorRevision(repositoryRoot, options);

	setAmbientEnvironment(t, {
		DYLD_INSERT_LIBRARIES: '',
		GIT_ALTERNATE_OBJECT_DIRECTORIES: hostileObjectsPath,
		GIT_COMMON_DIR: path.join(attackerRoot, '.git'),
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_GLOBAL: hostileConfigPath,
		GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
		GIT_CONFIG_SYSTEM: hostileConfigPath,
		GIT_CONFIG_VALUE_0: '999',
		GIT_DIR: path.join(attackerRoot, '.git'),
		GIT_INDEX_FILE: hostileIndexPath,
		GIT_OBJECT_DIRECTORY: hostileObjectsPath,
		GIT_WORK_TREE: attackerRoot,
		LD_PRELOAD: '',
	});

	assert.deepEqual(evaluatorRevision(repositoryRoot, options), baseline);
});

test('runs rustc provenance with only attested discovery state', (t) => {
	const repositoryRoot = createRepository(t);
	const rustcExecutable = createRustcEnvironmentProbe(t);
	const baselineOptions = deterministicOptions({
		buildEnv: {
			RUSTC_BOOTSTRAP: '1',
		},
		rustcExecutable,
	});
	const baseline = evaluatorRevision(repositoryRoot, baselineOptions);

	setAmbientEnvironment(
		t,
		Object.fromEntries(HOSTILE_RUSTC_ENVIRONMENT_NAMES.map((name) => [name, ''])),
	);
	assert.deepEqual(evaluatorRevision(repositoryRoot, baselineOptions), baseline);
});

test('rejects compiler wrappers before evaluator context or rustc can start', (t) => {
	const repositoryRoot = createRepository(t);
	const invocationMarker = path.join(repositoryRoot, 'ignored', 'rustc-started');
	const rustcExecutable = createRustcEnvironmentProbe(t, { invocationMarker });
	const safePath = safeCommandSearchPath();
	for (const name of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) {
		const buildEnv = {
			...commandSearchEnvironment(safePath),
			[name]: '/private/compiler-wrapper',
		};
		assert.throws(
			() =>
				evaluatorBuildEnvironment(buildEnv, 'x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'),
			(error) => {
				assert.equal(error.message, BENCHMARK_RUSTC_WRAPPER_ERROR);
				return true;
			},
		);
		assert.throws(
			() => attestedRustcVersion(repositoryRoot, { buildEnv, rustcExecutable }),
			(error) => {
				assert.equal(error.message, BENCHMARK_RUSTC_WRAPPER_ERROR);
				return true;
			},
		);
		assert.throws(
			() => evaluatorRevision('/evaluator-must-not-be-opened', { buildEnv }),
			(error) => {
				assert.equal(error.message, BENCHMARK_RUSTC_WRAPPER_ERROR);
				return true;
			},
		);
		assert.equal(fs.existsSync(invocationMarker), false);
	}

	const emptyWrappers = evaluatorBuildEnvironment(
		{
			...commandSearchEnvironment(safePath),
			RUSTC_WORKSPACE_WRAPPER: '',
			RUSTC_WRAPPER: '',
		},
		'x86_64-unknown-linux-gnu',
		'x86_64-unknown-linux-gnu',
	);
	assert.equal(emptyWrappers.RUSTC_WORKSPACE_WRAPPER, '');
	assert.equal(emptyWrappers.RUSTC_WRAPPER, '');
});

test('preserves an absolute rustc shim argv0 while attesting its canonical executable', (t) => {
	if (process.platform === 'win32') {
		return t.skip('symbolic-link command shims are Unix-specific');
	}
	const repositoryRoot = createRepository(t);
	const rustcExecutable = createRustcEnvironmentProbe(t);
	const rustcShim = `${rustcExecutable}-shim`;
	fs.symlinkSync(rustcExecutable, rustcShim);
	t.after(() => fs.rmSync(rustcShim, { force: true }));

	const identity = attestedRustcVersion(repositoryRoot, {
		buildEnv: commandSearchEnvironment(safeCommandSearchPath()),
		rustcExecutable: rustcShim,
	});

	assert.equal(identity.hostTriple, 'x86_64-unknown-linux-gnu');
	assert.equal(identity.command.argv0, rustcShim);
	assert.equal(identity.command.executablePath, fs.realpathSync(rustcExecutable));
	assert.match(identity.command.sha256, /^[a-f0-9]{64}$/);
});

test('rejects a command replaced during an attested invocation', (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-command-swap-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const executablePath = path.join(directory, 'cargo');
	fs.writeFileSync(executablePath, 'original command', { mode: 0o755 });
	const command = resolveAttestedCommand(executablePath, {}, 'Cargo executable');

	assert.throws(
		() =>
			execAttestedCommandSync(
				command,
				['--version'],
				{},
				{
					execFileSyncImpl: () => {
						fs.rmSync(executablePath);
						fs.writeFileSync(executablePath, 'replacement command', { mode: 0o755 });
						return '';
					},
				},
			),
		/Cargo executable changed while it was being executed/,
	);
});

test('sanitizes command PATH entries and restricts Windows automatic executables', () => {
	const windowsEnvironment = {
		PATH: '"C:\\Program Files\\Rust\\bin";.;relative;;D:\\tools',
		PATHEXT: '.CMD;.EXE;.BAT;.COM;.PS1',
	};
	assert.deepEqual(sanitizeAttestedCommandEnvironment(windowsEnvironment, { platform: 'win32' }), {
		PATH: 'C:\\Program Files\\Rust\\bin;D:\\tools',
		PATHEXT: windowsEnvironment.PATHEXT,
	});
	assert.deepEqual(attestedCommandCandidates('rustc', windowsEnvironment, { platform: 'win32' }), [
		'C:\\Program Files\\Rust\\bin\\rustc.EXE',
		'C:\\Program Files\\Rust\\bin\\rustc.COM',
		'D:\\tools\\rustc.EXE',
		'D:\\tools\\rustc.COM',
	]);
	assert.deepEqual(
		attestedCommandCandidates('rustc.cmd', windowsEnvironment, { platform: 'win32' }),
		[],
	);
	assert.throws(
		() =>
			attestedCommandCandidates(
				'rustc',
				{ ...windowsEnvironment, Path: 'E:\\hostile' },
				{ platform: 'win32' },
			),
		/conflicting PATH entries/,
	);
	assert.throws(
		() =>
			sanitizeAttestedCommandEnvironment(
				{ ...windowsEnvironment, PATH: '"C:\\unterminated;D:\\tools' },
				{ platform: 'win32' },
			),
		/malformed PATH entry/,
	);
});

test('excludes volatile per-process tool shim directories from the attested PATH', () => {
	if (process.platform === 'win32') return;
	const shimDirectory = path.join(
		os.tmpdir(),
		`nub-node-shim-${process.pid}-0123456789abcdef0123456789abcdef`,
	);
	const lookalikeDirectory = path.join('/usr', 'nub-node-shim-keep');
	const searchPath = [shimDirectory, '/usr/bin', lookalikeDirectory, '/bin'].join(path.delimiter);
	const sanitized = sanitizeAttestedCommandEnvironment({ PATH: searchPath });
	assert.equal(
		sanitized.PATH,
		['/usr/bin', lookalikeDirectory, '/bin'].join(path.delimiter),
	);
	const withoutShim = sanitizeAttestedCommandEnvironment({
		PATH: ['/usr/bin', lookalikeDirectory, '/bin'].join(path.delimiter),
	});
	assert.equal(sanitized.PATH, withoutShim.PATH);
});

test('ignores current-directory command shadows and relative or empty PATH entries', (t) => {
	const repositoryRoot = createRepository(t);
	const benignDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-command-benign-'));
	const hostileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'muesly-command-hostile-'));
	t.after(() => fs.rmSync(benignDirectory, { recursive: true, force: true }));
	t.after(() => fs.rmSync(hostileDirectory, { recursive: true, force: true }));
	writeCommandTrap(hostileDirectory, 'git');
	const absoluteSearchPath = safeCommandSearchPath();
	const searchPath = ['.', '', absoluteSearchPath].join(path.delimiter);
	const options = deterministicOptions({
		buildEnv: commandSearchEnvironment(searchPath),
	});
	const originalDirectory = process.cwd();
	try {
		process.chdir(benignDirectory);
		const baseline = evaluatorRevision(repositoryRoot, options);
		process.chdir(hostileDirectory);
		assert.deepEqual(evaluatorRevision(repositoryRoot, options), baseline);
	} finally {
		process.chdir(originalDirectory);
	}
});

test('does not resolve rustc through a repository-relative PATH entry', (t) => {
	const repositoryRoot = createRepository(t);
	const ignoredDirectory = path.join(repositoryRoot, 'ignored');
	fs.mkdirSync(ignoredDirectory);
	writeCommandTrap(ignoredDirectory, 'rustc');
	const searchPath = ['ignored', '', safeCommandSearchPath()].join(path.delimiter);

	assert.doesNotThrow(() =>
		evaluatorRevision(
			repositoryRoot,
			deterministicOptions({
				buildEnv: commandSearchEnvironment(searchPath),
			}),
		),
	);
});

test('fails closed when PATH has no absolute command directory', (t) => {
	const repositoryRoot = createRepository(t);
	const searchPath = ['.', '', 'relative-bin'].join(path.delimiter);

	assert.throws(
		() =>
			evaluatorRevision(
				repositoryRoot,
				deterministicOptions({
					buildEnv: commandSearchEnvironment(searchPath),
				}),
			),
		/(?:unable to resolve Git executable|no absolute PATH entries)/,
	);
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

test('sanitizes Cargo build inputs to the same attested environment surface', () => {
	const safePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin';
	const unsafePath = ['.', '', 'relative-bin', safePath].join(path.delimiter);
	const environment = evaluatorBuildEnvironment(
		{
			BLAS_INCLUDE_DIRS: '/opt/blas/include',
			CMAKE_GENERATOR: 'Ninja',
			GGML_METAL_EMBED_LIBRARY: '1',
			PATH: unsafePath,
			WHISPER_DONT_GENERATE_BINDINGS: '1',
			WHISPER_PRIVATE_TOGGLE: 'enabled',
			UNRELATED_PRIVATE_VALUE: 'must not reach Cargo',
		},
		'x86_64-unknown-linux-gnu',
		'x86_64-unknown-linux-gnu',
	);
	assert.deepEqual(environment, {
		BLAS_INCLUDE_DIRS: '/opt/blas/include',
		CMAKE_GENERATOR: 'Ninja',
		GGML_METAL_EMBED_LIBRARY: '1',
		PATH: safePath,
		WHISPER_DONT_GENERATE_BINDINGS: '1',
		WHISPER_PRIVATE_TOGGLE: 'enabled',
	});
});

test('whisper, ggml, cmake, and BLAS build inputs change provenance', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(repositoryRoot, deterministicOptions());
	for (const [name, value] of [
		['BLAS_INCLUDE_DIRS', '/opt/blas/include'],
		['CMAKE_GENERATOR', 'Ninja'],
		['GGML_METAL_EMBED_LIBRARY', '1'],
		['WHISPER_DONT_GENERATE_BINDINGS', '1'],
		['WHISPER_CUSTOM_BUILD_TOGGLE', 'enabled'],
	]) {
		const changed = evaluatorRevision(
			repositoryRoot,
			deterministicOptions({
				buildEnv: {
					...deterministicOptions().buildEnv,
					[name]: value,
				},
			}),
		);
		assert.notEqual(changed.sha256, baseline.sha256, name);
	}
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

test('pkg-config build-kind inputs change the evaluator digest', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				HOST_PKG_CONFIG_PATH: '/opt/native/pkgconfig',
				TARGET_PKG_CONFIG_LIBDIR: '/opt/target/lib/pkgconfig',
			},
		}),
	);
	const changedHost = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				HOST_PKG_CONFIG_PATH: '/usr/local/native/pkgconfig',
				TARGET_PKG_CONFIG_LIBDIR: '/opt/target/lib/pkgconfig',
			},
		}),
	);
	const changedTarget = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				HOST_PKG_CONFIG_PATH: '/opt/native/pkgconfig',
				TARGET_PKG_CONFIG_LIBDIR: '/usr/local/target/lib/pkgconfig',
			},
		}),
	);

	assert.notEqual(changedHost.sha256, baseline.sha256);
	assert.notEqual(changedTarget.sha256, baseline.sha256);
});

test('pkg-config executable inputs are tracked without inventing targeted static flags', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				PKG_CONFIG: '/usr/bin/pkg-config',
				TARGET_PKG_CONFIG: '/opt/cross/bin/pkg-config',
			},
		}),
	);
	const changedExecutable = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				PKG_CONFIG: '/usr/bin/pkgconf',
				TARGET_PKG_CONFIG: '/opt/cross/bin/pkg-config',
			},
		}),
	);
	const changedTargetExecutable = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				PKG_CONFIG: '/usr/bin/pkg-config',
				TARGET_PKG_CONFIG: '/opt/other/bin/pkg-config',
			},
		}),
	);
	const unsupportedPkgConfigAliases = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				PKG_CONFIG: '/usr/bin/pkg-config',
				TARGET_PKG_CONFIG: '/opt/cross/bin/pkg-config',
				HOST_PKG_CONFIG_ALL_STATIC: '1',
				TARGET_PKG_CONFIG_ALL_DYNAMIC: '1',
				PKG_CONFIG_ALL_STATIC_x86_64_unknown_linux_gnu: '1',
				x86_64_unknown_linux_gnu_PKG_CONFIG: '/opt/ignored/bin/pkg-config',
				x86_64_unknown_linux_gnu_PKG_CONFIG_PATH: '/opt/ignored/lib/pkgconfig',
			},
		}),
	);

	assert.notEqual(changedExecutable.sha256, baseline.sha256);
	assert.notEqual(changedTargetExecutable.sha256, baseline.sha256);
	assert.equal(unsupportedPkgConfigAliases.sha256, baseline.sha256);
});

test('target-scoped settings for unrelated targets do not change the evaluator digest', (t) => {
	const repositoryRoot = createRepository(t);
	const baseline = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=x86-64',
			},
		}),
	);
	const unrelatedTarget = evaluatorRevision(
		repositoryRoot,
		deterministicOptions({
			buildEnv: {
				CARGO_BUILD_TARGET: 'x86_64-unknown-linux-gnu',
				CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=x86-64',
				CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C target-cpu=native',
				CC_aarch64_unknown_linux_gnu: 'zig cc',
				PKG_CONFIG_PATH_aarch64_unknown_linux_gnu: '/private/arm/pkgconfig',
			},
		}),
	);

	assert.equal(unrelatedTarget.sha256, baseline.sha256);
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
