import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EVALUATOR_REVISION_PROTOCOL_ID = 'muesly-real-run-v1';

/**
 * Environment variables that can intentionally affect the evaluator build.
 *
 * Values never leave this module: only a canonical SHA-256 of this map is
 * included in evaluator provenance.
 */
export const EVALUATOR_BUILD_ENV_ALLOWLIST = Object.freeze([
	'AR',
	'ALL_PROXY',
	'BINDGEN_EXTRA_CLANG_ARGS',
	'BLAS_INCLUDE_DIRS',
	'CARGO_BUILD_RUSTFLAGS',
	'CARGO_BUILD_TARGET',
	'CARGO_ENCODED_RUSTFLAGS',
	'CARGO_HOME',
	'CARGO_INCREMENTAL',
	'CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_CODEGEN_UNITS',
	'CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_DEBUG',
	'CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_OPT_LEVEL',
	'CARGO_PROFILE_RELEASE_CODEGEN_UNITS',
	'CARGO_PROFILE_RELEASE_DEBUG',
	'CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS',
	'CARGO_PROFILE_RELEASE_INCREMENTAL',
	'CARGO_PROFILE_RELEASE_LTO',
	'CARGO_PROFILE_RELEASE_OPT_LEVEL',
	'CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS',
	'CARGO_PROFILE_RELEASE_PANIC',
	'CARGO_PROFILE_RELEASE_RPATH',
	'CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO',
	'CARGO_PROFILE_RELEASE_STRIP',
	'CARGO_TARGET_DIR',
	'CC',
	'CFLAGS',
	'CMAKE_CUDA_ARCHITECTURES',
	'CMAKE_GENERATOR',
	'CMAKE_MAKE_PROGRAM',
	'CMAKE_OSX_DEPLOYMENT_TARGET',
	'CMAKE_TOOLCHAIN_FILE',
	'CPPFLAGS',
	'CUDACXX',
	'CUDAARCHS',
	'CUDA_HOME',
	'CUDA_PATH',
	'CXX',
	'CXXFLAGS',
	'HIP_PATH',
	'HOME',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'INCLUDE',
	'IPHONEOS_DEPLOYMENT_TARGET',
	'LANG',
	'LC_ALL',
	'LDFLAGS',
	'LD',
	'LIBCLANG_PATH',
	'LIB',
	'LIBPATH',
	'MACOSX_DEPLOYMENT_TARGET',
	'NO_PROXY',
	'OPENSSL_DIR',
	'OPENSSL_INCLUDE_DIR',
	'OPENSSL_LIB_DIR',
	'OPENSSL_STATIC',
	'NM',
	'PKG_CONFIG',
	'PKG_CONFIG_ALL_DYNAMIC',
	'PKG_CONFIG_ALL_STATIC',
	'PKG_CONFIG_ALLOW_CROSS',
	'PKG_CONFIG_LIBDIR',
	'PKG_CONFIG_PATH',
	'PKG_CONFIG_SYSROOT_DIR',
	'POSTHOG_API_KEY',
	'PATH',
	'Path',
	'PATHEXT',
	'ROCM_PATH',
	'RUSTC',
	'RUSTC_BOOTSTRAP',
	'RUSTC_WRAPPER',
	'RUSTC_WORKSPACE_WRAPPER',
	'RUSTFLAGS',
	'RUSTUP_TOOLCHAIN',
	'RUSTUP_HOME',
	'RANLIB',
	'SDKROOT',
	'SSL_CERT_DIR',
	'SSL_CERT_FILE',
	'SOURCE_DATE_EPOCH',
	'STRIP',
	'SystemRoot',
	'TEMP',
	'TMP',
	'TMPDIR',
	'USERPROFILE',
	'VCPKG_ROOT',
	'VULKAN_SDK',
	'WHISPER_DONT_GENERATE_BINDINGS',
	'WINDIR',
	'all_proxy',
	'http_proxy',
	'https_proxy',
	'no_proxy',
]);
const EVALUATOR_BUILD_ENV_PREFIXES = Object.freeze([
	'BLAS_',
	'CCACHE_',
	'CMAKE_',
	'GGML_',
	'SCCACHE_',
	'WHISPER_',
]);

const TARGET_TOOL_VARIABLES = Object.freeze([
	'AR',
	'CC',
	'CFLAGS',
	'CPPFLAGS',
	'CXX',
	'CXXFLAGS',
	'LD',
	'LDFLAGS',
	'NM',
	'OBJC',
	'OBJCFLAGS',
	'RANLIB',
	'STRIP',
]);
const TARGET_PKG_CONFIG_VARIABLES = Object.freeze([
	'PKG_CONFIG',
	'PKG_CONFIG_ALLOW_CROSS',
	'PKG_CONFIG_LIBDIR',
	'PKG_CONFIG_PATH',
	'PKG_CONFIG_SYSROOT_DIR',
]);
const COMMAND_DISCOVERY_ENVIRONMENT_NAMES = Object.freeze([
	'PATH',
	'Path',
	'PATHEXT',
	'SystemRoot',
	'WINDIR',
]);
const RUSTC_PROBE_ENVIRONMENT_NAMES = Object.freeze([
	...COMMAND_DISCOVERY_ENVIRONMENT_NAMES,
	'CARGO_HOME',
	'HOME',
	'RUSTUP_HOME',
	'RUSTUP_TOOLCHAIN',
	'USERPROFILE',
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const TARGET_TRIPLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CARGO_FEATURE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.+:/-]*$/;
const EVALUATOR_REVISION_FIELDS = Object.freeze([
	'schema_version',
	'protocol_id',
	'git_commit',
	'cargo_lock_sha256',
	'rustc_vv',
	'build_profile',
	'target_triple',
	'cargo_features',
	'build_env_sha256',
]);

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function normalizeRustcVersion(value) {
	if (typeof value !== 'string' || value.includes('\0')) {
		throw new Error('rustc -vV returned malformed output');
	}
	const normalized = value
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.trim();
	if (normalized.length === 0) throw new Error('rustc -vV returned empty output');
	const hosts = normalized
		.split('\n')
		.filter((line) => line.startsWith('host: '))
		.map((line) => line.slice('host: '.length).trim());
	if (hosts.length !== 1 || !TARGET_TRIPLE_PATTERN.test(hosts[0])) {
		throw new Error('rustc -vV returned malformed host information');
	}
	return { rustcVv: normalized, hostTriple: hosts[0] };
}

function validateRustcVersion(value, field) {
	const errors = [];
	let normalized;
	try {
		normalized = normalizeRustcVersion(value).rustcVv;
	} catch {
		return [`${field} must be normalized full output from rustc -vV`];
	}
	if (value !== normalized) {
		errors.push(`${field} must use LF line endings with no surrounding or trailing whitespace`);
	}
	const lines = normalized.split('\n');
	const expected = [
		/^rustc [A-Za-z0-9][A-Za-z0-9.+() _-]*$/,
		/^binary: rustc$/,
		/^commit-hash: (?:[a-f0-9]{40}|unknown)$/,
		/^commit-date: (?:[0-9]{4}-[0-9]{2}-[0-9]{2}|unknown)$/,
		/^host: [A-Za-z0-9][A-Za-z0-9_.-]*$/,
		/^release: [A-Za-z0-9][A-Za-z0-9.+-]*$/,
		/^LLVM version: [0-9][0-9.]*$/,
	];
	if (
		lines.length !== expected.length ||
		lines.some((line, index) => !expected[index]?.test(line))
	) {
		errors.push(`${field} must contain the standard privacy-safe rustc -vV fields`);
	}
	return errors;
}

function normalizeCargoFeatures(cargoFeatures) {
	if (!Array.isArray(cargoFeatures)) {
		throw new Error('cargoFeatures must be an array');
	}
	const unique = new Set();
	for (const feature of cargoFeatures) {
		if (
			typeof feature !== 'string' ||
			feature.length === 0 ||
			feature !== feature.trim() ||
			!CARGO_FEATURE_PATTERN.test(feature)
		) {
			throw new Error('cargoFeatures must contain only valid Cargo feature names');
		}
		unique.add(feature);
	}
	return [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function environmentValue(buildEnv, name) {
	return Object.hasOwn(buildEnv, name) ? buildEnv[name] : undefined;
}

function targetEnvironmentNames(targetTriples) {
	const names = new Set();
	for (const targetTriple of targetTriples) {
		const underscored = targetTriple.replaceAll('-', '_').replaceAll('.', '_');
		for (const variable of TARGET_TOOL_VARIABLES) {
			names.add(`${variable}_${targetTriple}`);
			names.add(`${variable}_${underscored}`);
		}
		for (const variable of TARGET_PKG_CONFIG_VARIABLES) {
			names.add(`${variable}_${targetTriple}`);
			names.add(`${variable}_${underscored}`);
		}
	}
	for (const variable of TARGET_TOOL_VARIABLES) {
		names.add(`HOST_${variable}`);
		names.add(`TARGET_${variable}`);
	}
	for (const variable of TARGET_PKG_CONFIG_VARIABLES) {
		names.add(`HOST_${variable}`);
		names.add(`TARGET_${variable}`);
	}
	return names;
}

function selectedBuildEnvironmentNames(buildEnv, targetTriple, hostTriple) {
	if (buildEnv === null || typeof buildEnv !== 'object' || Array.isArray(buildEnv)) {
		throw new Error('buildEnv must be an environment map');
	}
	const names = new Set(EVALUATOR_BUILD_ENV_ALLOWLIST);
	const targetNames = targetEnvironmentNames(new Set([targetTriple, hostTriple]));
	const cargoPrefixes = [...new Set([targetTriple, hostTriple])].map(
		(triple) => `CARGO_TARGET_${triple.replaceAll('-', '_').replaceAll('.', '_').toUpperCase()}_`,
	);
	for (const name of Object.keys(buildEnv)) {
		if (
			targetNames.has(name) ||
			cargoPrefixes.some((prefix) => name.startsWith(prefix)) ||
			EVALUATOR_BUILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
		) {
			names.add(name);
		}
	}
	return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function evaluatorBuildEnvironment(buildEnv, targetTriple, hostTriple) {
	if (
		typeof targetTriple !== 'string' ||
		!TARGET_TRIPLE_PATTERN.test(targetTriple) ||
		typeof hostTriple !== 'string' ||
		!TARGET_TRIPLE_PATTERN.test(hostTriple)
	) {
		throw new Error('targetTriple and hostTriple must be valid Rust target triples');
	}
	const environment = {};
	for (const name of selectedBuildEnvironmentNames(buildEnv, targetTriple, hostTriple)) {
		const value = environmentValue(buildEnv, name);
		if (value === undefined) continue;
		if (typeof value !== 'string') {
			throw new Error(`buildEnv.${name} must be a string when set`);
		}
		environment[name] = value;
	}
	return environment;
}

function buildEnvironmentSha256(buildEnv, targetTriple, hostTriple) {
	const variables = {};
	for (const name of selectedBuildEnvironmentNames(buildEnv, targetTriple, hostTriple)) {
		const value = environmentValue(buildEnv, name);
		if (value !== undefined && typeof value !== 'string') {
			throw new Error(`buildEnv.${name} must be a string when set`);
		}
		variables[name] = value ?? null;
	}
	return sha256(JSON.stringify({ schema_version: 1, variables }));
}

function canonicalEvaluatorRevision(value) {
	return {
		schema_version: value.schema_version,
		protocol_id: value.protocol_id,
		git_commit: value.git_commit,
		cargo_lock_sha256: value.cargo_lock_sha256,
		rustc_vv: value.rustc_vv,
		build_profile: value.build_profile,
		target_triple: value.target_triple,
		cargo_features: [...value.cargo_features],
		build_env_sha256: value.build_env_sha256,
	};
}

/**
 * Validate evaluator provenance already persisted in a benchmark report.
 *
 * This function is pure: it never invokes Git, rustc, or the filesystem.
 */
export function validateEvaluatorRevision(value) {
	const errors = [];
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return ['evaluator_revision must be an object'];
	}

	const allowedFields = new Set(EVALUATOR_REVISION_FIELDS);
	for (const field of Object.keys(value)) {
		if (!allowedFields.has(field)) errors.push(`evaluator_revision.${field} is not allowed`);
	}
	for (const field of EVALUATOR_REVISION_FIELDS) {
		if (!Object.hasOwn(value, field)) errors.push(`evaluator_revision.${field} is required`);
	}

	if (value.schema_version !== 1) {
		errors.push('evaluator_revision.schema_version must be 1');
	}
	if (value.protocol_id !== EVALUATOR_REVISION_PROTOCOL_ID) {
		errors.push(`evaluator_revision.protocol_id must be '${EVALUATOR_REVISION_PROTOCOL_ID}'`);
	}
	if (!GIT_COMMIT_PATTERN.test(value.git_commit ?? '')) {
		errors.push('evaluator_revision.git_commit must be a lowercase 40-character Git commit');
	}
	for (const field of ['cargo_lock_sha256', 'build_env_sha256']) {
		if (!SHA256_PATTERN.test(value[field] ?? '')) {
			errors.push(`evaluator_revision.${field} must be a lowercase SHA-256 digest`);
		}
	}
	errors.push(...validateRustcVersion(value.rustc_vv, 'evaluator_revision.rustc_vv'));
	if (value.build_profile !== 'release') {
		errors.push("evaluator_revision.build_profile must be 'release'");
	}
	if (typeof value.target_triple !== 'string' || !TARGET_TRIPLE_PATTERN.test(value.target_triple)) {
		errors.push('evaluator_revision.target_triple must be a valid Rust target triple');
	}
	try {
		const normalized = normalizeCargoFeatures(value.cargo_features);
		if (
			normalized.length !== value.cargo_features.length ||
			normalized.some((feature, index) => feature !== value.cargo_features[index])
		) {
			errors.push('evaluator_revision.cargo_features must be sorted and unique');
		}
	} catch {
		errors.push('evaluator_revision.cargo_features must contain valid Cargo feature names');
	}
	return errors;
}

/**
 * Canonically fingerprint persisted evaluator provenance.
 */
export function evaluatorRevisionSha256(value) {
	const errors = validateEvaluatorRevision(value);
	if (errors.length > 0) {
		throw new Error(`invalid evaluator revision:\n- ${errors.join('\n- ')}`);
	}
	return sha256(JSON.stringify(canonicalEvaluatorRevision(value)));
}

function sameFileSnapshot(left, right) {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function sha256RegularFile(filePath, label) {
	let descriptor;
	try {
		const pathBefore = fs.lstatSync(filePath, { bigint: true });
		if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
			throw new Error(`${label} must be a regular file`);
		}
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
		if (!descriptorBefore.isFile() || !sameFileSnapshot(pathBefore, descriptorBefore)) {
			throw new Error(`${label} changed while it was being opened`);
		}

		const hash = createHash('sha256');
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		for (;;) {
			const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}

		const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
		const pathAfter = fs.lstatSync(filePath, { bigint: true });
		if (
			!descriptorAfter.isFile() ||
			!pathAfter.isFile() ||
			!sameFileSnapshot(descriptorBefore, descriptorAfter) ||
			!sameFileSnapshot(descriptorAfter, pathAfter)
		) {
			throw new Error(`${label} changed while it was being hashed`);
		}
		const digest = hash.digest('hex');
		if (!SHA256_PATTERN.test(digest)) throw new Error(`failed to hash ${label}`);
		return digest;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(label)) throw error;
		throw new Error(`unable to read ${label}`);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function commandOutput(executable, args, options, failureMessage) {
	try {
		return execFileSync(executable, args, {
			...options,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch {
		throw new Error(failureMessage);
	}
}

function strictCommandEnvironment(buildEnv, names, fixed = {}) {
	if (buildEnv === null || typeof buildEnv !== 'object' || Array.isArray(buildEnv)) {
		throw new Error('buildEnv must be an environment map');
	}
	// Never inherit process.env here. Every copied value is covered by
	// build_env_sha256; fixed values are part of this evaluator protocol.
	const environment = {};
	for (const name of names) {
		const value = environmentValue(buildEnv, name);
		if (value === undefined) continue;
		if (typeof value !== 'string') {
			throw new Error(`buildEnv.${name} must be a string when set`);
		}
		environment[name] = value;
	}
	return { ...environment, ...fixed };
}

function gitCommandEnvironment(buildEnv) {
	// Repository, worktree, index, config-injection, object-store, and dynamic
	// loader overrides are intentionally absent.
	return strictCommandEnvironment(buildEnv, COMMAND_DISCOVERY_ENVIRONMENT_NAMES, {
		GIT_ATTR_NOSYSTEM: '1',
		GIT_CONFIG_COUNT: '0',
		GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		LANG: 'C',
		LC_ALL: 'C',
	});
}

function rustcCommandEnvironment(buildEnv) {
	// Cargo-only inputs such as RUSTC_WRAPPER and RUSTFLAGS remain attested as
	// build inputs, but cannot interpose on the compiler identity probe.
	return strictCommandEnvironment(buildEnv, RUSTC_PROBE_ENVIRONMENT_NAMES, {
		LANG: 'C',
		LC_ALL: 'C',
	});
}

function gitOutput(gitExecutable, repositoryRoot, environment, args, failureMessage) {
	return commandOutput(
		gitExecutable,
		[
			'--no-replace-objects',
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.untrackedCache=false',
			'-C',
			repositoryRoot,
			...args,
		],
		{
			env: environment,
		},
		failureMessage,
	);
}

function requireCleanWorktree(gitExecutable, repositoryRoot, environment) {
	const status = gitOutput(
		gitExecutable,
		repositoryRoot,
		environment,
		['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
		'unable to inspect evaluator Git worktree state',
	);
	if (status.length !== 0) {
		throw new Error(
			'evaluator revision requires a clean Git worktree; tracked, staged, or non-ignored untracked changes were detected',
		);
	}
}

function resolveGitState(repositoryRoot, gitExecutable, environment) {
	let canonicalRoot;
	try {
		const stat = fs.statSync(repositoryRoot);
		if (!stat.isDirectory()) throw new Error();
		canonicalRoot = fs.realpathSync(repositoryRoot);
	} catch {
		throw new Error('repositoryRoot must be a readable directory');
	}

	const topLevel = gitOutput(
		gitExecutable,
		canonicalRoot,
		environment,
		['rev-parse', '--show-toplevel'],
		'repositoryRoot is not a Git worktree',
	).trim();
	let canonicalTopLevel;
	try {
		canonicalTopLevel = fs.realpathSync(topLevel);
	} catch {
		throw new Error('Git returned an unreadable worktree root');
	}
	if (canonicalTopLevel !== canonicalRoot) {
		throw new Error('repositoryRoot must be the Git worktree root');
	}

	const gitCommit = gitOutput(
		gitExecutable,
		canonicalRoot,
		environment,
		['rev-parse', '--verify', 'HEAD^{commit}'],
		'unable to resolve evaluator Git HEAD commit',
	).trim();
	if (!GIT_COMMIT_PATTERN.test(gitCommit)) {
		throw new Error('evaluator Git HEAD must be a 40-character lowercase commit hash');
	}
	return { canonicalRoot, gitCommit };
}

function requireTrackedCargoLock(gitExecutable, repositoryRoot, environment) {
	gitOutput(
		gitExecutable,
		repositoryRoot,
		environment,
		['ls-files', '--error-unmatch', '--', 'Cargo.lock'],
		'evaluator requires a tracked Cargo.lock at the repository root',
	);
}

function rustcVersion(repositoryRoot, buildEnv, rustcExecutable) {
	const executable = rustcExecutable ?? environmentValue(buildEnv, 'RUSTC') ?? 'rustc';
	if (typeof executable !== 'string' || executable.length === 0) {
		throw new Error('rustcExecutable must be a non-empty string');
	}
	const output = commandOutput(
		executable,
		['-vV'],
		{ cwd: repositoryRoot, env: rustcCommandEnvironment(buildEnv) },
		'unable to execute rustc -vV for evaluator provenance',
	);
	return normalizeRustcVersion(output);
}

/**
 * Describe the exact clean evaluator source/toolchain inputs used by a real run.
 *
 * The returned revision contains only public identifiers and one-way digests.
 * It deliberately refuses dirty trees so private corpus-adjacent files or
 * source changes cannot be accidentally represented by an incomplete revision.
 */
export function evaluatorRevision(repositoryRoot, options = {}) {
	const {
		buildEnv = process.env,
		cargoFeatures = [],
		gitExecutable = 'git',
		rustcExecutable,
		targetTriple,
	} = options;
	if (typeof gitExecutable !== 'string' || gitExecutable.length === 0) {
		throw new Error('gitExecutable must be a non-empty string');
	}

	const gitEnvironment = gitCommandEnvironment(buildEnv);
	const { canonicalRoot, gitCommit } = resolveGitState(
		repositoryRoot,
		gitExecutable,
		gitEnvironment,
	);
	requireCleanWorktree(gitExecutable, canonicalRoot, gitEnvironment);
	requireTrackedCargoLock(gitExecutable, canonicalRoot, gitEnvironment);

	const cargoLockPath = path.join(canonicalRoot, 'Cargo.lock');
	const cargoLockSha256 = sha256RegularFile(cargoLockPath, 'Cargo.lock');
	const normalizedFeatures = normalizeCargoFeatures(cargoFeatures);
	const { rustcVv, hostTriple } = rustcVersion(canonicalRoot, buildEnv, rustcExecutable);
	const selectedTarget =
		targetTriple ?? environmentValue(buildEnv, 'CARGO_BUILD_TARGET') ?? hostTriple;
	if (typeof selectedTarget !== 'string' || !TARGET_TRIPLE_PATTERN.test(selectedTarget)) {
		throw new Error('targetTriple must be a valid Rust target triple');
	}
	const buildEnvSha256 = buildEnvironmentSha256(buildEnv, selectedTarget, hostTriple);

	requireCleanWorktree(gitExecutable, canonicalRoot, gitEnvironment);
	const finalCommit = gitOutput(
		gitExecutable,
		canonicalRoot,
		gitEnvironment,
		['rev-parse', '--verify', 'HEAD^{commit}'],
		'unable to recheck evaluator Git HEAD commit',
	).trim();
	if (finalCommit !== gitCommit) {
		throw new Error('evaluator Git HEAD changed while provenance was being collected');
	}
	if (sha256RegularFile(cargoLockPath, 'Cargo.lock') !== cargoLockSha256) {
		throw new Error('Cargo.lock changed while evaluator provenance was being collected');
	}

	const revision = {
		schema_version: 1,
		protocol_id: EVALUATOR_REVISION_PROTOCOL_ID,
		git_commit: gitCommit,
		cargo_lock_sha256: cargoLockSha256,
		rustc_vv: rustcVv,
		build_profile: 'release',
		target_triple: selectedTarget,
		cargo_features: normalizedFeatures,
		build_env_sha256: buildEnvSha256,
	};
	return {
		revision,
		sha256: evaluatorRevisionSha256(revision),
	};
}
