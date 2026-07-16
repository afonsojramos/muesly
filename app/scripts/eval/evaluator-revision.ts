import { execFileSync, spawnSync } from 'node:child_process';
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
	'CARGO',
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
const RUSTC_WRAPPER_ENVIRONMENT_NAMES = Object.freeze(['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']);
export const BENCHMARK_RUSTC_WRAPPER_ERROR =
	'measured benchmark builds require RUSTC_WRAPPER and RUSTC_WORKSPACE_WRAPPER to be unset or empty';
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

export function assertBenchmarkRustcWrappersDisabled(
	buildEnv,
	{ platform = process.platform } = {},
) {
	if (buildEnv === null || typeof buildEnv !== 'object' || Array.isArray(buildEnv)) {
		throw new Error('buildEnv must be an environment map');
	}
	for (const name of RUSTC_WRAPPER_ENVIRONMENT_NAMES) {
		const value = commandEnvironmentValue(buildEnv, name, { platform });
		if (value === undefined) continue;
		if (typeof value !== 'string') {
			throw new Error(`buildEnv.${name} must be a string when set`);
		}
		if (value.length > 0) throw new Error(BENCHMARK_RUSTC_WRAPPER_ERROR);
	}
}

export function evaluatorBuildEnvironment(buildEnv, targetTriple, hostTriple) {
	assertBenchmarkRustcWrappersDisabled(buildEnv);
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
	return sanitizeAttestedCommandEnvironment(environment);
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
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function frozenFileSnapshot(status) {
	return Object.freeze({
		dev: status.dev,
		ino: status.ino,
		mode: status.mode,
		nlink: status.nlink,
		size: status.size,
		mtimeNs: status.mtimeNs,
		ctimeNs: status.ctimeNs,
	});
}

function attestRegularFile(filePath, label, { requireExecutable = false } = {}) {
	let descriptor;
	try {
		const pathBefore = fs.lstatSync(filePath, { bigint: true });
		if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
			throw new Error(`${label} must be a regular file`);
		}
		if (requireExecutable) fs.accessSync(filePath, fs.constants.X_OK);
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
			pathAfter.isSymbolicLink() ||
			!sameFileSnapshot(descriptorBefore, descriptorAfter) ||
			!sameFileSnapshot(descriptorAfter, pathAfter)
		) {
			throw new Error(`${label} changed while it was being hashed`);
		}
		if (requireExecutable) fs.accessSync(filePath, fs.constants.X_OK);
		const digest = hash.digest('hex');
		if (!SHA256_PATTERN.test(digest)) throw new Error(`failed to hash ${label}`);
		return Object.freeze({
			sha256: digest,
			snapshot: frozenFileSnapshot(descriptorAfter),
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(label)) throw error;
		throw new Error(`unable to read ${label}`);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function sha256RegularFile(filePath, label) {
	return attestRegularFile(filePath, label).sha256;
}

function commandChangedError(command) {
	return new Error(`${command.label} changed while it was being executed`);
}

export function assertAttestedCommand(command) {
	if (
		command === null ||
		typeof command !== 'object' ||
		typeof command.argv0 !== 'string' ||
		typeof command.executablePath !== 'string' ||
		typeof command.label !== 'string' ||
		typeof command.sha256 !== 'string' ||
		command.snapshot === null ||
		typeof command.snapshot !== 'object' ||
		command.argv0Snapshot === null ||
		typeof command.argv0Snapshot !== 'object'
	) {
		throw new Error('attested command identity is invalid');
	}
	try {
		const argv0Before = fs.lstatSync(command.argv0, { bigint: true });
		const canonicalPath = fs.realpathSync(command.argv0);
		const argv0After = fs.lstatSync(command.argv0, { bigint: true });
		if (
			canonicalPath !== command.executablePath ||
			!sameFileSnapshot(command.argv0Snapshot, argv0Before) ||
			!sameFileSnapshot(argv0Before, argv0After)
		) {
			throw commandChangedError(command);
		}
		const current = attestRegularFile(command.executablePath, command.label, {
			requireExecutable: true,
		});
		if (
			current.sha256 !== command.sha256 ||
			!sameFileSnapshot(current.snapshot, command.snapshot)
		) {
			throw commandChangedError(command);
		}
		return command;
	} catch (error) {
		if (error instanceof Error && error.message === commandChangedError(command).message) {
			throw error;
		}
		throw commandChangedError(command);
	}
}

function invokeAttestedCommand(command, invoke) {
	assertAttestedCommand(command);
	let result;
	let invocationError;
	try {
		result = invoke();
	} catch (error) {
		invocationError = error;
	}
	assertAttestedCommand(command);
	if (invocationError !== undefined) throw invocationError;
	return result;
}

export function execAttestedCommandSync(
	command,
	args,
	options,
	{ execFileSyncImpl = execFileSync } = {},
) {
	return invokeAttestedCommand(command, () =>
		execFileSyncImpl(command.executablePath, args, {
			...options,
			argv0: command.argv0,
		}),
	);
}

export function spawnAttestedCommandSync(
	command,
	args,
	options,
	{ spawnSyncImpl = spawnSync } = {},
) {
	return invokeAttestedCommand(command, () =>
		spawnSyncImpl(command.executablePath, args, {
			...options,
			argv0: command.argv0,
		}),
	);
}

function commandOutput(command, args, options, failureMessage) {
	try {
		return execAttestedCommandSync(command, args, {
			...options,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		if (error instanceof Error && error.message === commandChangedError(command).message) {
			throw error;
		}
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
	return sanitizeAttestedCommandEnvironment({ ...environment, ...fixed });
}

function commandPathApi(platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

function commandPathDelimiter(platform) {
	return platform === 'win32' ? ';' : ':';
}

function commandEnvironmentValue(environment, name, { platform = process.platform } = {}) {
	if (platform !== 'win32') return environmentValue(environment, name);
	const keys = Object.keys(environment)
		.filter((candidate) => candidate.toUpperCase() === name.toUpperCase())
		.sort();
	if (keys.length === 0) return undefined;
	const values = new Set(keys.map((key) => environment[key]));
	if (values.size !== 1) {
		throw new Error(`attested command environment has conflicting ${name} entries`);
	}
	return environment[keys[0]];
}

function fullyQualifiedAbsolutePath(value, platform = process.platform) {
	const pathApi = commandPathApi(platform);
	if (!pathApi.isAbsolute(value)) return false;
	if (platform !== 'win32') return true;
	return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)/.test(value);
}

function unquoteSearchPathEntry(value, label) {
	const startsQuoted = value.startsWith('"');
	const endsQuoted = value.endsWith('"');
	if (startsQuoted !== endsQuoted || (!startsQuoted && value.includes('"'))) {
		throw new Error(`attested command environment has malformed ${label}`);
	}
	const unquoted = startsQuoted ? value.slice(1, -1) : value;
	if (unquoted.includes('"')) {
		throw new Error(`attested command environment has malformed ${label}`);
	}
	return unquoted;
}

function absoluteCommandSearchDirectories(environment, { platform = process.platform } = {}) {
	const searchPath = commandEnvironmentValue(environment, 'PATH', { platform });
	if (typeof searchPath !== 'string') return [];
	const delimiter = commandPathDelimiter(platform);
	return searchPath
		.split(delimiter)
		.map((entry) => unquoteSearchPathEntry(entry, 'PATH entry'))
		.filter((entry) => fullyQualifiedAbsolutePath(entry, platform));
}

export function sanitizeAttestedCommandEnvironment(
	environment,
	{ platform = process.platform } = {},
) {
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
		throw new Error('command environment must be an environment map');
	}
	const sanitized = { ...environment };
	const searchPath = commandEnvironmentValue(environment, 'PATH', { platform });
	if (searchPath !== undefined) {
		if (typeof searchPath !== 'string') {
			throw new Error('attested command environment PATH must be a string');
		}
		const directories = absoluteCommandSearchDirectories(environment, { platform });
		if (directories.length === 0) {
			throw new Error('attested command environment has no absolute PATH entries');
		}
		if (platform === 'win32') {
			for (const key of Object.keys(sanitized)) {
				if (key.toUpperCase() === 'PATH') delete sanitized[key];
			}
		}
		sanitized.PATH = directories.join(commandPathDelimiter(platform));
	}
	if (platform === 'win32') {
		const pathExt = commandEnvironmentValue(environment, 'PATHEXT', { platform });
		if (pathExt !== undefined && typeof pathExt !== 'string') {
			throw new Error('attested command environment PATHEXT must be a string');
		}
	}
	return sanitized;
}

function windowsExecutableSuffixes(executable, environment, { platform = process.platform } = {}) {
	const extension = path.win32.extname(executable).toUpperCase();
	if (extension.length > 0) return extension === '.EXE' || extension === '.COM' ? [''] : [];
	const pathExt = commandEnvironmentValue(environment, 'PATHEXT', { platform });
	if (typeof pathExt !== 'string') return [];
	const suffixes = [];
	const seen = new Set();
	for (const rawSuffix of pathExt.split(commandPathDelimiter(platform))) {
		const suffix = rawSuffix.trim();
		const identity = suffix.toUpperCase();
		if (identity !== '.EXE' && identity !== '.COM') continue;
		if (seen.has(identity)) continue;
		seen.add(identity);
		suffixes.push(suffix);
	}
	return suffixes;
}

export function attestedCommandCandidates(
	executable,
	environment,
	{ platform = process.platform } = {},
) {
	if (
		typeof executable !== 'string' ||
		executable.length === 0 ||
		executable.includes('\0') ||
		environment === null ||
		typeof environment !== 'object' ||
		Array.isArray(environment)
	) {
		throw new Error('invalid attested command lookup');
	}
	const pathApi = commandPathApi(platform);
	const hasPathSeparator =
		platform === 'win32' ? /[\\/]/.test(executable) : executable.includes('/');
	let baseCandidates;
	if (fullyQualifiedAbsolutePath(executable, platform)) {
		baseCandidates = [executable];
	} else {
		if (hasPathSeparator) throw new Error('attested command lookup contains a relative path');
		baseCandidates = absoluteCommandSearchDirectories(environment, { platform }).map((directory) =>
			pathApi.join(directory, executable),
		);
	}
	const suffixes =
		platform === 'win32' ? windowsExecutableSuffixes(executable, environment, { platform }) : [''];
	return baseCandidates.flatMap((baseCandidate) =>
		suffixes.map((suffix) => `${baseCandidate}${suffix}`),
	);
}

/**
 * Resolve a command without consulting the parent or child current directory.
 *
 * Only absolute entries from the attested PATH are searched. The returned
 * executablePath is canonical and absolute; argv0 preserves shim dispatch
 * (notably rustup's rustc proxy). Windows' implicit current-directory lookup
 * and POSIX empty/relative PATH entries therefore cannot interpose.
 */
export function resolveAttestedCommand(
	executable,
	environment,
	label = 'command',
	{ platform = process.platform } = {},
) {
	let candidates;
	try {
		candidates = attestedCommandCandidates(executable, environment, { platform });
	} catch {
		throw new Error(`unable to resolve ${label} from the attested command environment`);
	}
	for (const candidate of candidates) {
		let argv0Before;
		let canonicalPath;
		try {
			argv0Before = fs.lstatSync(candidate, { bigint: true });
			if (!argv0Before.isFile() && !argv0Before.isSymbolicLink()) continue;
			canonicalPath = fs.realpathSync(candidate);
			const status = fs.statSync(canonicalPath);
			if (!fullyQualifiedAbsolutePath(canonicalPath, platform) || !status.isFile()) {
				continue;
			}
			fs.accessSync(canonicalPath, fs.constants.X_OK);
		} catch {
			continue;
		}
		try {
			const attestation = attestRegularFile(canonicalPath, label, {
				requireExecutable: true,
			});
			const argv0After = fs.lstatSync(candidate, { bigint: true });
			if (
				!sameFileSnapshot(argv0Before, argv0After) ||
				fs.realpathSync(candidate) !== canonicalPath
			) {
				throw new Error(`${label} changed while it was being resolved`);
			}
			return Object.freeze({
				argv0: candidate,
				argv0Snapshot: frozenFileSnapshot(argv0After),
				executablePath: canonicalPath,
				label,
				sha256: attestation.sha256,
				snapshot: attestation.snapshot,
			});
		} catch {
			throw new Error(`${label} changed while it was being resolved`);
		}
	}
	throw new Error(`unable to resolve ${label} from the attested command environment`);
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
	// Compiler wrappers are rejected before this probe. Cargo-only inputs such
	// as RUSTFLAGS remain attested as build inputs but cannot alter this command.
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
			cwd: repositoryRoot,
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

export function attestedRustcVersion(
	repositoryRoot,
	{ buildEnv = process.env, rustcExecutable } = {},
) {
	assertBenchmarkRustcWrappersDisabled(buildEnv);
	let canonicalRoot;
	try {
		canonicalRoot = fs.realpathSync(repositoryRoot);
		if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error();
	} catch {
		throw new Error('repositoryRoot must be a readable directory');
	}
	const executable = rustcExecutable ?? environmentValue(buildEnv, 'RUSTC') ?? 'rustc';
	if (typeof executable !== 'string' || executable.length === 0) {
		throw new Error('rustcExecutable must be a non-empty string');
	}
	const commandEnvironment = rustcCommandEnvironment(buildEnv);
	const resolvedExecutable = resolveAttestedCommand(
		executable,
		commandEnvironment,
		'rustc executable',
	);
	const output = commandOutput(
		resolvedExecutable,
		['-vV'],
		{ cwd: canonicalRoot, env: commandEnvironment },
		'unable to execute rustc -vV for evaluator provenance',
	);
	return Object.freeze({
		...normalizeRustcVersion(output),
		command: resolvedExecutable,
		environment: Object.freeze({ ...commandEnvironment }),
	});
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
	assertBenchmarkRustcWrappersDisabled(buildEnv);

	const gitEnvironment = gitCommandEnvironment(buildEnv);
	const resolvedGitExecutable = resolveAttestedCommand(
		gitExecutable,
		gitEnvironment,
		'Git executable',
	);
	const { canonicalRoot, gitCommit } = resolveGitState(
		repositoryRoot,
		resolvedGitExecutable,
		gitEnvironment,
	);
	requireCleanWorktree(resolvedGitExecutable, canonicalRoot, gitEnvironment);
	requireTrackedCargoLock(resolvedGitExecutable, canonicalRoot, gitEnvironment);

	const cargoLockPath = path.join(canonicalRoot, 'Cargo.lock');
	const cargoLockSha256 = sha256RegularFile(cargoLockPath, 'Cargo.lock');
	const normalizedFeatures = normalizeCargoFeatures(cargoFeatures);
	const { rustcVv, hostTriple } = attestedRustcVersion(canonicalRoot, {
		buildEnv,
		rustcExecutable,
	});
	const selectedTarget =
		targetTriple ?? environmentValue(buildEnv, 'CARGO_BUILD_TARGET') ?? hostTriple;
	if (typeof selectedTarget !== 'string' || !TARGET_TRIPLE_PATTERN.test(selectedTarget)) {
		throw new Error('targetTriple must be a valid Rust target triple');
	}
	const buildEnvSha256 = buildEnvironmentSha256(buildEnv, selectedTarget, hostTriple);

	requireCleanWorktree(resolvedGitExecutable, canonicalRoot, gitEnvironment);
	const finalCommit = gitOutput(
		resolvedGitExecutable,
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
