#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { forcesWhisperCpu, requiresWhisperGpu } from "./backend.ts";
import {
  benchmarkDefinitionForReportedBackend,
  benchmarkExecutableSha256,
  benchmarkRuntimeEnvironment,
  buildBenchmarkExecutable,
  prepareBenchmarkModel,
  probeBenchmarkExecutable,
} from "./benchmark-executable.ts";
import {
  cleanupCorpusBenchmarkAttempt,
  discoverCorpusBenchmarkCheckpoints,
  MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES,
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
import { writeCorpusBoundJson } from "./corpus-result.ts";
import { canonicalFilePath, canonicalManifestPath, loadCorpus } from "./corpus.ts";
import { evaluateCoverage, validateCoverageTargets } from "./coverage.ts";
import { evaluatorBuildEnvironment, evaluatorRevision } from "./evaluator-revision.ts";
import { modelArtifactSha256, resolveModelsDirectory } from "./model-artifact.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../..");
const defaultManifest = path.join(here, "corpus-local.json");
const defaultTargets = path.join(here, "corpus-targets.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_CHILD_OUTPUT_BYTES = 32 * 1024 * 1024;
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
  "loadCorpus",
  "loadTargets",
  "collectEvaluatorContext",
  "inspectVariantIdentity",
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

function loadTargets(targetsPath) {
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

function acquireCampaignLock(manifestPath) {
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
    return acquireCorpusBenchmarkLock(canonicalManifest);
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

function rustcHostTriple(environment = process.env) {
  const rustcExecutable = environment.RUSTC || "rustc";
  let output;
  try {
    output = execFileSync(rustcExecutable, ["-vV"], {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("unable to execute rustc -vV for the benchmark campaign");
  }
  const hosts = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("host: "))
    .map((line) => line.slice("host: ".length).trim());
  if (hosts.length !== 1) {
    throw new Error("rustc -vV did not report exactly one host target triple");
  }
  return hosts[0];
}

function collectEvaluatorContext({ repoRoot, targets }) {
  const hostTriple = rustcHostTriple();
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

function inspectVariantIdentity({ task, repoRoot, modelsDirectory, evaluatorContext }) {
  ensureSidecarStubs(repoRoot, evaluatorContext.hostTriple);
  const runtimeEnvironment = benchmarkRuntimeEnvironment(process.env, {
    accelerator: task.accelerator,
    forceWhisperCpu: forcesWhisperCpu(task.provider, task.real_run_backend),
    requireWhisperAcceleration: requiresWhisperGpu(task.provider, task.real_run_backend),
  });
  const built = buildBenchmarkExecutable(repoRoot, {
    provider: task.provider,
    backend: task.real_run_backend,
    buildEnv: evaluatorContext.buildEnvironment,
  });
  const executableSha256 = benchmarkExecutableSha256(built.executablePath);
  const probe = probeBenchmarkExecutable(built.executablePath, {
    provider: task.provider,
    backend: task.real_run_backend,
    environment: runtimeEnvironment,
  });
  if (
    probe.backend !== task.target_backend ||
    probe.benchmark_executable_sha256 !== executableSha256
  ) {
    throw new Error("benchmark hardware probe does not match the planned task");
  }
  prepareBenchmarkModel(built.executablePath, {
    provider: task.provider,
    model: task.model,
    modelsDirectory,
    environment: runtimeEnvironment,
  });
  const modelArtifactDigest = modelArtifactSha256(
    task.provider,
    task.model,
    modelsDirectory,
    probe.backend,
  );
  if (benchmarkExecutableSha256(built.executablePath) !== executableSha256) {
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
}

function readAttemptReport(attemptPath) {
  let descriptor;
  try {
    const initial = fs.lstatSync(attemptPath, { bigint: true });
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.nlink !== 1n ||
      initial.size > BigInt(MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES)
    ) {
      throw new Error();
    }
    descriptor = fs.openSync(attemptPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileSnapshot(initial, opened)) {
      throw new Error();
    }
    const contents = fs.readFileSync(descriptor);
    const finalDescriptor = fs.fstatSync(descriptor, { bigint: true });
    const finalPath = fs.lstatSync(attemptPath, { bigint: true });
    if (
      contents.length > MAX_CORPUS_BENCHMARK_CHECKPOINT_BYTES ||
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
    const decoded = UTF8_DECODER.decode(contents);
    const report = JSON.parse(decoded);
    if (!isObject(report)) throw new Error();
    return report;
  } catch {
    throw new Error("real-run did not produce a safe one-sample benchmark report");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : interruptedError();
}

function signalBenchmarkProcessTree(child, signalName) {
  if (!child.pid) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signalName);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  }
  try {
    return child.kill(signalName);
  } catch {
    return false;
  }
}

async function runRealRunCommand(args, { environment = process.env, repoRoot, signal }) {
  throwIfAborted(signal);
  const child = spawn("nub", args, {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let forceKillTimer = null;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalBenchmarkProcessTree(child, "SIGTERM");
    if (forceKillTimer === null) {
      forceKillTimer = setTimeout(() => signalBenchmarkProcessTree(child, "SIGKILL"), 5_000);
      forceKillTimer.unref();
    }
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
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("unable to start the real-run benchmark command")),
      );
      child.once("close", (status, terminationSignal) => resolve({ status, terminationSignal }));
    });
    throwIfAborted(signal);
    if (outputLimitExceeded) {
      throw new Error("real-run exceeded the private campaign output limit");
    }
    return outcome;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (forceKillTimer !== null) clearTimeout(forceKillTimer);
  }
}

async function defaultTaskRunner({
  task,
  manifestPath,
  modelsDirectory,
  resultsDirectory,
  repoRoot,
  signal,
  benchmarkLockToken,
}) {
  const attemptPath = path.join(
    resultsDirectory,
    `.benchmark-attempt-${process.pid}-${randomUUID()}.json`,
  );
  const realRunPath = path.join(here, "real-run.ts");
  const args = [
    realRunPath,
    "--manifest",
    manifestPath,
    "--provider",
    task.provider,
    "--model",
    task.model,
    "--models-dir",
    modelsDirectory,
    "--backend",
    task.real_run_backend,
    "--fixture",
    task.sample_id,
    "--max-wer",
    String(task.thresholds.max_wer_percent),
    "--max-hallucinated-words",
    String(task.thresholds.max_hallucinated_words),
    "--output",
    attemptPath,
  ];
  if (task.accelerator !== null) args.push("--accelerator", task.accelerator);
  try {
    const run = await runRealRunCommand(args, {
      environment: {
        ...process.env,
        MUESLY_CORPUS_BENCHMARK_TOKEN: benchmarkLockToken,
      },
      repoRoot,
      signal,
    });
    if (!fs.existsSync(attemptPath)) {
      throw new Error(
        `real-run failed before producing a report ` +
          `(exit ${run.status ?? run.terminationSignal ?? "signal"})`,
      );
    }
    const report = readAttemptReport(attemptPath);
    if (
      (run.status === 0 && report.passed !== true) ||
      (run.status === 1 && report.passed !== false) ||
      ![0, 1].includes(run.status)
    ) {
      throw new Error(
        `real-run report status did not match its exit status ` +
          `(exit ${run.status ?? run.terminationSignal ?? "signal"})`,
      );
    }
    return report;
  } finally {
    if (fs.existsSync(attemptPath)) cleanupCorpusBenchmarkAttempt(attemptPath);
  }
}

function variantKey(task) {
  return `${task.provider}\0${task.model}\0${task.target_backend}`;
}

function taskFilenamePrefix(task) {
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

function inspectCurrentIdentities(tasks, options) {
  const identities = new Map();
  for (const task of tasks) {
    const key = variantKey(task);
    if (identities.has(key)) continue;
    const identity = options.inspectVariantIdentity({
      task,
      repoRoot: options.repoRoot,
      modelsDirectory: options.modelsDirectory,
      evaluatorContext: options.evaluatorContext,
    });
    for (const field of ["model_artifact_sha256", "benchmark_executable_sha256"]) {
      if (!SHA256_PATTERN.test(identity?.[field] ?? "")) {
        throw new Error(`campaign identity.${field} must be a lowercase SHA-256 digest`);
      }
    }
    identities.set(key, identity);
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

function writeCheckpoint({
  task,
  report,
  identity,
  manifestPath,
  resultsDirectory,
  expectedFingerprint,
  benchmarkLockToken,
}) {
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
  writeCorpusBoundJson({
    manifestPath,
    expectedFingerprint,
    benchmarkLockToken,
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
    loadCorpus,
    loadTargets,
    collectEvaluatorContext,
    inspectVariantIdentity,
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

export async function runCorpusBenchmarkCampaign(options, dependencyOverrides = {}) {
  validateOptions(options);
  const dependencies = dependenciesWithDefaults(dependencyOverrides);
  const lock = dependencies.acquireLock(options.manifestPath);
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
    const checkpoints = dependencies.discoverCheckpoints(resultsDirectory);
    const recordsByTask = identifyCheckpoints(checkpoints, tasks);
    const modelsDirectory = resolveModelsDirectory(options.modelsDir, repositoryRoot);
    const initialIdentities = options.run
      ? inspectCurrentIdentities(tasks, {
          evaluatorContext,
          inspectVariantIdentity: dependencies.inspectVariantIdentity,
          modelsDirectory,
          repoRoot: repositoryRoot,
        })
      : new Map();
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
        assertInputsCurrent({
          manifestPath,
          expectedCorpus: corpus,
          targetsPath: loadedTargets.targetsPath,
          expectedTargetsSha256: loadedTargets.targetsSha256,
          loadCorpusImpl: dependencies.loadCorpus,
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
        const report = await dependencies.runTask({
          task,
          manifestPath,
          modelsDirectory,
          resultsDirectory,
          repoRoot: repositoryRoot,
          signal: interruption.signal,
          benchmarkLockToken: lock.token,
        });
        throwIfAborted(interruption.signal);
        assertInputsCurrent({
          manifestPath,
          expectedCorpus: corpus,
          targetsPath: loadedTargets.targetsPath,
          expectedTargetsSha256: loadedTargets.targetsSha256,
          loadCorpusImpl: dependencies.loadCorpus,
          loadTargetsImpl: dependencies.loadTargets,
        });
        const identity = initialIdentities.get(variantKey(task));
        const checkpoint = dependencies.writeCheckpoint({
          task,
          report,
          identity,
          manifestPath,
          resultsDirectory,
          expectedFingerprint: corpus.corpus_fingerprint,
          benchmarkLockToken: lock.token,
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
      const finalIdentities = inspectCurrentIdentities(tasks, {
        evaluatorContext: finalEvaluatorContext,
        inspectVariantIdentity: dependencies.inspectVariantIdentity,
        modelsDirectory,
        repoRoot: repositoryRoot,
      });
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
      if (
        verifiedCompleted.size !== completed.size ||
        [...completed.keys()].some((taskId) => !verifiedCompleted.has(taskId))
      ) {
        throw new Error("benchmark checkpoints changed during final verification");
      }
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
  let releaseError = null;
  try {
    if (!dependencies.releaseLock(lock.lockPath, lock.token)) {
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
    process.exitCode =
      error.code === "MUESLY_BENCHMARK_INTERRUPTED"
        ? 130
        : error.code === "MUESLY_BENCHMARK_INCOMPLETE"
          ? 1
          : 2;
  }
}

if (isMainModule()) await main();
