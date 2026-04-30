import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import { createWriteStream } from "node:fs";
import { eventBus } from "#web/eventBus.js";
import { broadcast } from "../ws/connections.js";
import { saveRun, updateRun } from "#benchmark/store.js";
import { evaluateScenario } from "#benchmark/evaluate.js";
import { dashboardState } from "#app/ui/dashboard.js";
import { isLoopIdle } from "../app/runApp/webModeLoop.js";

const execFileAsync = promisify(execFile);

const SCENARIO_DIR = path.resolve(process.cwd(), "projects/benchmark");

async function _ensureGithubRepo(githubConfig) {
  const { getGithubClient } = await import("#github/client.js");
  // Build a minimal project config shape that getGithubClient expects
  const client = getGithubClient({ github: githubConfig });
  if (!client) return;
  const { owner, repo } = githubConfig;
  try {
    await client.rest("GET", `/repos/${owner}/${repo}`);
    // Repo already exists — done
  } catch (err) {
    if (err?.status !== 404) return; // unexpected error, skip
    // Create the repo
    await client.rest("POST", `/user/repos`, {
      name: repo,
      description: `Benchmark scenario: ${repo}`,
      private: false,
      auto_init: false,
    });
  }
}
const LOG_DIR = path.resolve(process.cwd(), "logs/benchmark");
const RUN_TIMEOUT_MS = 12 * 60 * 1000;

// scenarioId → true while a run is active
const _activeRuns = new Map();

// Global mutex — only one benchmark may run at a time (webModeLoop is single-threaded)
let _globalRunActive = false;

export async function listScenarios() {
  try {
    const entries = await fs.readdir(SCENARIO_DIR, { withFileTypes: true });
    const scenarios = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const scenarioId = e.name;
      try {
        const projectMod = await import(
          path.join(SCENARIO_DIR, scenarioId, "project.js") + `?t=${Date.now()}`
        );
        const proj = projectMod.project || projectMod.default;
        const _p = proj?.provider;
        scenarios.push({
          id: scenarioId,
          name: proj?.name || scenarioId,
          description: proj?.description || "",
          projectId: proj?.id || `benchmark-${scenarioId}`,
          provider: (_p && _p !== "automation-api") ? _p : (dashboardState.provider || "copilot"),
          taskType: proj?.taskType || "quick_edit",
        });
      } catch {
        scenarios.push({ id: scenarioId, name: scenarioId, description: "" });
      }
    }
    return scenarios;
  } catch {
    return [];
  }
}

export async function resetScenario(scenarioId) {
  const baselineDir = path.join(SCENARIO_DIR, scenarioId, "baseline") + "/";
  const workspaceDir = path.join(SCENARIO_DIR, scenarioId, "workspace");
  const workspaceDirSlash = workspaceDir + "/";

  // Ensure workspace dir exists
  await fs.mkdir(workspaceDir, { recursive: true });

  // rsync baseline → workspace (delete extras, preserve .git and node_modules)
  await execFileAsync("rsync", [
    "-a", "--delete",
    "--filter=protect .git",
    "--filter=protect node_modules",
    baselineDir, workspaceDirSlash,
  ]);

  // Install dependencies if package.json exists, then rebuild native modules
  const pkgJson = path.join(workspaceDir, "package.json");
  const nmDir   = path.join(workspaceDir, "node_modules");
  try {
    await fs.access(pkgJson);
    try { await fs.access(nmDir); } catch {
      await execFileAsync("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
        cwd: workspaceDir, timeout: 60_000,
      });
    }
    // Always rebuild native addons for the current Node.js version.
    // Preserved node_modules may contain binaries compiled against a different
    // NODE_MODULE_VERSION (e.g. better-sqlite3 built on Node 18 failing on Node 20).
    await execFileAsync("npm", ["rebuild"], { cwd: workspaceDir, timeout: 60_000 }).catch(() => {});
  } catch { /* no package.json — skip */ }

  // Ensure git repo is initialized in workspace
  const gitDir = path.join(workspaceDir, ".git");
  let gitInitNeeded = false;
  try {
    await fs.access(gitDir);
  } catch {
    gitInitNeeded = true;
  }

  if (gitInitNeeded) {
    await execFileAsync("git", ["-C", workspaceDir, "init", "-b", "main"]);
    await execFileAsync("git", ["-C", workspaceDir, "config", "user.email", "benchmark@copilot-helper"]);
    await execFileAsync("git", ["-C", workspaceDir, "config", "user.name", "Benchmark"]);
  }

  // Always orphan the git history on reset so each run starts from a single
  // baseline commit. This prevents accumulated fix commits from leaking into
  // the next run's git log and giving the agent unintended context.
  // Clean up stale temp branch from any interrupted previous reset.
  await execFileAsync("git", ["-C", workspaceDir, "branch", "-D", "_baseline_reset"]).catch(() => {});
  await execFileAsync("git", ["-C", workspaceDir, "checkout", "--orphan", "_baseline_reset"]).catch(() => {});
  await execFileAsync("git", ["-C", workspaceDir, "add", "-A"]).catch(() => {});
  await execFileAsync("git", ["-C", workspaceDir, "commit",
    "-m", "baseline: broken state for benchmark",
    "--allow-empty",
  ]).catch(() => {});
  // Replace main with the clean single-commit history (-M force-renames even if main exists).
  await execFileAsync("git", ["-C", workspaceDir, "branch", "-D", "main"]).catch(() => {});
  await execFileAsync("git", ["-C", workspaceDir, "branch", "-m", "main"]).catch(() => {});
}

export function isRunActive(scenarioId) {
  return _activeRuns.has(scenarioId);
}

export function isGlobalRunActive() {
  return _globalRunActive;
}

// Track the in-progress batch run so the UI can show status.
let _batchState = null;
let _batchRunActive = false;

export function getBatchState() {
  return _batchState;
}

/**
 * Run every scenario sequentially and return a summary.
 * Fires benchmark_batch_progress events during the run.
 */
export async function runAllBenchmarks({ provider } = {}) {
  if (_globalRunActive || _batchRunActive) {
    throw Object.assign(new Error("A benchmark is already running — wait for it to finish"), { code: "CONFLICT" });
  }
  _batchRunActive = true;

  try {
    const scenarios = await listScenarios();
    if (scenarios.length === 0) throw new Error("No scenarios found");

    _batchState = { total: scenarios.length, completed: 0, passed: 0, failed: 0, results: [], startedAt: Date.now() };
    broadcast({ type: "benchmark_batch_started", total: scenarios.length });

    const { getRunById } = await import("#benchmark/store.js");

    for (const scenario of scenarios) {
      _batchState.current = scenario.id;
      broadcast({ type: "benchmark_batch_progress", ...getBatchState() });

      let runId;
      try {
        runId = await runBenchmark(scenario.id, { provider });
      } catch (err) {
        _batchState.completed++;
        _batchState.failed++;
        _batchState.results.push({ scenarioId: scenario.id, passed: false, error: err.message });
        broadcast({ type: "benchmark_batch_progress", ...getBatchState() });
        continue;
      }

      // Poll store until this run completes AND the global lock is released (max 15 min).
      const maxWaitMs = 15 * 60 * 1000;
      const pollInterval = 3000;
      const deadline = Date.now() + maxWaitMs;
      let run = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollInterval));
        run = await getRunById(runId);
        if (run && run.completedAt && !_globalRunActive) break;
      }

      const passed = run?.passed ?? false;
      _batchState.completed++;
      if (passed) _batchState.passed++; else _batchState.failed++;
      _batchState.results.push({ scenarioId: scenario.id, passed, durationMs: run?.durationMs ?? null });
      _batchState.current = null;
      broadcast({ type: "benchmark_batch_progress", ...getBatchState() });
    }

    const summary = { ..._batchState, completedAt: Date.now() };
    broadcast({ type: "benchmark_batch_complete", ...summary });
    return summary;
  } finally {
    _batchState = null;
    _batchRunActive = false;
  }
}

export async function runBenchmark(scenarioId, { provider: requestedProvider } = {}) {
  if (_activeRuns.has(scenarioId)) {
    throw Object.assign(new Error("Run already active for this scenario"), { code: "CONFLICT" });
  }
  if (_globalRunActive) {
    throw Object.assign(new Error("Another benchmark is already running — wait for it to finish"), { code: "CONFLICT" });
  }

  // Load scenario config
  let projectConfig;
  try {
    const mod = await import(
      path.join(SCENARIO_DIR, scenarioId, "project.js") + `?t=${Date.now()}`
    );
    projectConfig = mod.project || mod.default;
  } catch (err) {
    throw new Error(`Cannot load project config for scenario "${scenarioId}": ${err.message}`);
  }

  const projectId = projectConfig.id || `benchmark-${scenarioId}`;
  // Provider priority: UI selection (from POST body) > project config > dashboardState > copilot
  const _configuredProvider = projectConfig.provider;
  const provider = requestedProvider
    || ((_configuredProvider && _configuredProvider !== "automation-api") ? _configuredProvider : null)
    || dashboardState.provider
    || "copilot";
  const taskType = projectConfig.taskType || "quick_edit";
  const prompt =
    typeof projectConfig.getPrompt === "function" ? projectConfig.getPrompt() : projectConfig.prompt || "";

  const runId = `bench-${scenarioId}-${Date.now()}`;
  const startedAt = Date.now();

  // Ensure log directory
  const scenarioLogDir = path.join(LOG_DIR, scenarioId);
  await fs.mkdir(scenarioLogDir, { recursive: true });
  const logFile = path.join(scenarioLogDir, `${runId}.jsonl`);

  // Persist initial run record
  await saveRun({
    id: runId,
    scenarioId,
    provider,
    startedAt,
    completedAt: null,
    passed: null,
    passCount: null,
    failCount: null,
    durationMs: null,
    turns: null,
    tokenCount: null,
    modifiedFiles: [],
    logFile,
    errorMsg: null,
  });

  _activeRuns.set(scenarioId, runId);
  _globalRunActive = true;

  // Fire-and-forget orchestration
  _runOrchestration({ scenarioId, projectId, provider, taskType, prompt, runId, startedAt, logFile,
    timeoutMs: projectConfig.timeoutMs || undefined })
    .catch(async (err) => {
      // _runOrchestration has internal catch-all so this only fires on unexpected throws.
      // Ensure the DB row is always finalized — never leave it with completedAt=NULL.
      console.error(`[Benchmark] Orchestration crashed for ${scenarioId}:`, err.message);
      await _failRun(runId, scenarioId, startedAt, `Orchestration crashed: ${err.message}`, logFile);
    })
    .finally(() => {
      _activeRuns.delete(scenarioId);
      _globalRunActive = false;
    });

  return runId;
}

async function _runOrchestration({ scenarioId, projectId, provider, taskType, prompt, runId, startedAt, logFile, timeoutMs }) {
  const effectiveTimeout = timeoutMs || RUN_TIMEOUT_MS;
  // --- Step 1: reset workspace ---
  try {
    await resetScenario(scenarioId);
  } catch (err) {
    await _failRun(runId, scenarioId, startedAt, `Reset failed: ${err.message}`, logFile);
    return;
  }

  // --- Step 2: attach log collector ---
  const logStream = createWriteStream(logFile, { flags: "a" });
  const _logEvent = (type, data) => {
    try {
      logStream.write(JSON.stringify({ t: Date.now(), type, data }) + "\n");
    } catch {}
  };

  // Log events that provide useful signal in post-run analysis
  const loggedEvents = [
    "system_message",    // retries, verifier results, critic, progress
    "plan_update",       // what the PM planned to do
    "phase_change",      // pipeline phase transitions
    "persona_change",    // which agent node is running
    "subtask_kickoff",   // which subtask the coder is working on
    "task_state_change", // subtask completed/failed
    "files_modified",    // which files were written
    "session_start",     // session kicked off
    "session_error",     // unrecoverable error
    "session_complete",  // clean completion
    "app_ready",         // loop returned to idle
  ];
  const handlers = {};
  for (const ev of loggedEvents) {
    handlers[ev] = (data) => _logEvent(ev, data);
    eventBus.on(ev, handlers[ev]);
  }

  // Snapshot metrics at the moment of session completion (before app_ready resets state).
  // dashboardState.turn is not updated by the automation API provider; use completedCount
  // (subtasks verified) as a proxy for session complexity.
  let _metricsSnapshot = null;
  const onSessionComplete = () => {
    _metricsSnapshot = {
      turns: dashboardState.completedCount || 0,
      tokenCount: dashboardState.tokens || 0,
      modifiedFiles: dashboardState.modifiedFiles ? [...dashboardState.modifiedFiles] : [],
    };
  };
  eventBus.once("session_complete", onSessionComplete);

  // Override phase_change handler to also record phase timings for post-run analysis
  const _phaseTimings = [];
  eventBus.off("phase_change", handlers["phase_change"]);
  handlers["phase_change"] = (data) => {
    _phaseTimings.push({ phase: data.phase, t: Date.now() });
    _logEvent("phase_change", data);
  };
  eventBus.on("phase_change", handlers["phase_change"]);

  const detachLogs = () => {
    for (const [ev, fn] of Object.entries(handlers)) eventBus.off(ev, fn);
    eventBus.off("session_complete", onSessionComplete);
    logStream.end();
  };

  // Broadcast start
  _logEvent("benchmark_run_started", { scenarioId, runId, provider });
  broadcast({ type: "benchmark_run_started", scenarioId, runId, provider });

  // Forward system_message to benchmark_progress for UI
  const onSysMsg = (data) =>
    broadcast({ type: "benchmark_progress", scenarioId, runId, text: data.text, msgType: data.type });
  eventBus.on("system_message", onSysMsg);

  // --- Step 3: wait for loop to be idle, then dispatch ---
  // Using a two-phase app_ready approach:
  //   first app_ready = loop confirmed idle → safe to dispatch
  //   second app_ready = task complete → evaluate
  // If the loop is already idle we can dispatch immediately.
  let abortController = { aborted: false };
  let _abortReject;

  const completionPromise = new Promise((resolve, reject) => {
    _abortReject = reject;
    const runTimer = setTimeout(() => {
      // Snapshot metrics before aborting — session_complete may never fire
      if (!_metricsSnapshot) {
        _metricsSnapshot = {
          turns: dashboardState.completedCount || 0,
          tokenCount: dashboardState.tokens || 0,
          modifiedFiles: dashboardState.modifiedFiles ? [...dashboardState.modifiedFiles] : [],
        };
      }
      if (!abortController.aborted) {
        abortController.aborted = true;
        eventBus.emit("abort_requested", {});
      }
      reject(new Error("Benchmark timed out"));
    }, effectiveTimeout);

    const onAbort = () => {
      clearTimeout(runTimer);
      eventBus.off("app_ready", dispatchAndWait);
      reject(new Error("Benchmark aborted"));
    };

    const dispatchAndWait = () => {
      eventBus.off("abort_requested", onAbort);
      // Register completion listener BEFORE emitting task so we can't miss it
      const onComplete = () => {
        clearTimeout(runTimer);
        resolve();
      };
      eventBus.once("app_ready", onComplete);
      // Dispatch — loop is guaranteed idle at this point
      eventBus.emit("task_start_requested", {
        type: "start_task",
        projectId,
        provider,
        mode: null,
        prompt,
        taskType,
        _benchmarkRun: true,
        _benchmarkScenarioId: scenarioId,
        _loopRestart: false,
      });
    };

    eventBus.once("abort_requested", onAbort);

    if (isLoopIdle()) {
      dispatchAndWait();
    } else {
      // Wait for loop to finish its current task and become idle
      eventBus.once("app_ready", dispatchAndWait);
    }
  });

  let sessionError = null;
  try {
    await completionPromise;
  } catch (err) {
    sessionError = err;
  }

  eventBus.off("system_message", onSysMsg);
  detachLogs();

  // --- Step 4: capture metrics (snapshot from session_complete, fallback to dashboardState) ---
  const turns = _metricsSnapshot?.turns ?? dashboardState.completedCount ?? 0;
  const tokenCount = _metricsSnapshot?.tokenCount ?? dashboardState.tokens ?? 0;
  const modifiedFiles = _metricsSnapshot?.modifiedFiles ?? (dashboardState.modifiedFiles ? [...dashboardState.modifiedFiles] : []);

  // --- Step 5: evaluate ---
  // Always run evaluation even after timeout — the fix may have been applied
  // correctly and the session only timed out during post-fix verification loops.
  let evalResult = { passed: false, passCount: 0, failCount: 0, output: "" };
  try {
    evalResult = await evaluateScenario(scenarioId);
  } catch (err) {
    if (!sessionError) sessionError = err;
  }

  const completedAt = Date.now();
  const durationMs = completedAt - startedAt;

  const phaseSummary = _phaseTimings.length > 0
    ? _phaseTimings.map((p, i) => ({
        phase: p.phase,
        startMs: p.t - startedAt,
        durationMs: i < _phaseTimings.length - 1 ? _phaseTimings[i + 1].t - p.t : completedAt - p.t,
      }))
    : null;

  // Write eval result and phase summary to log for post-run analysis
  const logStream2 = createWriteStream(logFile, { flags: "a" });
  logStream2.write(JSON.stringify({
    t: completedAt,
    type: "benchmark_eval",
    data: {
      passed: evalResult.passed,
      passCount: evalResult.passCount,
      failCount: evalResult.failCount,
      durationMs,
      turns,
      tokenCount,
      modifiedFiles,
      errorMsg: sessionError?.message || null,
      evalOutput: evalResult.output ? evalResult.output.slice(0, 2000) : null,
    },
  }) + "\n");
  if (phaseSummary) {
    logStream2.write(JSON.stringify({ t: completedAt, type: "benchmark_phases", data: phaseSummary }) + "\n");
  }
  logStream2.end();

  // --- Step 6: persist final result ---
  await updateRun(runId, {
    completedAt,
    passed: evalResult.passed,
    passCount: evalResult.passCount,
    failCount: evalResult.failCount,
    durationMs,
    turns,
    tokenCount,
    modifiedFiles,
    errorMsg: sessionError?.message || null,
    testResults: evalResult.tests ?? null,
    phaseSummary,
  });

  // Broadcast completion
  broadcast({
    type: "benchmark_run_complete",
    scenarioId,
    runId,
    passed: evalResult.passed,
    passCount: evalResult.passCount,
    failCount: evalResult.failCount,
    durationMs,
    turns,
    tokenCount,
    errorMsg: sessionError?.message || null,
  });
}

async function _failRun(runId, scenarioId, startedAt, errorMsg, logFile) {
  const completedAt = Date.now();
  await updateRun(runId, {
    completedAt,
    passed: false,
    passCount: 0,
    failCount: 1,
    durationMs: completedAt - startedAt,
    errorMsg,
  });
  broadcast({ type: "benchmark_run_complete", scenarioId, runId, passed: false, errorMsg });
}
