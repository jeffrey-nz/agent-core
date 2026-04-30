import { logPhase } from "#app/ui/phases.js";
import { dashboardState, setDashboardState } from "#app/ui/dashboard.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { runScopingFlow } from "./flow/scoping/runScopingFlow.js";
import { resolveProjectTask } from "./flow/setup/projectTask.js";
import { initializeFlow } from "./flow/setup/flowInit.js";
import { runAgent } from "#agent/index.js";
import { askForHumanFeedback } from "./flow/humanFeedback.js";
import { finalizeSession } from "./flow/finalizeSession.js";
import { eventBus } from "#web/eventBus.js";
import { saveSegmentCheckpoint } from "./sessionState/io.js";
import { throwIfAborted } from "#utils/abort.js";
import { preUpgradeValidate, verifyUpgrade, verifySourceChecksum } from "#copilot/upgrade/index.js";
import { rollbackFilesystem } from "#copilot/run/main/applyFilesPhase/lib/rollback.js";

import { getGitChangedFiles, getHeadSha, hasProgressSince, getGitDiffStat } from "./report/gitStats.js";
import { runSmokeTests, formatSmokeFailures } from "./flow/smokeTest.js";
import { writePerformanceReport } from "#agent/sessionArchiver.js";
import { isLoopActive } from "#web/loopMode.js";
import { onSessionStart as githubSessionStart, isEnabled as githubEnabled } from "#github/sync.js";
import { getGithubClient, getGithubCoords } from "#github/client.js";

export async function runCopilotFlow(options = {}) {
  // Read dry-run and force flags from environment variables
  const dryRun = process.env.COPILOT_DRY_RUN === 'true';
  const force = process.env.COPILOT_FORCE === 'true';
  options = { ...options, dryRun, force };

  const flowStartTime = Date.now();
  const { targetRepoDir, projectDir, projectId, sessionInfo, contextDirs = [], signal } = options;
  const gitDir = targetRepoDir || projectDir;

  dashboardState.contextDirs = contextDirs;

  dashboardState.project = options.projectTitle || projectId || "Unknown";
  dashboardState.projectId = projectId;
  dashboardState.sessionId = sessionInfo?.sessionId || null;
  dashboardState.sessionTask = sessionInfo?.initialPrompt || null;
  dashboardState.sessionStartedAt =
    sessionInfo?.state?.startedAt || new Date().toISOString();

  // ── Pause gate ───────────────────────────────────────────────────────────────
  /** @type {Promise<void> | null} */ let _pauseGate = null;
  /** @type {(() => void) | null} */ let _pauseResolve = null;
  const onPause = () => {
    if (!_pauseResolve) {
      _pauseGate = new Promise((res) => { _pauseResolve = res; });
      eventBus.emit("execution_paused", {});
    }
  };
  const onPlay = () => {
    if (_pauseResolve) {
      _pauseResolve();
      _pauseResolve = null;
      _pauseGate = null;
    }
    eventBus.emit("execution_resumed", {});
  };
  eventBus.on("control_pause", onPause);
  eventBus.on("control_play", onPlay);

  const provider = await initializeFlow(options, gitDir);

  const requestId = sessionInfo?.sessionId || 'unknown';

  // Pre-upgrade backup
  const { createBackup } = await import('#copilot/upgrade/backup.js');
  const backupResult = await createBackup(gitDir, requestId);
  if (!backupResult.ok) {
    const errMsg = `Backup failed: ${backupResult.error}`;
    log(colors.red(errMsg));
    eventBus.emit("system_message", { text: `⚠ ${errMsg}`, type: "error" });
    await provider.close();
    throw new Error(errMsg);
  }

  const preValid = await preUpgradeValidate(gitDir, requestId, options.force);
  if (!preValid.ok) {
    const errMsg = `Pre-upgrade validation failed: ${JSON.stringify(preValid.checks)}`;
    log(colors.red(errMsg));
    eventBus.emit("system_message", { text: `⚠ ${errMsg}`, type: "error" });
    await provider.close();
    throw new Error(errMsg);
  }

  // Load config for checksum and validation command
  const { loadConfig } = await import('#config/loadConfig.js');
  const config = await loadConfig();
  if (config.source_checksum) {
    const checksumOk = await verifySourceChecksum(gitDir, config.source_checksum, requestId);
    if (!checksumOk) {
      const errMsg = `Source checksum mismatch. Expected ${config.source_checksum}`;
      log(colors.red(errMsg));
      eventBus.emit("system_message", { text: `⚠ ${errMsg}`, type: "error" });
      await provider.close();
      throw new Error(errMsg);
    }
  }

  const session = {
    provider,
    gitDir,
    close: async () => {
      if (provider.close) {
        await provider.close();
      }
    },
  };

  let segmentBoundaryHandler = null;
  if (options.providerName === "copilot365") {
    eventBus.emit("segment_start", { segmentIndex: 0 });
    segmentBoundaryHandler = (data) => {
      saveSegmentCheckpoint(projectId, sessionInfo.sessionId, data).catch(
        () => {},
      );
    };
    eventBus.on("copilot365_segment_boundary", segmentBoundaryHandler);
  }

  // Create feature branch and poll issues if GitHub integration is configured
  if (githubEnabled(options)) {
    try {
      const branchName = await githubSessionStart(options);
      if (branchName) options.githubBranch = branchName;
    } catch (err) {
      log(colors.yellow(`  [GitHub] Session start hook failed: ${err.message}`));
    }
  }

  // Build githubOptions for threading into graph nodes
  let githubOptions = null;
  {
    const ghClient = githubEnabled(options) ? getGithubClient(options.project) : null;
    const ghCoords = githubEnabled(options) ? getGithubCoords(options.project) : null;
    const ghIssueNumber = options.sessionInfo?.githubIssueNumber ?? null;
    if (ghClient && ghCoords && ghIssueNumber) {
      githubOptions = { client: ghClient, owner: ghCoords.owner, repo: ghCoords.repo, issueNumber: ghIssueNumber, branchName: options.githubBranch || null };
    }
  }

  // Resume probe: reconstruct subtasks + scope from GitHub if sub-issues exist
  let githubResumeState = null;
  if (githubOptions) {
    try {
      const { loadResumeState } = await import("#github/subIssues.js");
      githubResumeState = await loadResumeState(githubOptions);
      if (githubResumeState) {
        log(colors.cyan(`  [GitHub] Resuming from issue #${githubOptions.issueNumber}: ${githubResumeState.subtasks.length} subtasks, starting at index ${githubResumeState.startIndex}`));
      }
    } catch (err) {
      log(colors.yellow(`  [GitHub] Resume probe failed (non-fatal): ${err.message}`));
    }
  }

  try {
    // Loop restart tasks (_loopRestart: true) skip scoping entirely - the loop
    // prompt is used directly as the task so each iteration starts immediately.
    const isLoopRestart = !!options.sessionInfo?._loopRestart;
    const hasGithubScope = !!(githubResumeState?.scopeDoc);

    if (
      !isLoopRestart &&
      !hasGithubScope &&
      (sessionInfo.status === "scoping" || (sessionInfo.isNew && !sessionInfo.scopeDoc))
    ) {
      logPhase("PHASE 0.5", "SCOPING", "Defining requirements");
      setDashboardState({ phase: "SCOPING" });
      eventBus.emit("phase_change", { phase: "SCOPING", label: "Scoping" });

      const scopeDoc = await runScopingFlow({
        provider,
        project: options.project,
        initialPrompt: sessionInfo.initialPrompt || "",
        sessionId: sessionInfo.sessionId,
        projectId,
        qaHistory: sessionInfo.qaHistory || [],
        contextDirs,
        signal,
        githubIssueNumber: githubOptions?.issueNumber ?? null,
      });
      sessionInfo.scopeDoc = scopeDoc;
      sessionInfo.status = "approved";
      throwIfAborted(signal);
      await provider.startNewChat();
    }

    // Scope came from GitHub — inject it without re-running scoping Q&A
    if (hasGithubScope) {
      sessionInfo.scopeDoc = githubResumeState.scopeDoc;
      sessionInfo.status = "approved";
    }

    throwIfAborted(signal);
    setDashboardState({ phase: "EXECUTION" });
    eventBus.emit("phase_change", { phase: "EXECUTION", label: "Execution" });

    let currentTask = await resolveProjectTask(options);
    let projectComplete = false;

    // Inject GitHub board context so the AI knows what's already tracked
    if (githubEnabled(options)) {
      try {
        const { getBoardSummary } = await import("#github/projects.js");
        const summary = await getBoardSummary({
          client: getGithubClient(options.project),
          projectConfig: options.project,
        });
        if (summary) {
          currentTask = summary + "\n\n" + currentTask;
        }
      } catch {
        // Non-fatal
      }
    }

    const smokeUrls = options.project?.smokeTestUrls || [];

    if (smokeUrls.length > 0) {
      const { results } = await runSmokeTests(smokeUrls, {
        label: "Pre-check",
      });
      const httpFailures = results.filter((r) => !r.ok && !r.connectionError);
      const unreachable = results.filter((r) => !r.ok && r.connectionError);
      if (unreachable.length > 0) {
        log(
          colors.yellow(
            `  [Smoke] ${unreachable.length} route(s) unreachable (site may be down) - skipping smoke check for those.`,
          ),
        );
      }
      const failures = formatSmokeFailures(httpFailures);
      if (failures) {
        currentTask += `\n\n[SMOKE TEST - CURRENTLY FAILING ROUTES]\nThese pages are returning errors. Fix them:\n${failures}\n\nAfter your fix, these same routes will be re-tested automatically.`;
      }
    }

    while (!projectComplete) {
      const gate = _pauseGate; if (gate) await gate;
      throwIfAborted(signal);
      logPhase("PHASE 1", "AGENT EXECUTION", "LangGraph executing task");

      // Snapshot HEAD before the agent runs so we can detect commits made
      // during execution even after the graph auto-commits each subtask.
      const startSha = await getHeadSha(gitDir);

      const agentResumeState = githubResumeState
        ? { subtasks: githubResumeState.subtasks, currentSubtaskIndex: githubResumeState.startIndex, subtaskIssueMap: githubResumeState.map || {} }
        : (options.resumeState || null);

      const agentResult = await runAgent({
        ...options,
        task: currentTask,
        provider,
        projectDir: gitDir,
        contextDirs,
        signal,
        resumeState: agentResumeState,
        githubOptions,
      });

      // Extract reviewer verdicts from agent final state for GitHub integration
      if (agentResult?.state?.reviews?.length) {
        const verdicts = agentResult.state.reviews
          .map((r) => `- **${r.persona}**: ${r.status === "PASS" ? "✓ Approved" : "✗ Failed"} — ${r.feedback?.slice(0, 200) || ""}`)
          .join("\n");
        sessionInfo.reviewerVerdicts = `### AI Persona Review Results\n\n${verdicts}\n`;
      }
      if (agentResult?.state?.scopeDoc) {
        sessionInfo.dod = agentResult.state.scopeDoc.match(/##\s+Definition of done\s*\n([\s\S]*?)(?=\n##|$)/i)?.[1]?.trim() || null;
      }
      if (agentResult?.state?.subtaskIssueMap) {
        sessionInfo.subtaskIssueMap = agentResult.state.subtaskIssueMap;
      }

      // --- Post-agent verification and rollback ---
      // Benchmark runs use check.js as the authoritative verifier (already ran inside
      // the LangGraph verifierNode). Running npm test here would fail on benchmark
      // workspaces that have package.json but no "test" script, rolling back the fix.
      const touchedRoots = [gitDir, ...contextDirs];
      if (!sessionInfo._benchmarkRun) {
        const verification = await verifyUpgrade(gitDir, requestId, 60000, config.validation_command);
        if (!verification.ok) {
          log(colors.red(`Verification failed: npm test exited with non-zero code. Rolling back...`));
          await rollbackFilesystem(touchedRoots, 'verification_failure');
          await provider.close();
          return { ok: false, error: 'Verification failed, rollback performed' };
        }
      }

      // In multi-dir mode, progress counts if ANY repo has changes.
      const dirsToCheck = contextDirs.length > 1 ? contextDirs : [gitDir];
      const progressChecks = await Promise.all(
        dirsToCheck.map((d) => hasProgressSince(d, d === gitDir ? startSha : "")),
      );
      const madeProgress = progressChecks.some(Boolean);
      if (!madeProgress) {
        log(
          colors.yellow(
            "\n  [Warning] Agent completed but no file changes were detected (no new commits or uncommitted changes).\n",
          ),
        );
      }

      if (smokeUrls.length > 0) {
        const { results } = await runSmokeTests(smokeUrls, {
          label: "Post-check",
        });
        const httpFailures = results.filter((r) => !r.ok && !r.connectionError);
        if (httpFailures.length > 0) {
          log(
            colors.yellow(
              `  [Smoke] ${httpFailures.length} route(s) still failing after changes.`,
            ),
          );
        } else {
          log(colors.green("  [Smoke] All routes passing ✓"));
        }
      }

      // Aggregate diff stats from all repos in multi-dir mode.
      const diffStatParts = await Promise.all(dirsToCheck.map((d) => getGitDiffStat(d)));
      const diffStat = diffStatParts.filter(Boolean).join("\n");
      const feedback = (isLoopActive() || sessionInfo._benchmarkRun)
        ? ""
        : await askForHumanFeedback(options.rl, {
            diffStat,
            completedCount: dashboardState.completedCount || 0,
          });

      // If the user clicked Stop while the feedback prompt was open,
      // waitForResponse resolved with a cancel payload and the abort signal
      // is now set. Exit the loop cleanly rather than sending "BACK" to the AI.
      throwIfAborted(signal);

      if (
        !feedback ||
        feedback.toLowerCase() === "done" ||
        feedback.toLowerCase() === "exit"
      ) {
        projectComplete = true;
        break;
      }

      currentTask = `[HUMAN FEEDBACK]\nThe user reviewed the changes and provided this feedback:\n\n"${feedback}"\n\nPlease fix the issues mentioned.`;
    }

    // Write performance report before finalizing
    try {
      const stateForReport = {
        tokensSent: dashboardState.tokens || 0,
        tokensReceived: 0,
        subtasks: [],
        modifiedFiles: [],
        projectId: dashboardState.projectId
      };
      await writePerformanceReport(stateForReport, flowStartTime);
    } catch (err) {
      // Silently fail - don't let reporting crash the session
    }
    await finalizeSession(session, options);
    return true;
  } finally {
    eventBus.off("control_pause", onPause);
    eventBus.off("control_play", onPlay);
    if (_pauseResolve) { _pauseResolve(); _pauseResolve = null; }
    if (segmentBoundaryHandler) {
      eventBus.off("copilot365_segment_boundary", segmentBoundaryHandler);
    }
    await session.close().catch(() => {});
  }
}
