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
	'BINDGEN_EXTRA_CLANG_ARGS',
	'CARGO_BUILD_RUSTFLAGS',
	'CARGO_BUILD_TARGET',
	'CARGO_ENCODED_RUSTFLAGS',
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
	'CC',
	'CFLAGS',
	'CMAKE_CUDA_ARCHITECTURES',
	'CMAKE_OSX_DEPLOYMENT_TARGET',
	'CPPFLAGS',
	'CUDACXX',
	'CUDAARCHS',
	'CUDA_HOME',
	'CUDA_PATH',
	'CXX',
	'CXXFLAGS',
	'HIP_PATH',
	'IPHONEOS_DEPLOYMENT_TARGET',
	'LDFLAGS',
	'LIBCLANG_PATH',
	'MACOSX_DEPLOYMENT_TARGET',
	'OPENSSL_DIR',
	'OPENSSL_INCLUDE_DIR',
	'OPENSSL_LIB_DIR',
	'OPENSSL_STATIC',
	'PKG_CONFIG_ALL_DYNAMIC',
	'PKG_CONFIG_ALL_STATIC',
	'PKG_CONFIG_ALLOW_CROSS',
	'PKG_CONFIG_LIBDIR',
	'PKG_CONFIG_PATH',
	'PKG_CONFIG_SYSROOT_DIR',
	'POSTHOG_API_KEY',
	'ROCM_PATH',
	'RUSTC',
	'RUSTC_BOOTSTRAP',
	'RUSTC_WRAPPER',
	'RUSTC_WORKSPACE_WRAPPER',
	'RUSTFLAGS',
	'RUSTUP_TOOLCHAIN',
	'SDKROOT',
	'SOURCE_DATE_EPOCH',
	'VCPKG_ROOT',
	'VULKAN_SDK',
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

function buildEnvironmentSha256(buildEnv) {
	if (buildEnv === null || typeof buildEnv !== 'object' || Array.isArray(buildEnv)) {
		throw new Error('buildEnv must be an environment map');
	}
	const variables = {};
	for (const name of EVALUATOR_BUILD_ENV_ALLOWLIST) {
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

function gitOutput(gitExecutable, repositoryRoot, args, failureMessage) {
	return commandOutput(
		gitExecutable,
		[
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.untrackedCache=false',
			'-C',
			repositoryRoot,
			...args,
		],
		{
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: '0',
				LANG: 'C',
				LC_ALL: 'C',
			},
		},
		failureMessage,
	);
}

function requireCleanWorktree(gitExecutable, repositoryRoot) {
	const status = gitOutput(
		gitExecutable,
		repositoryRoot,
		['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
		'unable to inspect evaluator Git worktree state',
	);
	if (status.length !== 0) {
		throw new Error(
			'evaluator revision requires a clean Git worktree; tracked, staged, or non-ignored untracked changes were detected',
		);
	}
}

function resolveGitState(repositoryRoot, gitExecutable) {
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
		['rev-parse', '--verify', 'HEAD^{commit}'],
		'unable to resolve evaluator Git HEAD commit',
	).trim();
	if (!GIT_COMMIT_PATTERN.test(gitCommit)) {
		throw new Error('evaluator Git HEAD must be a 40-character lowercase commit hash');
	}
	return { canonicalRoot, gitCommit };
}

function requireTrackedCargoLock(gitExecutable, repositoryRoot) {
	gitOutput(
		gitExecutable,
		repositoryRoot,
		['ls-files', '--error-unmatch', '--', 'Cargo.lock'],
		'evaluator requires a tracked Cargo.lock at the repository root',
	);
}

function rustcVersion(repositoryRoot, buildEnv, rustcExecutable) {
	const executable = rustcExecutable ?? environmentValue(buildEnv, 'RUSTC') ?? 'rustc';
	if (typeof executable !== 'string' || executable.length === 0) {
		throw new Error('rustcExecutable must be a non-empty string');
	}
	const commandEnvironment = { ...process.env };
	for (const name of EVALUATOR_BUILD_ENV_ALLOWLIST) {
		const value = environmentValue(buildEnv, name);
		if (value === undefined) {
			delete commandEnvironment[name];
		} else {
			commandEnvironment[name] = value;
		}
	}
	const output = commandOutput(
		executable,
		['-vV'],
		{ cwd: repositoryRoot, env: commandEnvironment },
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

	const { canonicalRoot, gitCommit } = resolveGitState(repositoryRoot, gitExecutable);
	requireCleanWorktree(gitExecutable, canonicalRoot);
	requireTrackedCargoLock(gitExecutable, canonicalRoot);

	const cargoLockPath = path.join(canonicalRoot, 'Cargo.lock');
	const cargoLockSha256 = sha256RegularFile(cargoLockPath, 'Cargo.lock');
	const normalizedFeatures = normalizeCargoFeatures(cargoFeatures);
	const buildEnvSha256 = buildEnvironmentSha256(buildEnv);
	const { rustcVv, hostTriple } = rustcVersion(canonicalRoot, buildEnv, rustcExecutable);
	const selectedTarget =
		targetTriple ?? environmentValue(buildEnv, 'CARGO_BUILD_TARGET') ?? hostTriple;
	if (typeof selectedTarget !== 'string' || !TARGET_TRIPLE_PATTERN.test(selectedTarget)) {
		throw new Error('targetTriple must be a valid Rust target triple');
	}

	requireCleanWorktree(gitExecutable, canonicalRoot);
	const finalCommit = gitOutput(
		gitExecutable,
		canonicalRoot,
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
