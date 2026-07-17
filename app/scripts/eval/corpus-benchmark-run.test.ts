import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  corpusBenchmarkErrorExitCode,
  formatCorpusBenchmarkProgress,
  formatCorpusBenchmarkSummary,
  inspectVariantIdentity,
  runRealRunCommand,
  runCorpusBenchmarkCampaign,
  signalBenchmarkProcessTree,
} from "./corpus-benchmark-run.ts";
import { benchmarkExecutableSha256 } from "./benchmark-executable.ts";
import {
  discoverCorpusBenchmarkCheckpoints,
  isCorpusBenchmarkCheckpointName,
} from "./corpus-benchmark-checkpoints.ts";
import { acquireCorpusBenchmarkLock, releaseCorpusBenchmarkLock } from "./corpus-benchmark-lock.ts";
import { acquireLocalCorpusLock } from "./corpus-intake.ts";
import { assertLeasedCorpusSampleUnchanged } from "./corpus-result.ts";
import {
  loadCorpus,
  PUBLIC_PREPARATION_PROTOCOL_ID,
  REFERENCE_PROTOCOL_ID,
} from "./corpus.ts";
import { evaluatorRevisionSha256 } from "./evaluator-revision.ts";
import { processIdentity } from "./process-identity.ts";
import { prepareRealRunSession } from "./real-run-session.ts";

const MODEL_ARTIFACT = "b".repeat(64);
const EXECUTABLE = "c".repeat(64);
const RUNTIME_ENVIRONMENT = "d".repeat(64);
const SECRET_REFERENCE = "private participant words must never be printed";
const TEST_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function evaluatorEntry(targetBackend = "cpu", overrides = {}) {
  const revision = {
    schema_version: 1,
    protocol_id: "muesly-real-run-v1",
    git_commit: "1".repeat(40),
    cargo_lock_sha256: "2".repeat(64),
    rustc_vv: [
      "rustc 1.88.0 (6b00bc388 2025-06-23)",
      "binary: rustc",
      "commit-hash: 6b00bc3880198600130e1cf62b8f8a93494488cc",
      "commit-date: 2025-06-23",
      "host: aarch64-apple-darwin",
      "release: 1.88.0",
      "LLVM version: 20.1.5",
    ].join("\n"),
    build_profile: "release",
    target_triple: "aarch64-apple-darwin",
    cargo_features: targetBackend === "metal" ? ["metal"] : [],
    build_env_sha256: "3".repeat(64),
    ...overrides,
  };
  return { revision, sha256: evaluatorRevisionSha256(revision) };
}

function currentIdentity(overrides = {}) {
  return {
    model_artifact_sha256: MODEL_ARTIFACT,
    operating_system: "macos",
    architecture: "aarch64",
    hardware_profile: `cpu=Apple M4 Pro;logical_cpus=14;memory_bytes=25769803776;runtime_env_sha256=${RUNTIME_ENVIRONMENT}`,
    accelerator: "none",
    benchmark_executable_sha256: EXECUTABLE,
    ...overrides,
  };
}

function preparedSession(task, identity = currentIdentity(), hooks = {}) {
  return {
    identity: {
      provider: task.provider,
      model: task.model,
      requested_backend: task.real_run_backend,
      backend: task.target_backend,
      evaluator_revision: structuredClone(task.evaluator_revision),
      evaluator_revision_sha256: task.evaluator_revision_sha256,
      ...identity,
    },
    runSample() {
      throw new Error("the campaign runTask dependency should handle fake sessions");
    },
    async revalidate() {
      await hooks.revalidate?.();
      return this.identity;
    },
    close() {
      hooks.close?.();
    },
  };
}

function cancellableRealSession(t, task, directory, markerPath) {
  const executablePath = path.join(directory, "cancellable-transcribe-fixture");
  const modelsDirectory = path.join(directory, "models");
  fs.mkdirSync(modelsDirectory, { recursive: true });
  fs.writeFileSync(path.join(modelsDirectory, `ggml-${task.model}.bin`), "prepared model", {
    mode: 0o600,
  });
  fs.writeFileSync(
    executablePath,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "process.on('SIGTERM', () => {});",
      `fs.writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const identity = currentIdentity();
  const session = prepareRealRunSession(
    {
      provider: task.provider,
      model: task.model,
      backend: task.real_run_backend,
      accelerator: task.accelerator,
      modelsDirectory,
      repoRoot: directory,
      buildEnvironment: {},
      runtimeEnvironment: {},
      evaluatorRevision: {
        revision: structuredClone(task.evaluator_revision),
        sha256: task.evaluator_revision_sha256,
      },
    },
    {
      buildBenchmarkExecutable: () => ({
        cargoFeatures: [...task.evaluator_revision.cargo_features],
        executablePath,
      }),
      prepareBenchmarkModel: (_command, input) => ({
        schema_version: 3,
        provider: input.provider,
        model: input.model,
        model_artifact_sha256: sha256("prepared model"),
        primary_model_artifact_sha256: null,
      }),
      probeBenchmarkExecutable: (command) => ({
        schema_version: 1,
        backend: task.target_backend,
        operating_system: identity.operating_system,
        architecture: identity.architecture,
        hardware_profile: identity.hardware_profile,
        accelerator: identity.accelerator,
        benchmark_executable_sha256: benchmarkExecutableSha256(command),
      }),
    },
  );
  t.after(() => session.close());
  return session;
}

function reportForTask(task, identity = currentIdentity(), overrides = {}) {
  const result = {
    sample_id: task.sample_id,
    ...(task.dataset === undefined ? {} : { dataset: task.dataset }),
    language: task.language,
    noise_condition: task.noise_condition,
    scenario: task.scenario,
    speakers: task.speakers,
    provenance_basis: task.provenance_basis,
    reference_words: 20,
    word_errors: 1,
    wer_percent: 5,
    hallucinated_words: null,
    passed: true,
    metrics: {
      schema_version: 7,
      provider: task.provider,
      model: task.model,
      backend: task.target_backend,
      operating_system: identity.operating_system,
      architecture: identity.architecture,
      hardware_profile: identity.hardware_profile,
      accelerator: identity.accelerator,
      benchmark_executable_sha256: identity.benchmark_executable_sha256,
      audio_sha256: task.audio_sha256,
      audio_duration_seconds: task.audio_duration_seconds,
      decode_seconds: 0.1,
      vad_seconds: 0.2,
      model_download_seconds: 0,
      model_load_seconds: 1,
      inference_seconds: 2,
      inference_rtf: 2 / task.audio_duration_seconds,
      inference_audio_seconds: task.audio_duration_seconds / 2,
      model_inference_rtf: 4 / task.audio_duration_seconds,
      measured_total_seconds: 3.3,
      baseline_rss_mb: 100,
      peak_rss_mb: 500,
      peak_rss_delta_mb: 400,
    },
    ...overrides.result,
  };
  return {
    schema_version: 11,
    benchmark_task_id: task.task_id,
    corpus_id: task.corpus_id,
    corpus_fingerprint: task.corpus_fingerprint,
    reference_protocol_id: task.reference_protocol_id,
    started_at: "2026-07-16T00:00:00.000Z",
    completed_at: "2026-07-16T00:01:00.000Z",
    wer_scorer: task.wer_scorer,
    evaluator_revision: structuredClone(task.evaluator_revision),
    evaluator_revision_sha256: task.evaluator_revision_sha256,
    benchmark_executable_sha256: identity.benchmark_executable_sha256,
    provider: task.provider,
    model: task.model,
    repeat_index: task.repeat_index,
    model_artifact_sha256: identity.model_artifact_sha256,
    thresholds: { ...task.thresholds },
    passed: result.passed,
    results: [result],
    ...overrides.report,
  };
}

function fixture(t, { samples = ["sample-b", "sample-a"], dataset } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muesly-campaign-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const localCorpusRoot = path.join(directory, "local-corpus");
  const sessionDirectory = path.join(localCorpusRoot, "session-a");
  fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  const corpusSamples = samples.map((sampleId, index) => {
    const audioName = `${sampleId}.wav`;
    const referenceName = `${sampleId}.txt`;
    const audio = Buffer.from(`audio-${index}`);
    const reference = `${SECRET_REFERENCE} ${index}\n`;
    fs.writeFileSync(path.join(sessionDirectory, audioName), audio, { mode: 0o600 });
    fs.writeFileSync(path.join(sessionDirectory, referenceName), reference, { mode: 0o600 });
    return {
      id: sampleId,
      session_id: "session-a",
      ...(dataset === undefined ? {} : { dataset }),
      audio_path: `local-corpus/session-a/${audioName}`,
      audio_sha256: sha256(audio),
      reference_path: `local-corpus/session-a/${referenceName}`,
      reference_sha256: sha256(reference),
      language: "en",
      whisper_language: "en",
      scenario: "meeting",
      noise_condition: "clean",
      speakers: 2,
      duration_seconds: 20,
      provenance:
        dataset === undefined
          ? {
              basis: "participant-consent",
              redistribution: "local-only",
              consent_record_id: `consent-${sampleId}`,
              consent_date: "2026-07-01",
              consented_uses: ["asr-benchmarking"],
            }
          : {
              basis: "public-license",
              redistribution: "local-only",
              source_catalog_id: "public-corpus-sources-v1",
              source_item_ids: [`source-${sampleId}`],
              transform_id: "deterministic-test-transform",
            },
    };
  });
  const manifestPath = path.join(directory, "corpus-local.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema_version: 4,
      corpus_id: "consented-meetings-v1",
      reference_protocol_id: REFERENCE_PROTOCOL_ID,
      description: "Local consented meetings.",
      distribution: "local",
      ...(dataset === undefined
        ? {}
        : {
            source_catalog_sha256: "9".repeat(64),
            preparation: {
              protocol_id: PUBLIC_PREPARATION_PROTOCOL_ID,
              source_catalog_id: "public-corpus-sources-v1",
              selection_sha256: "8".repeat(64),
              ffmpeg_id: "ffmpeg-test",
              ffmpeg_sha256: "7".repeat(64),
              ffmpeg_version: "ffmpeg test version",
            },
          }),
      samples: corpusSamples,
    })}\n`,
    { mode: 0o600 },
  );
  const targetsPath = path.join(directory, "corpus-targets.json");
  fs.writeFileSync(
    targetsPath,
    `${JSON.stringify({
      schema_version: 3,
      target_id: "multilingual-v1",
      reference_protocol_id: REFERENCE_PROTOCOL_ID,
      description: "Test target.",
      coverage_mode: dataset === undefined ? "language-noise-matrix" : "explicit-samples",
      ...(dataset === undefined
        ? {
            languages: ["en"],
            noise_conditions: ["clean"],
            min_sessions_per_language_noise_cell: 1,
          }
        : { sample_ids: samples, repetitions: 1 }),
      benchmark_variants: [{ provider: "whisper", model: "whisper-test", backend: "cpu" }],
    })}\n`,
  );
  return {
    directory,
    localCorpusRoot,
    lockPath: path.join(localCorpusRoot, ".benchmark.lock"),
    manifestPath,
    resultsDirectory: path.join(directory, "results"),
    targetsPath,
  };
}

function options(current, overrides = {}) {
  return {
    manifestPath: current.manifestPath,
    targetsPath: current.targetsPath,
    modelsDir: null,
    maxWerPct: 10,
    maxHallucinatedWords: 2,
    selectedVariants: [],
    accelerators: {},
    run: true,
    requireComplete: false,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    currentProcessIdentity: () => processIdentity(process.pid) ?? "campaign-test-process",
    collectEvaluatorContext: ({ targets }) => ({
      buildEnvironment: {},
      hostTriple: "aarch64-apple-darwin",
      revisions: Object.fromEntries(
        targets.benchmark_variants.map((variant) => [
          variant.backend,
          evaluatorEntry(variant.backend),
        ]),
      ),
      targetTriple: "aarch64-apple-darwin",
    }),
    prepareSession: ({ task }) => preparedSession(task),
    runTask: ({ task }) => reportForTask(task),
    ...overrides,
  };
}

test("campaign preflight stages Windows profile-root ORT DLLs before probing", (t) => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "muesly-campaign-preflight-"));
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  const profileDirectory = path.join(repositoryRoot, "target", "release");
  const examplesDirectory = path.join(profileDirectory, "examples");
  const executablePath = path.join(examplesDirectory, "transcribe-fixture.exe");
  const modelsDirectory = path.join(repositoryRoot, "models");
  fs.mkdirSync(examplesDirectory, { recursive: true });
  fs.mkdirSync(modelsDirectory);
  fs.writeFileSync(executablePath, "exact benchmark executable", { mode: 0o700 });
  fs.writeFileSync(path.join(profileDirectory, "onnxruntime.dll"), "profile-root ORT runtime");
  let stagedExecutablePath = null;
  let privateSnapshotDirectory = null;
  const assertStagedRuntime = (candidatePath, options) => {
    stagedExecutablePath ??= candidatePath;
    assert.equal(candidatePath, stagedExecutablePath);
    privateSnapshotDirectory ??= path.dirname(path.dirname(candidatePath));
    assert.notEqual(candidatePath, executablePath);
    assert.equal(options.platform, "win32");
    assert.equal(
      fs.readFileSync(path.join(path.dirname(candidatePath), "onnxruntime.dll"), "utf8"),
      "profile-root ORT runtime",
    );
    assert.match(options.environment.MUESLY_EVAL_RUNTIME_DEPENDENCIES_SHA256, /^[a-f0-9]{64}$/);
  };

  const inspectionInput = {
    task: {
      accelerator: null,
      model: "parakeet-test",
      provider: "parakeet",
      real_run_backend: "cpu",
      target_backend: "onnx-cpu",
    },
    repoRoot: repositoryRoot,
    modelsDirectory,
    evaluatorContext: {
      buildEnvironment: {},
      hostTriple: "x86_64-pc-windows-msvc",
    },
  };
  const identity = inspectVariantIdentity(inspectionInput, {
    buildBenchmarkExecutableImpl: () => ({
      cargoFeatures: [],
      executablePath,
    }),
    modelArtifactSha256Impl: () => MODEL_ARTIFACT,
    platform: "win32",
    prepareBenchmarkModelImpl: (candidatePath, options) => {
      assertStagedRuntime(candidatePath, options);
      assert.equal(options.reportedBackend, "onnx-cpu");
      return {
        schema_version: 3,
        provider: "parakeet",
        model: "parakeet-test",
        model_artifact_sha256: MODEL_ARTIFACT,
        primary_model_artifact_sha256: null,
      };
    },
    probeBenchmarkExecutableImpl: (candidatePath, options) => {
      assertStagedRuntime(candidatePath, options);
      return {
        backend: "onnx-cpu",
        operating_system: "windows",
        architecture: "x86_64",
        hardware_profile:
          `cpu=test;logical_cpus=8;memory_bytes=17179869184;` +
          `runtime_env_sha256=${options.environment.MUESLY_EVAL_RUNTIME_ENV_SHA256}`,
        accelerator: "none",
        benchmark_executable_sha256: sha256("exact benchmark executable"),
      };
    },
  });

  assert.equal(identity.benchmark_executable_sha256, sha256("exact benchmark executable"));
  assert.equal(identity.model_artifact_sha256, MODEL_ARTIFACT);
  assert.notEqual(privateSnapshotDirectory, null);
  assert.equal(fs.existsSync(privateSnapshotDirectory), false);

  assert.throws(
    () =>
      inspectVariantIdentity(inspectionInput, {
        buildBenchmarkExecutableImpl: () => ({ cargoFeatures: [], executablePath }),
        modelArtifactSha256Impl: () => MODEL_ARTIFACT,
        platform: "win32",
        prepareBenchmarkModelImpl: () => ({
          schema_version: 3,
          provider: "parakeet",
          model: "parakeet-test",
          model_artifact_sha256: "f".repeat(64),
          primary_model_artifact_sha256: null,
        }),
        probeBenchmarkExecutableImpl: (candidatePath, options) => ({
          backend: "onnx-cpu",
          operating_system: "windows",
          architecture: "x86_64",
          hardware_profile:
            `cpu=test;logical_cpus=8;memory_bytes=17179869184;` +
            `runtime_env_sha256=${options.environment.MUESLY_EVAL_RUNTIME_ENV_SHA256}`,
          accelerator: "none",
          benchmark_executable_sha256: benchmarkExecutableSha256(candidatePath),
        }),
      }),
    /canonical artifact digest attested by the evaluator/,
  );

  assert.throws(
    () =>
      inspectVariantIdentity(inspectionInput, {
        buildBenchmarkExecutableImpl: () => ({ cargoFeatures: [], executablePath }),
        modelArtifactSha256Impl: () => MODEL_ARTIFACT,
        primaryModelArtifactSha256Impl: () => MODEL_ARTIFACT,
        platform: "win32",
        prepareBenchmarkModelImpl: () => ({
          schema_version: 3,
          provider: "whisper",
          model: "large-v3-turbo-q5_0",
          model_artifact_sha256: null,
          primary_model_artifact_sha256: "f".repeat(64),
        }),
        probeBenchmarkExecutableImpl: (candidatePath, options) => ({
          backend: "onnx-cpu",
          operating_system: "windows",
          architecture: "x86_64",
          hardware_profile:
            `cpu=test;logical_cpus=8;memory_bytes=17179869184;` +
            `runtime_env_sha256=${options.environment.MUESLY_EVAL_RUNTIME_ENV_SHA256}`,
          accelerator: "none",
          benchmark_executable_sha256: benchmarkExecutableSha256(candidatePath),
        }),
      }),
    /prepared primary model bytes do not match the canonical digest/,
  );
});

test("plans deterministically without executing in safe plan mode", async (t) => {
  const current = fixture(t);
  let runs = 0;
  const progress = [];
  const result = await runCorpusBenchmarkCampaign(
    options(current, { run: false }),
    dependencies({
      onProgress: (event) => progress.push(formatCorpusBenchmarkProgress(event)),
      runTask: () => {
        runs += 1;
      },
    }),
  );

  assert.equal(runs, 0);
  assert.equal(result.mode, "plan");
  assert.equal(result.totalTasks, 2);
  assert.equal(result.pendingTasks, 2);
  assert.equal(result.taskIds.length, 2);
  assert.notEqual(result.taskIds[0], result.taskIds[1]);
  assert.equal(fs.existsSync(current.lockPath), false);
  assert.deepEqual(progress, ["planned 2 benchmark task(s)"]);
});

test("requires the complete target matrix instead of certifying a selected variant", async (t) => {
  const current = fixture(t);
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current, {
        selectedVariants: ["whisper/whisper-test/cpu"],
        requireComplete: true,
      }),
      dependencies(),
    ),
    /--require-complete cannot be combined with --variant/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("checkpoints every task privately and resumes only exact completed identities", async (t) => {
  const current = fixture(t);
  const executed = [];
  const first = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: ({ task }) => {
        executed.push(task.sample_id);
        return reportForTask(task);
      },
    }),
  );
  assert.deepEqual(executed, ["sample-a", "sample-b"]);
  assert.equal(first.executedTasks, 2);
  assert.equal(first.pendingTasks, 0);
  assert(first.checkpointNames.every(isCorpusBenchmarkCheckpointName));
  assert(first.checkpointNames.every((name) => !name.includes("sample-")));
  assert(first.checkpointNames.every((name) => !name.includes("wav")));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(current.resultsDirectory).mode & 0o777, 0o700);
    for (const name of first.checkpointNames) {
      assert.equal(fs.statSync(path.join(current.resultsDirectory, name)).mode & 0o777, 0o600);
    }
  }

  let resumedRuns = 0;
  const resumed = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: () => {
        resumedRuns += 1;
        throw new Error("completed tasks must not rerun");
      },
    }),
  );
  assert.equal(resumedRuns, 0);
  assert.equal(resumed.executedTasks, 0);
  assert.equal(resumed.completedTasks, 2);
  assert.deepEqual(resumed.checkpointNames, first.checkpointNames);
});

test("rejects one cached report reused across later planned repeats", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const targets = JSON.parse(fs.readFileSync(current.targetsPath, "utf8"));
  targets.coverage_mode = "explicit-samples";
  targets.sample_ids = ["sample-a"];
  targets.repetitions = 3;
  delete targets.languages;
  delete targets.noise_conditions;
  delete targets.min_sessions_per_language_noise_cell;
  fs.writeFileSync(current.targetsPath, `${JSON.stringify(targets)}\n`);

  let cachedReport = null;
  const observedTaskIds = [];
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        runTask: ({ task }) => {
          observedTaskIds.push(task.task_id);
          cachedReport ??= reportForTask(task);
          return {
            ...cachedReport,
            repeat_index: task.repeat_index,
          };
        },
      }),
    ),
    /benchmark report task identity does not match the planned task/,
  );

  assert.equal(new Set(observedTaskIds).size, 2);
  assert.equal(
    fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length,
    1,
  );
});

test("passes the planned task and repeat identity into the evaluator before inference", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const observed = [];
  const campaignDependencies = dependencies({
    prepareSession: ({ task }) => {
      const session = preparedSession(task);
      session.runSample = (_sample, runOptions) => {
        observed.push({
          benchmarkTaskId: runOptions.benchmarkTaskId,
          repeatIndex: runOptions.repeatIndex,
        });
        return reportForTask(task);
      };
      return session;
    },
  });
  delete campaignDependencies.runTask;

  const result = await runCorpusBenchmarkCampaign(options(current), campaignDependencies);

  assert.equal(result.executedTasks, 1);
  assert.equal(observed.length, 1);
  assert.match(observed[0].benchmarkTaskId, /^[a-f0-9]{64}$/);
  assert.equal(observed[0].repeatIndex, 1);
});

test("binds a public dataset from the leased sample through evaluator output", async (t) => {
  const current = fixture(t, { samples: ["sample-a"], dataset: "fleurs" });
  const observed = [];
  const result = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: ({ task, sample }) => {
        observed.push({ taskDataset: task.dataset, sampleDataset: sample.dataset });
        return reportForTask(task);
      },
    }),
  );

  assert.equal(result.executedTasks, 1);
  assert.deepEqual(observed, [{ taskDataset: "fleurs", sampleDataset: "fleurs" }]);
  const checkpointPath = path.join(current.resultsDirectory, result.checkpointNames[0]);
  assert.equal(JSON.parse(fs.readFileSync(checkpointPath, "utf8")).results[0].dataset, "fleurs");
});

test("rejects a leased public sample whose dataset differs from the planned task", async (t) => {
  const current = fixture(t, { samples: ["sample-a"], dataset: "fleurs" });
  let evaluatorStarted = false;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        assertSampleUnchanged(lease, sampleId) {
          return {
            ...assertLeasedCorpusSampleUnchanged(lease, sampleId),
            dataset: "ami",
          };
        },
        runTask: () => {
          evaluatorStarted = true;
          throw new Error("must not run");
        },
      }),
    ),
    /leased benchmark sample\.dataset does not match the planned task/,
  );
  assert.equal(evaluatorStarted, false);
});

test("rejects a legacy standalone report returned by a campaign evaluator", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        runTask: ({ task }) => {
          const report = reportForTask(task);
          report.schema_version = 10;
          delete report.benchmark_task_id;
          return report;
        },
      }),
    ),
    /benchmark task must return a schema-11 campaign report/,
  );
  assert.equal(
    fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length,
    0,
  );
});

test("reuses one prepared variant session without reloading the full corpus per sample", async (t) => {
  const current = fixture(t);
  let corpusLoads = 0;
  let sampleChecks = 0;
  let prepares = 0;
  let revalidations = 0;
  let closes = 0;
  const observedSessions = [];
  const observedSamples = [];
  const result = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      loadCorpus(manifestPath) {
        corpusLoads += 1;
        return loadCorpus(manifestPath);
      },
      assertSampleUnchanged(lease, sampleId) {
        sampleChecks += 1;
        return assertLeasedCorpusSampleUnchanged(lease, sampleId);
      },
      prepareSession: ({ task }) => {
        prepares += 1;
        return preparedSession(task, currentIdentity(), {
          revalidate: () => {
            revalidations += 1;
          },
          close: () => {
            closes += 1;
          },
        });
      },
      runTask: ({ task, sample, session }) => {
        observedSessions.push(session);
        observedSamples.push(sample);
        return reportForTask(task);
      },
    }),
  );

  assert.equal(result.executedTasks, 2);
  assert.equal(prepares, 1);
  assert.equal(new Set(observedSessions).size, 1);
  assert.equal(observedSamples.length, 2);
  assert(observedSamples.every((sample) => sample.reference_text.startsWith(SECRET_REFERENCE)));
  assert(
    observedSamples.every(
      (sample) => sample.audio_sha256 === sha256(fs.readFileSync(sample.audio_file)),
    ),
  );
  assert.equal(sampleChecks, 4);
  assert.equal(corpusLoads, 3);
  assert.equal(revalidations, 1);
  assert.equal(closes, 1);
});

test("revalidates leased sample bytes after inference before checkpointing", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        runTask: ({ task, sample }) => {
          fs.writeFileSync(sample.audio_file, "changed during inference", { mode: 0o600 });
          return reportForTask(task);
        },
      }),
    ),
    /leased corpus sample 'sample-a' audio changed after validation/,
  );
  assert.equal(
    fs.existsSync(current.resultsDirectory)
      ? fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length
      : 0,
    0,
  );
});

test("closes already prepared variants when a later session fails", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const targets = JSON.parse(fs.readFileSync(current.targetsPath, "utf8"));
  targets.benchmark_variants.push({
    provider: "whisper",
    model: "whisper-test",
    backend: "metal",
  });
  fs.writeFileSync(current.targetsPath, `${JSON.stringify(targets)}\n`);
  let prepares = 0;
  let closes = 0;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        prepareSession: ({ task }) => {
          prepares += 1;
          if (prepares === 2) throw new Error("second variant preparation failed");
          return preparedSession(task, currentIdentity(), {
            close: () => {
              closes += 1;
            },
          });
        },
      }),
    ),
    /second variant preparation failed/,
  );
  assert.equal(prepares, 2);
  assert.equal(closes, 1);
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("closes a newly prepared session when its exposed identity is rejected", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  let closes = 0;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        prepareSession: ({ task }) =>
          preparedSession(
            task,
            { ...currentIdentity(), backend: "wrong-backend" },
            {
              close: () => {
                closes += 1;
              },
            },
          ),
      }),
    ),
    /prepared benchmark session backend does not match the planned task/,
  );
  assert.equal(closes, 1);
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("fails closed for invalid or stale task checkpoints", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const first = await runCorpusBenchmarkCampaign(options(current), dependencies());
  const checkpointPath = path.join(current.resultsDirectory, first.checkpointNames[0]);
  const report = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  report.corpus_fingerprint = "e".repeat(64);
  fs.writeFileSync(checkpointPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });

  await assert.rejects(
    runCorpusBenchmarkCampaign(options(current, { run: false }), dependencies()),
    /invalid benchmark checkpoint/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("persists completed work before interruption and safely resumes the remainder", async (t) => {
  const current = fixture(t);
  let calls = 0;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        runTask: ({ task }) => {
          calls += 1;
          if (calls === 2) throw new Error("interrupted");
          return reportForTask(task);
        },
      }),
    ),
    /interrupted/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
  assert.equal(
    fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length,
    1,
  );

  const resumed = [];
  const result = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: ({ task }) => {
        resumed.push(task.sample_id);
        return reportForTask(task);
      },
    }),
  );
  assert.deepEqual(resumed, ["sample-b"]);
  assert.equal(result.completedTasks, 2);
});

test("holds exclusive ownership for the full campaign and releases it in finally", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  let observedOwnedLock = false;
  await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: ({ task }) => {
        observedOwnedLock = fs.existsSync(current.lockPath);
        assert.throws(
          () => acquireCorpusBenchmarkLock(current.manifestPath),
          /another corpus benchmark is active/,
        );
        return reportForTask(task);
      },
    }),
  );
  assert.equal(observedOwnedLock, true);
  assert.equal(fs.existsSync(current.lockPath), false);

  const held = acquireCorpusBenchmarkLock(current.manifestPath);
  await assert.rejects(
    runCorpusBenchmarkCampaign(options(current), dependencies()),
    /another corpus benchmark is active/,
  );
  assert.equal(releaseCorpusBenchmarkLock(held.lockPath, held.token), true);
});

test("requires an exact process identity before creating a run lease", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        currentProcessIdentity: () => null,
      }),
    ),
    /verified benchmark process identity is required/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("coordinates campaign ownership with corpus mutation and pending withdrawal state", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  let mutationWasBlocked = false;
  await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: ({ task }) => {
        const mutationLockPath = path.join(current.localCorpusRoot, ".intake.lock");
        assert.throws(
          () =>
            acquireLocalCorpusLock(
              mutationLockPath,
              current.localCorpusRoot,
              current.manifestPath,
              {
                operation: "intake",
                sessionId: "session-other",
              },
            ),
          /a corpus benchmark is active/,
        );
        mutationWasBlocked = true;
        assert.equal(fs.existsSync(mutationLockPath), false);
        return reportForTask(task);
      },
    }),
  );
  assert.equal(mutationWasBlocked, true);
  assert.equal(fs.existsSync(current.lockPath), false);

  fs.writeFileSync(path.join(current.localCorpusRoot, ".withdrawal-session-a.json"), "{}\n", {
    mode: 0o600,
  });
  await assert.rejects(
    runCorpusBenchmarkCampaign(options(current, { run: false }), dependencies()),
    /corpus withdrawal is pending/,
  );
  assert.equal(fs.existsSync(path.join(current.localCorpusRoot, ".intake.lock")), false);
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("rechecks corpus state after final evaluator and artifact inspection", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  let collections = 0;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        collectEvaluatorContext: ({ targets }) => {
          collections += 1;
          if (collections === 2) {
            const document = JSON.parse(fs.readFileSync(current.manifestPath, "utf8"));
            document.description = "Changed outside the coordinated corpus commands.";
            fs.writeFileSync(current.manifestPath, `${JSON.stringify(document)}\n`, {
              mode: 0o600,
            });
          }
          return {
            buildEnvironment: {},
            hostTriple: "aarch64-apple-darwin",
            revisions: Object.fromEntries(
              targets.benchmark_variants.map((variant) => [
                variant.backend,
                evaluatorEntry(variant.backend),
              ]),
            ),
            targetTriple: "aarch64-apple-darwin",
          };
        },
      }),
    ),
    /corpus changed while the benchmark campaign was running/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("rejects a schema-valid checkpoint replacement during final verification", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  let discoveries = 0;
  let replaced = false;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        discoverCheckpoints: (resultsDirectory) => {
          discoveries += 1;
          if (discoveries === 2) {
            const checkpointName = fs
              .readdirSync(resultsDirectory)
              .find(isCorpusBenchmarkCheckpointName);
            assert(checkpointName);
            const checkpointPath = path.join(resultsDirectory, checkpointName);
            const report = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
            report.completed_at = "2026-07-16T00:02:00.000Z";
            fs.writeFileSync(checkpointPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
            replaced = true;
          }
          return discoverCorpusBenchmarkCheckpoints(resultsDirectory);
        },
      }),
    ),
    /benchmark checkpoints changed during final verification/,
  );
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("refuses model or executable identity drift without writing a checkpoint", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const drifted = currentIdentity({ benchmark_executable_sha256: "f".repeat(64) });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        runTask: ({ task }) => reportForTask(task, drifted),
      }),
    ),
    /campaign preflight/,
  );
  assert.equal(
    fs.existsSync(current.resultsDirectory)
      ? fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length
      : 0,
    0,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("checkpoints quality failures and reports them without rerunning completed work", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const first = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: ({ task }) =>
        reportForTask(task, currentIdentity(), {
          result: {
            passed: false,
            word_errors: 4,
            wer_percent: 20,
          },
          report: { passed: false },
        }),
    }),
  );
  assert.equal(first.completedTasks, 1);
  assert.equal(first.failedQualityTasks, 1);
  assert.equal(first.executedTasks, 1);

  let reruns = 0;
  const resumed = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      runTask: () => {
        reruns += 1;
        throw new Error("quality failures are completed checkpoints");
      },
    }),
  );
  assert.equal(reruns, 0);
  assert.equal(resumed.failedQualityTasks, 1);
  assert.equal(resumed.executedTasks, 0);
});

test("fails closed when a completed checkpoint drifts on the same hardware cohort", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  await runCorpusBenchmarkCampaign(options(current), dependencies());
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        prepareSession: ({ task }) =>
          preparedSession(task, currentIdentity({ model_artifact_sha256: "f".repeat(64) })),
      }),
    ),
    /model or benchmark executable drifted for the current hardware cohort/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("fails closed when evaluator provenance changes before campaign completion", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  let collections = 0;
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        collectEvaluatorContext: ({ targets }) => {
          collections += 1;
          const entry = evaluatorEntry();
          if (collections > 1) {
            entry.revision.git_commit = "9".repeat(40);
            entry.sha256 = evaluatorRevisionSha256(entry.revision);
          }
          return {
            buildEnvironment: {},
            hostTriple: "aarch64-apple-darwin",
            revisions: Object.fromEntries(
              targets.benchmark_variants.map((variant) => [variant.backend, entry]),
            ),
            targetTriple: "aarch64-apple-darwin",
          };
        },
      }),
    ),
    /evaluator revision changed/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("require-complete invokes the coverage gate for an empty or underfilled corpus", async (t) => {
  const current = fixture(t, { samples: [] });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current, { requireComplete: true, run: false }),
      dependencies(),
    ),
    /benchmark coverage is incomplete: corpus 0\/1, measurements 0\/1/,
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("older evaluator checkpoints do not permanently block a new campaign revision", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const first = await runCorpusBenchmarkCampaign(options(current), dependencies());
  const newerEntry = evaluatorEntry("cpu", { git_commit: "9".repeat(40) });
  let reruns = 0;
  const second = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      collectEvaluatorContext: ({ targets }) => ({
        buildEnvironment: {},
        hostTriple: "aarch64-apple-darwin",
        revisions: Object.fromEntries(
          targets.benchmark_variants.map((variant) => [variant.backend, newerEntry]),
        ),
        targetTriple: "aarch64-apple-darwin",
      }),
      runTask: ({ task }) => {
        reruns += 1;
        return reportForTask(task);
      },
    }),
  );
  assert.equal(reruns, 1);
  assert.notDeepEqual(second.checkpointNames, first.checkpointNames);
  assert.equal(
    fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length,
    2,
  );
});

test("plan mode considers every historical hardware identity without choosing one arbitrarily", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const firstIdentity = currentIdentity();
  const secondIdentity = currentIdentity({
    hardware_profile: `cpu=Other CPU;logical_cpus=8;memory_bytes=17179869184;runtime_env_sha256=${RUNTIME_ENVIRONMENT}`,
  });
  const first = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({ prepareSession: ({ task }) => preparedSession(task, firstIdentity) }),
  );
  const second = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      prepareSession: ({ task }) => preparedSession(task, secondIdentity),
      runTask: ({ task }) =>
        reportForTask(task, secondIdentity, {
          result: {
            passed: false,
            word_errors: 4,
            wer_percent: 20,
          },
          report: { passed: false },
        }),
    }),
  );
  assert.equal(first.checkpointNames.length, 1);
  assert.equal(second.checkpointNames.length, 1);

  const planned = await runCorpusBenchmarkCampaign(
    options(current, { run: false }),
    dependencies(),
  );
  assert.equal(planned.completedTasks, 1);
  assert.equal(planned.pendingTasks, 0);
  assert.equal(planned.failedQualityTasks, 0);
  assert.equal(planned.checkpointNames.length, 2);
  assert.deepEqual(
    new Set(planned.checkpointNames),
    new Set([...first.checkpointNames, ...second.checkpointNames]),
  );
});

test("uses Windows taskkill to terminate the full benchmark process tree", () => {
  const calls = [];
  const child = {
    pid: 4242,
    kill: () => {
      throw new Error("the direct-child fallback must not run");
    },
  };
  assert.equal(
    signalBenchmarkProcessTree(child, "SIGTERM", {
      environment: { SystemRoot: "C:\\Windows" },
      execFileSyncImpl: (executable, args, options) => {
        calls.push({ executable, args, options });
      },
      platform: "win32",
      taskkillExecutable: "C:\\Windows\\System32\\taskkill.exe",
    }),
    true,
  );
  assert.deepEqual(calls, [
    {
      executable: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4242", "/T", "/F"],
      options: {
        env: { SystemRoot: "C:\\Windows" },
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      },
    },
  ]);
});

test("does not report direct-child fallback as a successful Windows tree kill", () => {
  let directChildKilled = false;
  const child = {
    pid: 4242,
    kill: () => {
      directChildKilled = true;
      return true;
    },
  };
  assert.equal(
    signalBenchmarkProcessTree(child, "SIGKILL", {
      environment: { SystemRoot: "C:\\Windows" },
      execFileSyncImpl: () => {
        throw new Error("taskkill failed");
      },
      platform: "win32",
      taskkillExecutable: "C:\\Windows\\System32\\taskkill.exe",
    }),
    false,
  );
  assert.equal(directChildKilled, false);
});

test(
  "aborting a real-run command force-kills a SIGTERM-resistant process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muesly-campaign-tree-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const parentMarker = path.join(directory, "parent.json");
    const grandchildMarker = path.join(directory, "grandchild.txt");
    const sigtermMarker = path.join(directory, "sigterm.txt");
    const grandchildScript = path.join(directory, "grandchild.ts");
    const parentScript = path.join(directory, "parent.ts");
    fs.writeFileSync(
      grandchildScript,
      [
        'import fs from "node:fs";',
        'process.on("SIGTERM", () => fs.writeFileSync(process.argv[3], "received"));',
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      parentScript,
      [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        `const child = spawn(process.execPath, [${JSON.stringify(
          grandchildScript,
        )}, ${JSON.stringify(grandchildMarker)}, ${JSON.stringify(sigtermMarker)}], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(
          parentMarker,
        )}, JSON.stringify({ parent: process.pid, grandchild: child.pid }));`,
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );

    const controller = new AbortController();
    let processGroupLeader = null;
    const run = runRealRunCommand([parentScript], {
      forceKillDelayMs: 250,
      repoRoot: directory,
      signal: controller.signal,
      spawnImpl: (...args) => {
        const child = spawnChild(...args);
        processGroupLeader = child.pid;
        return child;
      },
    });
    t.after(async () => {
      if (!controller.signal.aborted) controller.abort(new Error("test cleanup"));
      try {
        await run;
      } catch {
        // Cancellation is the expected cleanup path.
      }
    });
    await waitFor(
      () => fs.existsSync(parentMarker) && fs.existsSync(grandchildMarker),
      "timed out waiting for the benchmark descendant tree",
    );
    const { parent, grandchild: grandchildWrapper } = JSON.parse(
      fs.readFileSync(parentMarker, "utf8"),
    );
    const grandchild = Number(fs.readFileSync(grandchildMarker, "utf8"));
    for (const pid of [parent, grandchildWrapper, grandchild]) {
      assert(Number.isSafeInteger(pid) && pid > 0);
    }
    assert.equal(processGroupLeader, parent);
    assert.equal(grandchildWrapper, grandchild);
    assert.equal(processGroupExists(processGroupLeader), true);
    t.after(() => {
      for (const pid of [parent, grandchildWrapper, grandchild]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The cancellation under test already reaped the process.
        }
      }
    });

    controller.abort(new Error("cancel benchmark tree"));
    await assert.rejects(run, /cancel benchmark tree/);
    assert.equal(fs.readFileSync(sigtermMarker, "utf8"), "received");
    assert.equal(processGroupExists(processGroupLeader), false);
  },
);

test("closes the abort race between spawning and listener registration", async () => {
  const controller = new AbortController();
  let childPid = null;
  const run = runRealRunCommand(["--version"], {
    repoRoot: TEST_REPOSITORY_ROOT,
    signal: controller.signal,
    spawnImpl: (...args) => {
      const child = spawnChild(...args);
      childPid = child.pid;
      controller.abort(new Error("abort during spawn"));
      return child;
    },
  });
  await assert.rejects(run, /abort during spawn/);
  if (childPid !== null) {
    await waitFor(() => !processExists(childPid), "spawn-race child survived cancellation");
  }
});

test(
  "real prepared-session SIGINT becomes a campaign interruption with CLI exit 130",
  { skip: process.platform === "win32" },
  async (t) => {
    const current = fixture(t, { samples: ["sample-a"] });
    const markerPath = path.join(current.directory, "active-real-session.pid");
    const campaign = runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        prepareSession: ({ task }) =>
          cancellableRealSession(t, task, current.directory, markerPath),
        runTask: ({ task, sample, session, signal }) =>
          session.runSample(
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
              signal,
            },
          ),
      }),
    );
    await Promise.race([
      waitFor(() => fs.existsSync(markerPath), "timed out waiting for the real session process"),
      campaign.then(() => {
        throw new Error("real session campaign completed before interruption");
      }),
    ]);
    const childPid = Number(fs.readFileSync(markerPath, "utf8"));
    assert(Number.isSafeInteger(childPid) && childPid > 0);
    t.after(() => {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // The campaign cancellation should already have reaped the process.
      }
    });

    process.emit("SIGINT");
    let failure;
    try {
      await campaign;
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof Error);
    assert.equal(failure.code, "MUESLY_BENCHMARK_INTERRUPTED");
    assert.match(failure.message, /benchmark campaign interrupted by SIGINT/);
    assert.equal(corpusBenchmarkErrorExitCode(failure), 130);
    assert(
      failure instanceof AggregateError &&
        failure.errors.some((error) => error?.name === "AbortError"),
    );
    assert.equal(processExists(childPid), false);
    assert.equal(fs.existsSync(current.lockPath), false);
    assert.equal(
      fs.readdirSync(current.resultsDirectory).filter(isCorpusBenchmarkCheckpointName).length,
      0,
    );
  },
);

test("SIGINT aborts an active task and releases campaign ownership", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
        prepareSession: ({ task }) =>
          preparedSession(task, currentIdentity(), {
            close: () => {
              throw new Error("session cleanup failed after interruption");
            },
          }),
        runTask: async ({ signal }) => {
          process.emit("SIGINT");
          await Promise.resolve();
          assert.equal(signal.aborted, true);
          throw signal.reason;
        },
      }),
    ),
    (error) =>
      error.code === "MUESLY_BENCHMARK_INTERRUPTED" &&
      /benchmark campaign interrupted by SIGINT/.test(error.message),
  );
  assert.equal(fs.existsSync(current.lockPath), false);
});

test("progress, summaries, and filenames never expose corpus text or media paths", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  const messages = [];
  const result = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      onProgress: (event) => messages.push(formatCorpusBenchmarkProgress(event)),
    }),
  );
  messages.push(formatCorpusBenchmarkSummary(result));
  const output = messages.join("\n");
  assert(!output.includes(SECRET_REFERENCE));
  assert(!output.includes("sample-a"));
  assert(!output.includes(".wav"));
  assert(!output.includes(".txt"));
  assert(result.checkpointNames.every((name) => !name.includes("sample-a")));
});
