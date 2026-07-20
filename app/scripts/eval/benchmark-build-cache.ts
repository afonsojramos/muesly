import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Cohort benchmark build cache. Native builds (whisper.cpp, ggml, ORT relinks)
// are not byte-reproducible across separate Cargo invocations, but the public
// qualification compares suites only when every suite measured with the exact
// same executable bytes. Building once per evaluator revision and reusing the
// attested copy gives every campaign in the hardware cohort identical
// benchmark_executable_sha256 values by construction. The cache lives under
// target/ (machine-local, gitignored) and is keyed by the evaluator revision
// SHA-256, which already binds the Git commit, Cargo.lock, rustc, Cargo
// features, and build environment; any of those changing selects a fresh
// cache entry. Cached bytes are re-hashed on every read, so a truncated or
// tampered entry is rebuilt instead of trusted. The full staged-snapshot
// attestation in prepareRealRunSession still runs on whatever this returns.

export const COHORT_BENCHMARK_CACHE_DIRECTORY = 'eval-benchmark-executables';

function executableName(platform = process.platform) {
	return platform === 'win32' ? 'transcribe-fixture.exe' : 'transcribe-fixture';
}

function readRecordedDigest(digestPath) {
	const entry = fs.lstatSync(digestPath, { throwIfNoEntry: false });
	if (!entry?.isFile() || entry.isSymbolicLink()) return null;
	const recorded = fs.readFileSync(digestPath, 'utf8').trim();
	return /^[a-f0-9]{64}$/.test(recorded) ? recorded : null;
}

function readCohortCachedExecutable(cacheDirectory, dependencies) {
	const cachedPath = path.join(cacheDirectory, executableName());
	const entry = fs.lstatSync(cachedPath, { throwIfNoEntry: false });
	if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return null;
	const recorded = readRecordedDigest(`${cachedPath}.sha256`);
	if (recorded === null) return null;
	let actual;
	try {
		actual = dependencies.benchmarkExecutableSha256(cachedPath);
	} catch {
		return null;
	}
	return actual === recorded ? cachedPath : null;
}

function publishCohortCachedExecutable(sourcePath, cacheDirectory, digest, dependencies) {
	const parent = path.dirname(cacheDirectory);
	fs.mkdirSync(parent, { recursive: true });
	const stagedDirectory = `${cacheDirectory}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.mkdirSync(stagedDirectory, { mode: 0o700 });
		const stagedPath = path.join(stagedDirectory, executableName());
		fs.copyFileSync(sourcePath, stagedPath);
		fs.chmodSync(stagedPath, 0o700);
		if (dependencies.benchmarkExecutableSha256(stagedPath) !== digest) {
			throw new Error('cohort benchmark executable copy does not match the attested build');
		}
		fs.writeFileSync(`${stagedPath}.sha256`, `${digest}\n`, { mode: 0o600 });
		const existing = fs.lstatSync(cacheDirectory, { throwIfNoEntry: false });
		if (existing === undefined) {
			fs.renameSync(stagedDirectory, cacheDirectory);
			return;
		}
		// Replacing an invalid entry: rename cannot overwrite a non-empty
		// directory, so move the old one aside first, then restore it if the
		// replacement cannot be published. Campaigns in a cohort are serialized
		// by the corpus lock, so no concurrent writer can observe the gap.
		const replacedDirectory = `${cacheDirectory}.replaced-${process.pid}-${randomUUID()}`;
		fs.renameSync(cacheDirectory, replacedDirectory);
		try {
			fs.renameSync(stagedDirectory, cacheDirectory);
		} catch (error) {
			try {
				fs.renameSync(replacedDirectory, cacheDirectory);
			} catch {
				// The original entry is preserved at replacedDirectory.
			}
			throw error;
		}
		fs.rmSync(replacedDirectory, { recursive: true, force: true });
	} finally {
		fs.rmSync(stagedDirectory, { recursive: true, force: true });
	}
}

export function createCohortBenchmarkBuild(options) {
	if (typeof options?.buildBenchmarkExecutable !== 'function') {
		throw new Error('cohort benchmark build requires a buildBenchmarkExecutable dependency');
	}
	if (typeof options?.benchmarkExecutableSha256 !== 'function') {
		throw new Error('cohort benchmark build requires a benchmarkExecutableSha256 dependency');
	}
	if (typeof options?.cargoFeaturesForBenchmark !== 'function') {
		throw new Error('cohort benchmark build requires a cargoFeaturesForBenchmark dependency');
	}
	if (!/^[a-f0-9]{64}$/.test(options?.revisionSha256 ?? '')) {
		throw new Error('cohort benchmark build requires an evaluator revision SHA-256');
	}
	const dependencies = {
		buildBenchmarkExecutable: options.buildBenchmarkExecutable,
		benchmarkExecutableSha256: options.benchmarkExecutableSha256,
		cargoFeaturesForBenchmark: options.cargoFeaturesForBenchmark,
	};
	const cacheDirectory = path.join(
		path.resolve(options.repoRoot),
		'target',
		COHORT_BENCHMARK_CACHE_DIRECTORY,
		options.revisionSha256,
	);
	return (repoRoot, buildOptions = {}) => {
		const cargoFeatures = dependencies.cargoFeaturesForBenchmark(
			buildOptions.provider,
			buildOptions.backend,
		);
		const cached = readCohortCachedExecutable(cacheDirectory, dependencies);
		if (cached !== null) {
			return { cargoFeatures, executablePath: cached };
		}
		const built = dependencies.buildBenchmarkExecutable(repoRoot, buildOptions);
		const digest = dependencies.benchmarkExecutableSha256(built.executablePath);
		publishCohortCachedExecutable(built.executablePath, cacheDirectory, digest, dependencies);
		const published = readCohortCachedExecutable(cacheDirectory, dependencies);
		if (published === null) {
			throw new Error('cohort benchmark executable cache could not be verified after publishing');
		}
		return { cargoFeatures: built.cargoFeatures, executablePath: published };
	};
}
