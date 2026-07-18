#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { forcesWhisperCpu, requiresWhisperGpu } from "./backend.ts";
import {
  benchmarkDefinitionForReportedBackend,
  benchmarkExecutableSha256,
  benchmarkRuntimeEnvironment,
  bindBenchmarkRuntimeDependencies,
  buildBenchmarkExecutable,
  prepareBenchmarkModel,
  probeBenchmarkExecutable,
  stageBenchmarkExecutableSnapshot,
} from "./benchmark-executable.ts";
import { createPrivateArtifactSnapshotDirectory } from "./artifact-snapshot.ts";
import {
  discoverCorpusBenchmarkCheckpoints,
  readCorpusBenchmarkCheckpoint,
} from "./corpus-benchmark-checkpoints.ts";
import { acquireCorpusBenchmarkLock, releaseCorpusBenchmarkLock } from "./corpus-benchmark-lock.ts";
import { acquireLocalCorpusLock, releaseLocalCorpusLock } from "./corpus-intake.ts";
import { parseCorpusBenchmarkArgs } from "./corpus-benchmark-options.ts";
import {
  assertTaskCheckpoint,
  planCorpusBenchmarkTasks,
  reportIdentityFromCheckpoint,
  taskReportFilename,
  validateTaskCheckpoint,
} from "./corpus-benchmark-plan.ts";
import {
  assertLeasedCorpusSampleUnchanged,
  createCorpusResultLease,
  writeLeasedCorpusBoundJson,
} from "./corpus-result.ts";
import { canonicalFilePath, canonicalManifestPath, loadCorpus } from "./corpus.ts";
import { evaluateCoverage, validateCoverageTargets } from "./coverage.ts";
import {
  attestedRustcVersion,
  evaluatorBuildEnvironment,
  evaluatorRevision,
} from "./evaluator-revision.ts";
import {
  modelArtifactSha256,
  primaryModelArtifactSha256,
  resolveModelsDirectory,
} from "./model-artifact.ts";
import { processIdentity } from "./process-identity.ts";
import { prepareRealRunSession } from "./real-run-session.ts";
import { CAMPAIGN_RUN_REPORT_SCHEMA_VERSION } from "./report.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const defaultManifest = path.join(here, "corpus-local.json");
const defaultTargets = path.join(here, "corpus-targets.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_CHILD_OUTPUT_BYTES = 32 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;
const FORCE_KILL_CONFIRMATION_MS = 5_000;
const PROCESS_TREE_POLL_INTERVAL_MS = 25;
const OPTION_FIELDS = new Set([
  "manifestPath",
  "targetsPath",
  "modelsDir",
  "maxWerPct",
  "maxHallucinatedWords",
  "selectedVariants",
  "accelerators",
  "run",
  "requireComplete",
]);
const DEPENDENCY_FIELDS = new Set([
  "acquireLock",
  "releaseLock",
  "currentProcessIdentity",
  "loadCorpus",
  "loadTargets",
  "collectEvaluatorContext",
  "createResultLease",
  "assertSampleUnchanged",
  "prepareSession",
  "discoverCheckpoints",
  "runTask",
  "writeCheckpoint",
  "onProgress",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateOptions(options) {
  if (!isObject(options)) throw new Error("campaign options must be an object");
  for (const field of Object.keys(options)) {
    if (!OPTION_FIELDS.has(field)) throw new Error(`unknown campaign option field: ${field}`);
  }
  requiredString(options.manifestPath, "manifestPath");
  requiredString(options.targetsPath, "targetsPath");
  if (
    options.modelsDir !== null &&
    (typeof options.modelsDir !== "string" || options.modelsDir.trim().length === 0)
  ) {
    throw new Error("modelsDir must be null or a string");
  }
  if (
    typeof options.maxWerPct !== "number" ||
    !Number.isFinite(options.maxWerPct) ||
    options.maxWerPct < 0
  ) {
    throw new Error("maxWerPct must be a non-negative finite number");
  }
  if (!Number.isInteger(options.maxHallucinatedWords) || options.maxHallucinatedWords < 0) {
    throw new Error("maxHallucinatedWords must be a non-negative integer");
  }
  if (!Array.isArray(options.selectedVariants)) {
    throw new Error("selectedVariants must be an array");
  }
  if (!isObject(options.accelerators)) throw new Error("accelerators must be an object");
  if (typeof options.run !== "boolean" || typeof options.requireComplete !== "boolean") {
    throw new Error("run and requireComplete must be booleans");
  }
  if (options.requireComplete && options.selectedVariants.length > 0) {
    throw new Error("--require-complete cannot be combined with --variant");
  }
  return options;
}

function validateDependencies(dependencies) {
  if (!isObject(dependencies)) throw new Error("campaign dependencies must be an object");
  for (const field of Object.keys(dependencies)) {
    if (!DEPENDENCY_FIELDS.has(field)) {
      throw new Error(`unknown campaign dependency: ${field}`);
    }
  }
}

function readCanonicalJsonFile(filePath, label) {
  const requestedPath = path.resolve(filePath);
  let canonicalPath;
  let initial;
  let descriptor;
  try {
    canonicalPath = canonicalFilePath(requestedPath);
    initial = fs.lstatSync(canonicalPath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) {
      throw new Error();
    }
    descriptor = fs.openSync(canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileSnapshot(initial, opened)) {
      throw new Error();
    }
    const contents = fs.readFileSync(descriptor);
    const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(canonicalPath, { bigint: true });
    if (
      !finalDescriptor.isFile() ||
      finalDescriptor.nlink !== 1n ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalPath.nlink !== 1n ||
      !sameFileSnapshot(opened, finalDescriptor) ||
      !sameFileSnapshot(finalDescriptor, finalPath) ||
      BigInt(contents.length) !== finalDescriptor.size
    ) {
      throw new Error();
    }
    let document;
    try {
      document = JSON.parse(UTF8_DECODER.decode(contents));
    } catch {
      throw new Error(`${label} is not valid UTF-8 JSON: ${requestedPath}`);
    }
    return {
      document,
      path: canonicalPath,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} must be a readable regular single-link file: ${requestedPath}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function loadCorpusBenchmarkTargets(targetsPath) {
  const loaded = readCanonicalJsonFile(targetsPath, "coverage targets");
  const errors = validateCoverageTargets(loaded.document);
  if (errors.length > 0) {
    throw new Error(`invalid coverage targets:\n- ${errors.join("\n- ")}`);
  }
  return {
    targets: loaded.document,
    targetsPath: loaded.path,
    targetsSha256: loaded.sha256,
  };
}

function acquireCampaignLock(manifestPath, options = {}) {
  const canonicalManifest = canonicalManifestPath(manifestPath, { allowMissing: true });
  const localCorpusRoot = path.join(path.dirname(canonicalManifest), "local-corpus");
  const localCorpusEntry = fs.lstatSync(localCorpusRoot, { throwIfNoEntry: false });
  if (localCorpusEntry?.isSymbolicLink() || (localCorpusEntry && !localCorpusEntry.isDirectory())) {
    throw new Error(`local corpus root must be a regular directory: ${localCorpusRoot}`);
  }
  fs.mkdirSync(localCorpusRoot, { recursive: true, mode: 0o700 });
  const mutationLockPath = path.join(localCorpusRoot, ".intake.lock");
  const mutationToken = acquireLocalCorpusLock(
    mutationLockPath,
    localCorpusRoot,
    canonicalManifest,
    { operation: "benchmark-start" },
  );
  try {
    return acquireCorpusBenchmarkLock(canonicalManifest, options);
  } finally {
    releaseLocalCorpusLock(mutationLockPath, mutationToken);
  }
}

function selectTargets(targets, selectedVariants) {
  if (selectedVariants.length === 0) return structuredClone(targets);
  const selected = new Set(selectedVariants);
  if (selected.size !== selectedVariants.length) {
    throw new Error("selectedVariants must not contain duplicates");
  }
  const available = new Set(
    targets.benchmark_variants.map(
      (variant) => `${variant.provider}/${variant.model}/${variant.backend}`,
    ),
  );
  for (const variant of selected) {
    if (!available.has(variant)) {
      throw new Error(`selected benchmark variant is not in the coverage targets: ${variant}`);
    }
  }
  return {
    ...structuredClone(targets),
    benchmark_variants: targets.benchmark_variants.filter((variant) =>
      selected.has(`${variant.provider}/${variant.model}/${variant.backend}`),
    ),
  };
}

export function collectEvaluatorContext({ repoRoot, targets }) {
  const hostTriple = attestedRustcVersion(repoRoot, { buildEnv: process.env }).hostTriple;
  const targetTriple = process.env.CARGO_BUILD_TARGET || hostTriple;
  const buildEnvironment = evaluatorBuildEnvironment(process.env, targetTriple, hostTriple);
  const revisions = {};
  for (const variant of targets.benchmark_variants) {
    if (Object.hasOwn(revisions, variant.backend)) continue;
    const definition = benchmarkDefinitionForReportedBackend(variant.provider, variant.backend);
    revisions[definition.reportedBackend] = evaluatorRevision(repoRoot, {
      buildEnv: buildEnvironment,
      cargoFeatures: definition.cargoFeatures,
    });
  }
  return { buildEnvironment, hostTriple, revisions, targetTriple };
}

function ensureSidecarStubs(repoRoot, hostTriple) {
  const binariesDirectory = path.join(repoRoot, "app/src-tauri/binaries");
  fs.mkdirSync(binariesDirectory, { recursive: true });
  for (const binary of ["llama-helper", "diarization-helper"]) {
    const binaryPath = path.join(binariesDirectory, `${binary}-${hostTriple}`);
    if (!fs.existsSync(binaryPath)) fs.writeFileSync(binaryPath, "", { mode: 0o755 });
  }
}

export function inspectVariantIdentity(
  { task, repoRoot, modelsDirectory, evaluatorContext },
  {
    benchmarkExecutableSha256Impl = benchmarkExecutableSha256,
    bindBenchmarkRuntimeDependenciesImpl = bindBenchmarkRuntimeDependencies,
    buildBenchmarkExecutableImpl = buildBenchmarkExecutable,
    createPrivateArtifactSnapshotDirectoryImpl = createPrivateArtifactSnapshotDirectory,
    modelArtifactSha256Impl = modelArtifactSha256,
    primaryModelArtifactSha256Impl = primaryModelArtifactSha256,
    platform = process.platform,
    prepareBenchmarkModelImpl = prepareBenchmarkModel,
    probeBenchmarkExecutableImpl = probeBenchmarkExecutable,
    stageBenchmarkExecutableSnapshotImpl = stageBenchmarkExecutableSnapshot,
  } = {},
) {
  ensureSidecarStubs(repoRoot, evaluatorContext.hostTriple);
  let runtimeEnvironment = benchmarkRuntimeEnvironment(process.env, {
    accelerator: task.accelerator,
    forceWhisperCpu: forcesWhisperCpu(task.provider, task.real_run_backend),
    requireWhisperAcceleration: requiresWhisperGpu(task.provider, task.real_run_backend),
  });
  const built = buildBenchmarkExecutableImpl(repoRoot, {
    provider: task.provider,
    backend: task.real_run_backend,
    buildEnv: evaluatorContext.buildEnvironment,
  });
  const executableSha256 = benchmarkExecutableSha256Impl(built.executablePath);
  const privateSnapshotDirectory = createPrivateArtifactSnapshotDirectoryImpl(
    path.dirname(built.executablePath),
  );
  try {
    const executableSnapshot = stageBenchmarkExecutableSnapshotImpl(
      built.executablePath,
      path.join(privateSnapshotDirectory, "executable"),
      executableSha256,
      { platform },
    );
    if (executableSnapshot.sha256 !== executableSha256) {
      throw new Error("benchmark executable snapshot does not match the built executable");
    }
    runtimeEnvironment = bindBenchmarkRuntimeDependenciesImpl(
      runtimeEnvironment,
      executableSnapshot.runtimeDependenciesSha256,
      executableSnapshot.executablePath,
      { platform },
    );
    const probe = probeBenchmarkExecutableImpl(executableSnapshot.executablePath, {
      provider: task.provider,
      backend: task.real_run_backend,
      environment: runtimeEnvironment,
      platform,
    });
    if (
      probe.backend !== task.target_backend ||
      probe.benchmark_executable_sha256 !== executableSha256
    ) {
      throw new Error("benchmark hardware probe does not match the planned task");
    }
    const preparedModel = prepareBenchmarkModelImpl(executableSnapshot.executablePath, {
      provider: task.provider,
      model: task.model,
      modelsDirectory,
      reportedBackend: probe.backend,
      environment: runtimeEnvironment,
      platform,
    });
    const modelArtifactDigest = modelArtifactSha256Impl(
      task.provider,
      task.model,
      modelsDirectory,
      probe.backend,
    );
    if (
      preparedModel.model_artifact_sha256 !== null &&
      modelArtifactDigest !== preparedModel.model_artifact_sha256
    ) {
      throw new Error(
        "prepared model bytes do not match the canonical artifact digest attested by the evaluator",
      );
    }
    if (preparedModel.primary_model_artifact_sha256 !== null) {
      const primaryDigest = primaryModelArtifactSha256Impl(
        task.provider,
        task.model,
        modelsDirectory,
      );
      if (primaryDigest !== preparedModel.primary_model_artifact_sha256) {
        throw new Error(
          "prepared primary model bytes do not match the canonical digest attested by the evaluator",
        );
      }
    }
    if (
      benchmarkExecutableSha256Impl(built.executablePath) !== executableSha256 ||
      benchmarkExecutableSha256Impl(executableSnapshot.executablePath) !== executableSha256
    ) {
      throw new Error("benchmark executable changed while campaign identity was inspected");
    }
    return {
      model_artifact_sha256: modelArtifactDigest,
      operating_system: probe.operating_system,
      architecture: probe.architecture,
      hardware_profile: probe.hardware_profile,
      accelerator: probe.accelerator,
      benchmark_executable_sha256: executableSha256,
    };
  } finally {
    fs.rmSync(privateSnapshotDirectory, { recursive: true, force: true });
  }
}

function interruptedError(signalName = null) {
  const error = new Error(
    signalName
      ? `benchmark campaign interrupted by ${signalName}`
      : "benchmark campaign interrupted",
  );
  error.code = "MUESLY_BENCHMARK_INTERRUPTED";
  return error;
}

function incompleteError(message) {
  const error = new Error(message);
  error.code = "MUESLY_BENCHMARK_INCOMPLETE";
  return error;
}

function aggregateAfterPrimary(primary, secondary, fallbackMessage) {
  const aggregate = new AggregateError(
    [primary, ...secondary],
    primary instanceof Error ? primary.message : fallbackMessage,
  );
  if (typeof primary?.code === "string") aggregate.code = primary.code;
  return aggregate;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : interruptedError();
}

function windowsTaskkillExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("unable to resolve the Windows taskkill executable");
  }
  const executablePath = path.win32.join(systemRoot, "System32", "taskkill.exe");
  const canonicalPath = fs.realpathSync(executablePath);
  if (!fs.statSync(canonicalPath).isFile()) {
    throw new Error("the Windows taskkill executable is not a regular file");
  }
  return canonicalPath;
}

export function signalBenchmarkProcessTree(
  child,
  signalName,
  {
    environment = process.env,
    execFileSyncImpl = execFileSync,
    platform = process.platform,
    taskkillExecutable,
  } = {},
) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
  if (platform !== "win32") {
    try {
      process.kill(-child.pid, signalName);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  } else {
    try {
      execFileSyncImpl(
        taskkillExecutable ?? windowsTaskkillExecutable(environment),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          env: environment,
          stdio: "ignore",
          timeout: 10_000,
          windowsHide: true,
        },
      );
      return true;
    } catch {
      // A direct-child fallback cannot prove that Windows descendants stopped.
      return false;
    }
  }
  try {
    return child.kill(signalName);
  } catch {
    return false;
  }
}

function posixBenchmarkProcessGroupExists(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function waitForProcessTreePoll(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function terminatePosixBenchmarkProcessTree(child, forceKillDelayMs) {
  signalBenchmarkProcessTree(child, "SIGTERM");
  const forceKillAt = Date.now() + forceKillDelayMs;
  while (posixBenchmarkProcessGroupExists(child)) {
    const remainingMs = forceKillAt - Date.now();
    if (remainingMs <= 0) break;
    await waitForProcessTreePoll(Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remainingMs));
  }
  if (!posixBenchmarkProcessGroupExists(child)) return;

  signalBenchmarkProcessTree(child, "SIGKILL");
  const confirmationDeadline = Date.now() + FORCE_KILL_CONFIRMATION_MS;
  while (posixBenchmarkProcessGroupExists(child)) {
    const remainingMs = confirmationDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("unable to confirm benchmark process-group termination after SIGKILL");
    }
    await waitForProcessTreePoll(Math.min(PROCESS_TREE_POLL_INTERVAL_MS, remainingMs));
  }
}

async function terminateWindowsBenchmarkProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (signalBenchmarkProcessTree(child, "SIGKILL")) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The full-tree failure below remains authoritative.
  }
  throw new Error("unable to terminate the full Windows benchmark process tree");
}

export async function runRealRunCommand(
  args,
  {
    environment = process.env,
    forceKillDelayMs = FORCE_KILL_DELAY_MS,
    repoRoot,
    signal,
    spawnImpl = spawn,
  },
) {
  if (!Number.isSafeInteger(forceKillDelayMs) || forceKillDelayMs < 0) {
    throw new Error("force-kill delay must be a non-negative safe integer");
  }
  throwIfAborted(signal);
  // Nub starts its Node runtime in a separate process group. Launch the exact
  // pinned Node executable directly so this detached child remains the stable
  // group leader for real-run and every benchmark descendant.
  const child = spawnImpl(process.execPath, args, {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let terminationPromise = null;
  let rejectTerminationFailure;
  const terminationFailurePromise = new Promise((_, reject) => {
    rejectTerminationFailure = reject;
  });
  // The race below observes this rejection; this immediate handler also covers
  // an abort delivered synchronously before Promise.race is constructed.
  terminationFailurePromise.catch(() => {});
  const outcomePromise = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("unable to start the real-run benchmark command")));
    child.once("close", (status, terminationSignal) => resolve({ status, terminationSignal }));
  });
  const terminate = () => {
    if (terminationPromise !== null) return;
    terminationPromise =
      process.platform === "win32"
        ? terminateWindowsBenchmarkProcessTree(child)
        : terminatePosixBenchmarkProcessTree(child, forceKillDelayMs);
    terminationPromise.catch(rejectTerminationFailure);
  };
  const countOutput = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_CHILD_OUTPUT_BYTES && !outputLimitExceeded) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  child.stdout.on("data", countOutput);
  child.stderr.on("data", countOutput);

  const abort = () => terminate();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) terminate();
  try {
    const { outcome, outcomeError } = await Promise.race([
      outcomePromise.then(
        (value) => ({ outcome: value, outcomeError: null }),
        (error) => ({ outcome: null, outcomeError: error }),
      ),
      terminationFailurePromise,
    ]);
    if (terminationPromise !== null) await terminationPromise;
    throwIfAborted(signal);
    if (outcomeError !== null) throw outcomeError;
    if (outputLimitExceeded) {
      throw new Error("real-run exceeded the private campaign output limit");
    }
    return outcome;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function defaultPrepareSession({ task, modelsDirectory, repoRoot, evaluatorContext }) {
  ensureSidecarStubs(repoRoot, evaluatorContext.hostTriple);
  return prepareRealRunSession({
    provider: task.provider,
    model: task.model,
    backend: task.real_run_backend,
    accelerator: task.accelerator,
    modelsDirectory,
    repoRoot,
    buildEnvironment: evaluatorContext.buildEnvironment,
    runtimeEnvironment: process.env,
    evaluatorRevision: {
      revision: task.evaluator_revision,
      sha256: task.evaluator_revision_sha256,
    },
  });
}

async function defaultTaskRunner({ task, sample, session, signal }) {
  return session.runSample(
    {
      ...sample,
      corpus_id: task.corpus_id,
      corpus_fingerprint: task.corpus_fingerprint,
      reference_protocol_id: task.reference_protocol_id,
    },
    {
      thresholds: {
        maxWerPercent: task.thresholds.max_wer_percent,
        maxHallucinatedWords: task.thresholds.max_hallucinated_words,
      },
      benchmarkTaskId: task.task_id,
      repeatIndex: task.repeat_index,
      signal,
    },
  );
}

function assertTaskSampleBinding(task, sample) {
  if (!isObject(sample)) {
    throw new Error("leased benchmark sample must be an object");
  }
  for (const [field, expected] of [
    ["id", task.sample_id],
    ["session_id", task.session_id],
    ["dataset", task.dataset],
    ["audio_sha256", task.audio_sha256],
    ["duration_seconds", task.audio_duration_seconds],
    ["language", task.language],
    ["noise_condition", task.noise_condition],
    ["scenario", task.scenario],
    ["speakers", task.speakers],
  ]) {
    const actual = field === "session_id" ? (sample[field] ?? null) : sample[field];
    if (actual !== expected) {
      throw new Error(`leased benchmark sample.${field} does not match the planned task`);
    }
  }
  if (sample.provenance?.basis !== task.provenance_basis) {
    throw new Error("leased benchmark sample provenance does not match the planned task");
  }
  if (typeof sample.audio_file !== "string" || typeof sample.reference_text !== "string") {
    throw new Error("leased benchmark sample must include bound audio and reference contents");
  }
  return sample;
}

async function runLeasedTask({ dependencies, lease, session, signal, task }) {
  const sample = assertTaskSampleBinding(
    task,
    dependencies.assertSampleUnchanged(lease, task.sample_id),
  );
  let report;
  let runError = null;
  try {
    report = await dependencies.runTask({
      task,
      sample,
      session,
      signal,
    });
  } catch (error) {
    runError = error;
  }
  let validationError = null;
  try {
    assertTaskSampleBinding(task, dependencies.assertSampleUnchanged(lease, task.sample_id));
  } catch (error) {
    validationError = error;
  }
  if (signal?.aborted) {
    let interruptionError;
    try {
      throwIfAborted(signal);
    } catch (error) {
      interruptionError = error;
    }
    const secondaryErrors = [runError, validationError].filter(
      (error) => error !== null && error !== interruptionError,
    );
    if (secondaryErrors.length > 0) {
      throw aggregateAfterPrimary(
        interruptionError,
        secondaryErrors,
        "benchmark campaign interrupted",
      );
    }
    throw interruptionError;
  }
  if (runError !== null && validationError !== null) {
    throw aggregateAfterPrimary(runError, [validationError], "benchmark task failed");
  }
  if (validationError !== null) throw validationError;
  if (runError !== null) throw runError;
  if (!isObject(report)) throw new Error("benchmark task must return a report object");
  if (report.schema_version !== CAMPAIGN_RUN_REPORT_SCHEMA_VERSION) {
    throw new Error("benchmark task must return a schema-11 campaign report");
  }
  if (report.benchmark_task_id !== task.task_id) {
    throw new Error("benchmark report task identity does not match the planned task");
  }
  if (report.repeat_index !== task.repeat_index) {
    throw new Error("benchmark report repeat_index does not match the planned task");
  }
  return report;
}

function variantKey(task) {
  return JSON.stringify([
    task.provider,
    task.model,
    task.real_run_backend,
    task.target_backend,
    task.accelerator,
    task.evaluator_revision_sha256,
  ]);
}

export function taskFilenamePrefix(task) {
  return task.report_filename.slice(0, -".run.json".length) + "-";
}

function identifyCheckpoints(checkpoints, tasks) {
  const recordsByTask = new Map(tasks.map((task) => [task.task_id, []]));
  for (const checkpoint of checkpoints) {
    const candidates = [];
    for (const task of tasks) {
      if (checkpoint.name.startsWith(taskFilenamePrefix(task))) {
        candidates.push(task);
      }
    }
    // A checkpoint from an older corpus, threshold, or evaluator revision has
    // a different task digest and remains useful evidence. It must not block
    // the current campaign merely because its sample/provider tuple matches.
    if (candidates.length === 0) continue;

    const valid = [];
    const candidateErrors = [];
    for (const task of candidates) {
      const errors = validateTaskCheckpoint(checkpoint.report, task);
      if (errors.length === 0) valid.push(task);
      else candidateErrors.push(...errors);
    }
    if (valid.length !== 1) {
      const details = candidateErrors.length > 0 ? `\n- ${candidateErrors.join("\n- ")}` : "";
      throw new Error(`invalid benchmark checkpoint for the selected campaign${details}`);
    }
    const task = valid[0];
    const identity = reportIdentityFromCheckpoint(checkpoint.report);
    const expectedName = taskReportFilename(task, identity);
    if (checkpoint.name !== expectedName) {
      throw new Error("benchmark checkpoint filename does not match its exact task and identity");
    }
    recordsByTask.get(task.task_id).push({ ...checkpoint, identity });
  }
  return recordsByTask;
}

function identityKey(identity) {
  return JSON.stringify(identity);
}

function historicalCompletions(tasks, recordsByTask) {
  const completedTaskIds = new Set();
  const records = [];
  for (const task of tasks) {
    const taskRecords = recordsByTask.get(task.task_id) ?? [];
    if (taskRecords.length > 0) completedTaskIds.add(task.task_id);
    records.push(...taskRecords);
  }
  return { completedTaskIds, records };
}

function currentCompletions(tasks, recordsByTask, identities) {
  const completed = new Map();
  for (const task of tasks) {
    const records = recordsByTask.get(task.task_id) ?? [];
    const currentIdentity = identities.get(variantKey(task));
    if (currentIdentity) {
      const currentHardware = JSON.stringify({
        operating_system: currentIdentity.operating_system,
        architecture: currentIdentity.architecture,
        hardware_profile: currentIdentity.hardware_profile,
        accelerator: currentIdentity.accelerator,
      });
      for (const record of records) {
        const recordHardware = JSON.stringify({
          operating_system: record.identity.operating_system,
          architecture: record.identity.architecture,
          hardware_profile: record.identity.hardware_profile,
          accelerator: record.identity.accelerator,
        });
        if (
          recordHardware === currentHardware &&
          (record.identity.model_artifact_sha256 !== currentIdentity.model_artifact_sha256 ||
            record.identity.benchmark_executable_sha256 !==
              currentIdentity.benchmark_executable_sha256)
        ) {
          throw new Error("model or benchmark executable drifted for the current hardware cohort");
        }
      }
    }
    const matching = records.filter(
      (record) => identityKey(record.identity) === identityKey(currentIdentity),
    );
    if (matching.length > 1) {
      throw new Error("multiple checkpoints claim the same exact benchmark task identity");
    }
    if (matching.length > 0) completed.set(task.task_id, matching[0]);
  }
  return completed;
}

function reportIdentityFromSession(session, task) {
  const sessionIdentity = session?.identity;
  if (!isObject(sessionIdentity)) {
    throw new Error("prepared benchmark session must expose an identity");
  }
  for (const [field, expected] of [
    ["provider", task.provider],
    ["model", task.model],
    ["requested_backend", task.real_run_backend],
    ["backend", task.target_backend],
    ["evaluator_revision_sha256", task.evaluator_revision_sha256],
  ]) {
    if (sessionIdentity[field] !== expected) {
      throw new Error(`prepared benchmark session ${field} does not match the planned task`);
    }
  }
  if (
    JSON.stringify(sessionIdentity.evaluator_revision) !== JSON.stringify(task.evaluator_revision)
  ) {
    throw new Error(
      "prepared benchmark session evaluator revision does not match the planned task",
    );
  }
  for (const method of ["runSample", "revalidate", "close"]) {
    if (typeof session[method] !== "function") {
      throw new Error(`prepared benchmark session.${method} must be a function`);
    }
  }
  const identity = {
    model_artifact_sha256: sessionIdentity.model_artifact_sha256,
    operating_system: sessionIdentity.operating_system,
    architecture: sessionIdentity.architecture,
    hardware_profile: sessionIdentity.hardware_profile,
    accelerator: sessionIdentity.accelerator,
    benchmark_executable_sha256: sessionIdentity.benchmark_executable_sha256,
  };
  for (const field of ["model_artifact_sha256", "benchmark_executable_sha256"]) {
    if (!SHA256_PATTERN.test(identity[field] ?? "")) {
      throw new Error(`campaign identity.${field} must be a lowercase SHA-256 digest`);
    }
  }
  for (const field of ["operating_system", "architecture", "hardware_profile", "accelerator"]) {
    requiredString(identity[field], `campaign identity.${field}`);
  }
  taskReportFilename(task, identity);
  return Object.freeze(identity);
}

function prepareVariantSessions(tasks, options) {
  const sessions = new Map();
  const identities = new Map();
  try {
    for (const task of tasks) {
      const key = variantKey(task);
      if (sessions.has(key)) continue;
      const session = options.prepareSession({
        task,
        repoRoot: options.repoRoot,
        modelsDirectory: options.modelsDirectory,
        evaluatorContext: options.evaluatorContext,
      });
      let identity;
      try {
        identity = reportIdentityFromSession(session, task);
      } catch (error) {
        if (typeof session?.close !== "function") throw error;
        try {
          session.close();
        } catch (closeError) {
          throw aggregateAfterPrimary(
            error,
            [closeError],
            "prepared benchmark session identity validation failed",
          );
        }
        throw error;
      }
      sessions.set(key, session);
      identities.set(key, identity);
    }
    return { identities, sessions };
  } catch (error) {
    const closeErrors = [];
    for (const session of [...sessions.values()].reverse()) {
      try {
        session.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    if (closeErrors.length > 0) {
      throw aggregateAfterPrimary(error, closeErrors, "benchmark session preparation failed");
    }
    throw error;
  }
}

function currentSessionIdentities(tasks, sessions) {
  const identities = new Map();
  for (const task of tasks) {
    const key = variantKey(task);
    if (identities.has(key)) continue;
    const session = sessions.get(key);
    identities.set(key, reportIdentityFromSession(session, task));
  }
  return identities;
}

function assertSameEvaluatorContext(initial, current) {
  const canonical = (revisions) =>
    JSON.stringify(
      Object.entries(revisions).sort(([left], [right]) => lexicalCompare(left, right)),
    );
  if (canonical(initial.revisions) !== canonical(current.revisions)) {
    throw new Error("evaluator revision changed while the benchmark campaign was running");
  }
}

function assertSameIdentities(initial, current) {
  if (initial.size !== current.size) {
    throw new Error("benchmark identity set changed while the campaign was running");
  }
  for (const [key, identity] of initial) {
    if (identityKey(identity) !== identityKey(current.get(key))) {
      throw new Error("model, executable, or hardware identity changed during the campaign");
    }
  }
}

function assertSameCompletedCheckpoints(expected, current) {
  if (expected.size !== current.size) {
    throw new Error("benchmark checkpoints changed during final verification");
  }
  for (const [taskId, expectedCheckpoint] of expected) {
    const currentCheckpoint = current.get(taskId);
    if (
      !currentCheckpoint ||
      currentCheckpoint.name !== expectedCheckpoint.name ||
      currentCheckpoint.sha256 !== expectedCheckpoint.sha256 ||
      identityKey(currentCheckpoint.identity) !== identityKey(expectedCheckpoint.identity)
    ) {
      throw new Error("benchmark checkpoints changed during final verification");
    }
  }
}

function assertInputsCurrent({
  manifestPath,
  expectedCorpus,
  targetsPath,
  expectedTargetsSha256,
  loadCorpusImpl,
  loadTargetsImpl,
}) {
  const currentCorpus = loadCorpusImpl(manifestPath);
  if (
    currentCorpus.corpus_id !== expectedCorpus.corpus_id ||
    currentCorpus.corpus_fingerprint !== expectedCorpus.corpus_fingerprint
  ) {
    throw new Error("corpus changed while the benchmark campaign was running");
  }
  const currentTargets = loadTargetsImpl(targetsPath);
  if (currentTargets.targetsSha256 !== expectedTargetsSha256) {
    throw new Error("coverage targets changed while the benchmark campaign was running");
  }
}

function assertTargetsCurrent({ targetsPath, expectedTargetsSha256, loadTargetsImpl }) {
  const currentTargets = loadTargetsImpl(targetsPath);
  if (currentTargets.targetsSha256 !== expectedTargetsSha256) {
    throw new Error("coverage targets changed while the benchmark campaign was running");
  }
}

function requireCompleteCoverage(corpus, targets, completed) {
  const coverage = evaluateCoverage(
    corpus,
    targets,
    [...completed.values()].map((record) => record.report),
  );
  if (!coverage.complete) {
    throw incompleteError(
      "benchmark coverage is incomplete: " +
        `corpus ${coverage.corpus.covered_cells}/${coverage.corpus.required_cells}, ` +
        `measurements ${coverage.measurements.covered_cells}/` +
        `${coverage.measurements.required_cells}, complete hardware matrices ` +
        `${coverage.measurements.complete_matrix_hardware_cohorts}`,
    );
  }
  return coverage;
}

function writeCheckpoint({ task, report, identity, lease, resultsDirectory }) {
  assertTaskCheckpoint(report, task, {
    expectedModelArtifactSha256: identity.model_artifact_sha256,
  });
  if (identityKey(reportIdentityFromCheckpoint(report)) !== identityKey(identity)) {
    throw new Error("benchmark report identity does not match the campaign preflight");
  }
  const filename = taskReportFilename(task, identity);
  const outputPath = path.join(resultsDirectory, filename);
  if (fs.lstatSync(outputPath, { throwIfNoEntry: false })) {
    throw new Error("an exact benchmark checkpoint appeared while its task was running");
  }
  writeLeasedCorpusBoundJson({
    lease,
    outputPath,
    value: report,
  });
  const checkpoint = readCorpusBenchmarkCheckpoint(outputPath);
  assertTaskCheckpoint(checkpoint.report, task, {
    expectedModelArtifactSha256: identity.model_artifact_sha256,
  });
  if (
    checkpoint.name !== filename ||
    identityKey(reportIdentityFromCheckpoint(checkpoint.report)) !== identityKey(identity)
  ) {
    throw new Error("persisted benchmark checkpoint does not match the completed task");
  }
  return { ...checkpoint, identity };
}

function dependenciesWithDefaults(overrides) {
  validateDependencies(overrides);
  return {
    acquireLock: acquireCampaignLock,
    releaseLock: releaseCorpusBenchmarkLock,
    currentProcessIdentity: () => processIdentity(process.pid),
    loadCorpus,
    loadTargets: loadCorpusBenchmarkTargets,
    collectEvaluatorContext,
    createResultLease: createCorpusResultLease,
    assertSampleUnchanged: assertLeasedCorpusSampleUnchanged,
    prepareSession: defaultPrepareSession,
    discoverCheckpoints: discoverCorpusBenchmarkCheckpoints,
    runTask: defaultTaskRunner,
    writeCheckpoint,
    onProgress: () => {},
    ...overrides,
  };
}

export function formatCorpusBenchmarkProgress(event) {
  if (event.type === "task-start") {
    return (
      `benchmark ${event.index}/${event.total}: ` +
      `${event.provider}/${event.model}/${event.backend}`
    );
  }
  if (event.type === "task-complete") {
    return `checkpointed benchmark ${event.index}/${event.total}`;
  }
  if (event.type === "task-skip") {
    return `resuming benchmark ${event.index}/${event.total}: checkpoint already complete`;
  }
  return `planned ${event.total} benchmark task(s)`;
}

export function formatCorpusBenchmarkSummary(result) {
  return (
    `${result.mode}: ${result.totalTasks} task(s), ${result.completedTasks} complete, ` +
    `${result.executedTasks} executed, ${result.pendingTasks} pending, ` +
    `${result.failedQualityTasks} quality failure(s)`
  );
}

export function corpusBenchmarkErrorExitCode(error) {
  return error?.code === "MUESLY_BENCHMARK_INTERRUPTED"
    ? 130
    : error?.code === "MUESLY_BENCHMARK_INCOMPLETE"
      ? 1
      : 2;
}

export async function runCorpusBenchmarkCampaign(options, dependencyOverrides = {}) {
  validateOptions(options);
  const dependencies = dependenciesWithDefaults(dependencyOverrides);
  const currentProcessIdentity = dependencies.currentProcessIdentity();
  const lock = dependencies.acquireLock(options.manifestPath, {
    currentIdentity: currentProcessIdentity,
  });
  const interruption = new AbortController();
  const interruptWith = (signalName) => {
    if (!interruption.signal.aborted) {
      interruption.abort(interruptedError(signalName));
    }
  };
  const onSigint = () => interruptWith("SIGINT");
  const onSigterm = () => interruptWith("SIGTERM");
  if (options.run) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }
  let primaryError = null;
  let campaignResult = null;
  let preparedSessions = new Map();
  try {
    const manifestPath = lock.manifestPath;
    const corpus = dependencies.loadCorpus(manifestPath);
    if (corpus.distribution !== "local") {
      throw new Error("consented corpus benchmark campaigns require a local manifest");
    }
    const loadedTargets = dependencies.loadTargets(options.targetsPath);
    const targets = selectTargets(loadedTargets.targets, options.selectedVariants);
    const evaluatorContext = dependencies.collectEvaluatorContext({
      repoRoot: repositoryRoot,
      targets,
    });
    const tasks = planCorpusBenchmarkTasks({
      corpus,
      targets,
      thresholds: {
        max_wer_percent: options.maxWerPct,
        max_hallucinated_words: options.maxHallucinatedWords,
      },
      accelerators: options.accelerators,
      evaluatorRevisions: evaluatorContext.revisions,
    });
    dependencies.onProgress({ type: "planned", total: tasks.length });
    const resultsDirectory = path.join(path.dirname(manifestPath), "results");
    const lease = options.run
      ? dependencies.createResultLease({
          corpus,
          benchmarkLockToken: lock.token,
          benchmarkProcessIdentity: lock.processIdentity,
        })
      : null;
    const checkpoints = dependencies.discoverCheckpoints(resultsDirectory);
    const recordsByTask = identifyCheckpoints(checkpoints, tasks);
    const modelsDirectory = resolveModelsDirectory(options.modelsDir, repositoryRoot);
    const prepared = options.run
      ? prepareVariantSessions(tasks, {
          evaluatorContext,
          modelsDirectory,
          prepareSession: dependencies.prepareSession,
          repoRoot: repositoryRoot,
        })
      : { identities: new Map(), sessions: new Map() };
    const initialIdentities = prepared.identities;
    preparedSessions = prepared.sessions;
    const completed = options.run
      ? currentCompletions(tasks, recordsByTask, initialIdentities)
      : null;
    let executedTasks = 0;

    if (!options.run) {
      assertInputsCurrent({
        manifestPath,
        expectedCorpus: corpus,
        targetsPath: loadedTargets.targetsPath,
        expectedTargetsSha256: loadedTargets.targetsSha256,
        loadCorpusImpl: dependencies.loadCorpus,
        loadTargetsImpl: dependencies.loadTargets,
      });
      const historical = historicalCompletions(tasks, recordsByTask);
      const pendingTasks = tasks.length - historical.completedTaskIds.size;
      if (options.requireComplete && pendingTasks > 0) {
        throw incompleteError(`benchmark campaign is incomplete: ${pendingTasks} task(s) pending`);
      }
      if (options.requireComplete) {
        requireCompleteCoverage(
          corpus,
          targets,
          new Map(historical.records.map((record, index) => [index, record])),
        );
      }
      const failedQualityTasks = tasks.filter((task) => {
        const records = recordsByTask.get(task.task_id) ?? [];
        return records.length > 0 && records.every((record) => record.report.passed === false);
      }).length;
      campaignResult = {
        mode: "plan",
        totalTasks: tasks.length,
        completedTasks: historical.completedTaskIds.size,
        executedTasks,
        pendingTasks,
        failedQualityTasks,
        taskIds: tasks.map((task) => task.task_id),
        checkpointNames: historical.records.map((record) => record.name),
      };
    } else {
      for (const [taskIndex, task] of tasks.entries()) {
        throwIfAborted(interruption.signal);
        const index = taskIndex + 1;
        if (completed.has(task.task_id)) {
          dependencies.onProgress({ type: "task-skip", index, total: tasks.length });
          continue;
        }
        assertTargetsCurrent({
          targetsPath: loadedTargets.targetsPath,
          expectedTargetsSha256: loadedTargets.targetsSha256,
          loadTargetsImpl: dependencies.loadTargets,
        });
        dependencies.onProgress({
          type: "task-start",
          index,
          total: tasks.length,
          provider: task.provider,
          model: task.model,
          backend: task.target_backend,
        });
        const session = preparedSessions.get(variantKey(task));
        const report = await runLeasedTask({
          dependencies,
          lease,
          session,
          task,
          signal: interruption.signal,
        });
        throwIfAborted(interruption.signal);
        assertTargetsCurrent({
          targetsPath: loadedTargets.targetsPath,
          expectedTargetsSha256: loadedTargets.targetsSha256,
          loadTargetsImpl: dependencies.loadTargets,
        });
        const identity = initialIdentities.get(variantKey(task));
        const checkpoint = dependencies.writeCheckpoint({
          task,
          report,
          identity,
          lease,
          resultsDirectory,
        });
        completed.set(task.task_id, checkpoint);
        executedTasks += 1;
        dependencies.onProgress({
          type: "task-complete",
          index,
          total: tasks.length,
        });
      }

      throwIfAborted(interruption.signal);
      assertInputsCurrent({
        manifestPath,
        expectedCorpus: corpus,
        targetsPath: loadedTargets.targetsPath,
        expectedTargetsSha256: loadedTargets.targetsSha256,
        loadCorpusImpl: dependencies.loadCorpus,
        loadTargetsImpl: dependencies.loadTargets,
      });
      const finalEvaluatorContext = dependencies.collectEvaluatorContext({
        repoRoot: repositoryRoot,
        targets,
      });
      assertSameEvaluatorContext(evaluatorContext, finalEvaluatorContext);
      for (const session of preparedSessions.values()) {
        await session.revalidate();
      }
      const finalIdentities = currentSessionIdentities(tasks, preparedSessions);
      assertSameIdentities(initialIdentities, finalIdentities);
      assertInputsCurrent({
        manifestPath,
        expectedCorpus: corpus,
        targetsPath: loadedTargets.targetsPath,
        expectedTargetsSha256: loadedTargets.targetsSha256,
        loadCorpusImpl: dependencies.loadCorpus,
        loadTargetsImpl: dependencies.loadTargets,
      });
      const finalRecordsByTask = identifyCheckpoints(
        dependencies.discoverCheckpoints(resultsDirectory),
        tasks,
      );
      const verifiedCompleted = currentCompletions(tasks, finalRecordsByTask, initialIdentities);
      assertSameCompletedCheckpoints(completed, verifiedCompleted);
      const pendingTasks = tasks.length - verifiedCompleted.size;
      if (options.requireComplete && pendingTasks > 0) {
        throw incompleteError(`benchmark campaign is incomplete: ${pendingTasks} task(s) pending`);
      }
      if (options.requireComplete) requireCompleteCoverage(corpus, targets, verifiedCompleted);
      const failedQualityTasks = [...verifiedCompleted.values()].filter(
        (record) => record.report.passed === false,
      ).length;
      campaignResult = {
        mode: "run",
        totalTasks: tasks.length,
        completedTasks: verifiedCompleted.size,
        executedTasks,
        pendingTasks,
        failedQualityTasks,
        taskIds: tasks.map((task) => task.task_id),
        checkpointNames: [...verifiedCompleted.values()].map((record) => record.name),
      };
    }
  } catch (error) {
    primaryError = error;
  }
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  const closeErrors = [];
  for (const session of [...preparedSessions.values()].reverse()) {
    try {
      session.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (closeErrors.length > 0) {
    primaryError =
      primaryError === null
        ? closeErrors.length === 1
          ? closeErrors[0]
          : new AggregateError(closeErrors, "failed to close prepared benchmark sessions")
        : aggregateAfterPrimary(
            primaryError,
            closeErrors,
            "benchmark campaign and session cleanup failed",
          );
  }
  let releaseError = null;
  try {
    if (
      !dependencies.releaseLock(lock.lockPath, lock.token, {
        currentIdentity: lock.processIdentity,
      })
    ) {
      releaseError = new Error("failed to release the corpus benchmark lock");
    }
  } catch (error) {
    releaseError = error;
  }
  if (primaryError !== null) throw primaryError;
  if (releaseError !== null) throw releaseError;
  return campaignResult;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  let options;
  try {
    options = parseCorpusBenchmarkArgs(process.argv.slice(2), {
      defaultManifest,
      defaultTargets,
    });
    const result = await runCorpusBenchmarkCampaign(options, {
      onProgress: (event) => console.log(formatCorpusBenchmarkProgress(event)),
    });
    console.log(formatCorpusBenchmarkSummary(result));
    if (result.failedQualityTasks > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = corpusBenchmarkErrorExitCode(error);
  }
}

if (isMainModule()) await main();
