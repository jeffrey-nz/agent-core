import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { classifyEnvironmentError } from "#agent/utils/executionOutputAnalysis.js";
import { MAX_VERIFIER_RETRIES } from "#config/pipeline.js";

// Single source of truth from pipeline config — prevents silent drift between
// the verifier's force-advance threshold and the aggregator's stuck-analysis threshold.
const MAX_SUBTASK_RETRIES = MAX_VERIFIER_RETRIES;

// When the coder has already retried >= this threshold AND the only failing
// reviewer is Requirements (not Security), auto-advance rather than burning
// more turns. Security failures always block regardless of retry count.
const REQUIREMENTS_RETRY_FORGIVE_THRESHOLD = MAX_VERIFIER_RETRIES;

// When execution errors are ALL environment-level (DNS, permissions), the coder
// literally cannot satisfy the proof-of-fix requirement. Keep enough retries so
// the stuck analyzer gets a chance to diagnose and the coder can attempt a fix,
// but don't burn unlimited turns on an unwinnable loop.
const ENV_BLOCKED_FORGIVE_THRESHOLD = 5;

export async function aggregatorNode(state) {
  log(colors.magenta("  [Graph] -> ⚖️ Compiling Ensemble Reviews..."));

  // Circuit breaker: coder was blocked (target file not found) — no retry can
  // unblock it. Terminate cleanly rather than burning all 10 retry slots.
  if (state.sessionBlocked) {
    log(colors.yellow("  [Graph] -> ⚖️ Coder was blocked — terminating review loop immediately"));
    eventBus.emit("system_message", { text: "⚠ Task blocked (target file not found) — terminating without retry", type: "warning" });
    return { verificationFeedback: "STUCK_TERMINAL" };
  }

  const failedReviews = state.reviews.filter((r) => r.status === "FAIL");

  if (failedReviews.length > 0) {
    const newRetryCount = (state.coderRetryCount ?? 0) + 1;

    // If only the Requirements reviewer failed (not Security) and the coder has
    // already retried enough times, forgive the Requirements failure and advance.
    // This prevents the coder from being sent back for a pointless re-run of an
    // already-completed execution/validation subtask that the Security reviewer
    // approved but Requirements is being overly strict about.
    const onlyRequirementsFailed =
      failedReviews.length === 1 && failedReviews[0].persona === "Requirements";

    // Classify current execution errors to determine if we're in an env-blocked loop.
    const lastErrors = state.lastExecutionErrors || [];
    const allErrorsAreEnvironmental =
      lastErrors.length > 0 &&
      lastErrors.every((e) => classifyEnvironmentError(e.summary) !== null);

    // Never auto-advance if execution commands are actively failing with real
    // code errors — that means the underlying error is still present and unresolved.
    // Exception: if ALL errors are environment-level issues, the coder cannot fix
    // them; apply the lower threshold to prevent pointless retries.
    const hasActiveCodeErrors =
      lastErrors.length > 0 && !allErrorsAreEnvironmental;

    // Environment-blocked: lower threshold so we don't burn all retries on an
    // unwinnable loop (e.g. DNS doesn't resolve, assets permission denied).
    // Before approving, try the stuck analyzer once if not yet attempted.
    if (
      onlyRequirementsFailed &&
      allErrorsAreEnvironmental &&
      newRetryCount >= ENV_BLOCKED_FORGIVE_THRESHOLD
    ) {
      const envTypes = [...new Set(
        lastErrors.map((e) => classifyEnvironmentError(e.summary)?.type).filter(Boolean),
      )];
      if (!state.stuckAnalysisAttempted) {
        log(colors.yellow(
          `  [Graph] -> ⚖️ Environment-blocked (${envTypes.join(", ")}) — triggering stuck analyzer before advancing.`,
        ));
        eventBus.emit("system_message", { text: `⚠ Environment blocked (${envTypes.join(", ")}) — triggering stuck analyzer`, type: "warning" });
        return { verificationFeedback: "NEEDS_REANALYSIS", coderRetryCount: newRetryCount };
      }
      log(colors.yellow(
        `  [Graph] -> ⚖️ Environment-blocked (${envTypes.join(", ")}), stuck analysis already done. Auto-advancing.`,
      ));
      eventBus.emit("system_message", { text: `⚠ Environment blocked — auto-advancing past unwinnable loop`, type: "warning" });
      return { verificationFeedback: "APPROVED", coderRetryCount: 0 };
    }

    if (
      onlyRequirementsFailed &&
      !hasActiveCodeErrors &&
      newRetryCount >= REQUIREMENTS_RETRY_FORGIVE_THRESHOLD
    ) {
      if (!state.stuckAnalysisAttempted) {
        log(colors.yellow(
          `  [Graph] -> ⚖️ Requirements forgive threshold reached — triggering stuck analyzer before advancing.`,
        ));
        eventBus.emit("system_message", { text: `⚠ Requirements retry limit reached — triggering stuck analyzer`, type: "warning" });
        return { verificationFeedback: "NEEDS_REANALYSIS", coderRetryCount: newRetryCount };
      }
      log(colors.yellow(
        `  [Graph] -> ⚖️ Requirements reviewer failed, stuck analysis already done. Auto-advancing.`,
      ));
      eventBus.emit("system_message", { text: `⚠ Requirements retry limit — auto-advancing after stuck analysis`, type: "warning" });
      return { verificationFeedback: "APPROVED", coderRetryCount: 0 };
    }

    log(
      colors.red(
        `  [Graph] -> ⚖️ Rejected by ${failedReviews.length} expert(s). Retry ${newRetryCount}/${MAX_SUBTASK_RETRIES}.`,
      ),
    );
    eventBus.emit("system_message", { text: `✗ Rejected by ${failedReviews.length} reviewer(s) — retry ${newRetryCount}/${MAX_SUBTASK_RETRIES}`, type: "warning" });

    if (newRetryCount >= MAX_SUBTASK_RETRIES) {
      const stuckTask =
        state.subtasks?.[state.currentSubtaskIndex]?.task || "unknown subtask";

      // First exhaustion: route to the stuck analyzer for deep investigation
      // and a revised strategy. The coder gets a completely fresh round.
      if (!state.stuckAnalysisAttempted) {
        log(colors.yellow(
          `  [Graph] -> ⚖️ Subtask stuck after ${MAX_SUBTASK_RETRIES} retries — triggering Stuck Analyzer for deep re-investigation: "${stuckTask.slice(0, 60)}"`,
        ));
        eventBus.emit("system_message", { text: `⚠ Subtask stuck after ${MAX_SUBTASK_RETRIES} retries — triggering deep re-analysis`, type: "warning" });
        return { verificationFeedback: "NEEDS_REANALYSIS", coderRetryCount: newRetryCount };
      }

      // Second exhaustion (after reanalysis): now force-advance.
      log(colors.yellow(
        `  [Graph] -> ⚖️ Subtask still stuck after stuck analysis + ${MAX_SUBTASK_RETRIES} more retries. Force-advancing: "${stuckTask.slice(0, 60)}"`,
      ));
      eventBus.emit("system_message", { text: `⚠ Force-advancing past stuck subtask after deep analysis`, type: "warning" });

      const isLastSubtask =
        state.subtasks &&
        (state.currentSubtaskIndex || 0) >= state.subtasks.length - 1;

      if (isLastSubtask) {
        return {
          verificationFeedback: "STUCK_TERMINAL",
          coderRetryCount: 0,
          messages: [
            {
              role: "user",
              content: `[SYSTEM] Final subtask "${stuckTask}" could not be completed after deep re-analysis and ${MAX_SUBTASK_RETRIES * 2} total attempts. Marking job as complete with partial results.`,
            },
          ],
        };
      }

      return {
        verificationFeedback: "STUCK_ADVANCE",
        coderRetryCount: 0,
        currentSubtaskIndex: (state.currentSubtaskIndex || 0) + 1,
        messages: [
          {
            role: "user",
            content: `[SYSTEM] Subtask "${stuckTask}" could not pass review after deep re-analysis and ${MAX_SUBTASK_RETRIES * 2} total attempts. Proceeding to the next subtask.`,
          },
        ],
      };
    }

    let combinedFeedback =
      "[ENSEMBLE REVIEW FEEDBACK]\nYour code was rejected by our expert reviewers. You MUST fix the following issues:\n\n";
    failedReviews.forEach((r) => {
      combinedFeedback += `--- ${r.persona} Expert ---\n${r.feedback}\n\n`;
    });

    // Post a coder-response note to the issue so the review→fix loop is visible on GitHub.
    // This creates the thread: reviewer posts finding → coder responds with fix plan.
    if (state.githubOptions?.issueNumber) {
      try {
        const { writeCoderResponseNote } = await import("#github/context.js");
        const issueSummary =
          failedReviews.map((r) => `**${r.persona}**: ${r.feedback.slice(0, 200)}`).join("\n\n");
        await writeCoderResponseNote({
          client: state.githubOptions.client,
          owner: state.githubOptions.owner,
          repo: state.githubOptions.repo,
          issueNumber: state.githubOptions.issueNumber,
          retryCount: newRetryCount,
          summary: `Addressing ${failedReviews.length} review issue(s):\n\n${issueSummary}`,
        });
      } catch { /* non-fatal */ }
    }

    return {
      verificationFeedback: "REJECTED",
      coderRetryCount: newRetryCount,
      messages: [{ role: "user", content: combinedFeedback }],
    };
  }

  log(colors.green("  [Graph] -> ⚖️ All experts approved. Code is verified."));
  eventBus.emit("system_message", { text: "✓ All reviewers approved — subtask verified", type: "info" });
  return { verificationFeedback: "APPROVED", coderRetryCount: 0 };
}
