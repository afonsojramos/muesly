import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatCorpusBenchmarkProgress,
  formatCorpusBenchmarkSummary,
  runRealRunCommand,
  runCorpusBenchmarkCampaign,
  signalBenchmarkProcessTree,
} from "./corpus-benchmark-run.ts";
import {
  discoverCorpusBenchmarkCheckpoints,
  isCorpusBenchmarkCheckpointName,
} from "./corpus-benchmark-checkpoints.ts";
import { acquireCorpusBenchmarkLock, releaseCorpusBenchmarkLock } from "./corpus-benchmark-lock.ts";
import { acquireLocalCorpusLock } from "./corpus-intake.ts";
import { evaluatorRevisionSha256 } from "./evaluator-revision.ts";

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

function reportForTask(task, identity = currentIdentity(), overrides = {}) {
  const result = {
    sample_id: task.sample_id,
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
      schema_version: 5,
      provider: task.provider,
      model: task.model,
      backend: task.target_backend,
      operating_system: identity.operating_system,
      architecture: identity.architecture,
      hardware_profile: identity.hardware_profile,
      accelerator: identity.accelerator,
      benchmark_executable_sha256: identity.benchmark_executable_sha256,
      audio_duration_seconds: task.audio_duration_seconds,
      decode_seconds: 0.1,
      vad_seconds: 0.2,
      model_download_seconds: 0,
      model_load_seconds: 1,
      inference_seconds: 2,
      inference_rtf: 2 / task.audio_duration_seconds,
      measured_total_seconds: 3.3,
      baseline_rss_mb: 100,
      peak_rss_mb: 500,
      peak_rss_delta_mb: 400,
    },
    ...overrides.result,
  };
  return {
    schema_version: 9,
    corpus_id: task.corpus_id,
    corpus_fingerprint: task.corpus_fingerprint,
    started_at: "2026-07-16T00:00:00.000Z",
    completed_at: "2026-07-16T00:01:00.000Z",
    wer_scorer: task.wer_scorer,
    evaluator_revision: structuredClone(task.evaluator_revision),
    evaluator_revision_sha256: task.evaluator_revision_sha256,
    benchmark_executable_sha256: identity.benchmark_executable_sha256,
    provider: task.provider,
    model: task.model,
    model_artifact_sha256: identity.model_artifact_sha256,
    thresholds: { ...task.thresholds },
    passed: result.passed,
    results: [result],
    ...overrides.report,
  };
}

function fixture(t, { samples = ["sample-b", "sample-a"] } = {}) {
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
      provenance: {
        basis: "participant-consent",
        redistribution: "local-only",
        consent_record_id: `consent-${sampleId}`,
        consent_date: "2026-07-01",
        consented_uses: ["asr-benchmarking"],
      },
    };
  });
  const manifestPath = path.join(directory, "corpus-local.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema_version: 2,
      corpus_id: "consented-meetings-v1",
      description: "Local consented meetings.",
      distribution: "local",
      samples: corpusSamples,
    })}\n`,
    { mode: 0o600 },
  );
  const targetsPath = path.join(directory, "corpus-targets.json");
  fs.writeFileSync(
    targetsPath,
    `${JSON.stringify({
      schema_version: 1,
      target_id: "multilingual-v1",
      description: "Test target.",
      languages: ["en"],
      noise_conditions: ["clean"],
      benchmark_variants: [{ provider: "whisper", model: "whisper-test", backend: "cpu" }],
      min_sessions_per_language_noise_cell: 1,
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
    inspectVariantIdentity: () => currentIdentity(),
    runTask: ({ task }) => reportForTask(task),
    ...overrides,
  };
}

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
        inspectVariantIdentity: () => currentIdentity({ model_artifact_sha256: "f".repeat(64) }),
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
    dependencies({ inspectVariantIdentity: () => firstIdentity }),
  );
  const second = await runCorpusBenchmarkCampaign(
    options(current),
    dependencies({
      inspectVariantIdentity: () => secondIdentity,
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

test("aborting a real-run command terminates its descendant process tree", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muesly-campaign-tree-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parentMarker = path.join(directory, "parent.json");
  const grandchildMarker = path.join(directory, "grandchild.txt");
  const grandchildScript = path.join(directory, "grandchild.ts");
  const parentScript = path.join(directory, "parent.ts");
  fs.writeFileSync(
    grandchildScript,
    [
      'import fs from "node:fs";',
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
      `const child = spawn("nub", [${JSON.stringify(grandchildScript)}, ${JSON.stringify(
        grandchildMarker,
      )}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(
        parentMarker,
      )}, JSON.stringify({ parent: process.pid, grandchild: child.pid }));`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );

  const controller = new AbortController();
  const run = runRealRunCommand([parentScript], {
    repoRoot: directory,
    signal: controller.signal,
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
  await waitFor(
    () => !processExists(parent) && !processExists(grandchildWrapper) && !processExists(grandchild),
    "benchmark descendant processes survived cancellation",
  );
});

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

test("SIGINT aborts an active task and releases campaign ownership", async (t) => {
  const current = fixture(t, { samples: ["sample-a"] });
  await assert.rejects(
    runCorpusBenchmarkCampaign(
      options(current),
      dependencies({
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
