/**
 * GitHub cleanup phase — runs at the end of each auto-mode cycle.
 *
 * What it does (conservative, non-destructive):
 *  1. Delete copilot/* branches whose PR has been merged or closed.
 *  2. Close copilot-task issues whose linked PR has been merged (resolved).
 *  3. Close copilot/* branches that are more than 30 days old with no open PR.
 *  4. Report a summary via system_message.
 */

import { getGithubClient, getGithubCoords } from "./client.js";
import { listBranches, deleteBranch, listIssues, updateIssue, removeLabel } from "./issues.js";
import { listPRs } from "./pullRequests.js";
import { getBoard } from "./projects.js";
import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

const COPILOT_BRANCH_PREFIX = "copilot/";
const STALE_BRANCH_DAYS = 30;
const STALE_MS = STALE_BRANCH_DAYS * 24 * 60 * 60 * 1000;

/**
 * Run the cleanup phase for a project.
 * @param {object} projectConfig — the merged project config (has .github.{owner,repo,token,taskLabel})
 * @returns {{ deletedBranches: string[], closedIssues: number[], errors: string[] }}
 */
export async function runCleanupPhase(projectConfig) {
  const client = getGithubClient(projectConfig);
  if (!client) return null;

  const coords = getGithubCoords(projectConfig);
  if (!coords) return null;

  const { owner, repo } = coords;
  const taskLabel = projectConfig?.github?.taskLabel || "copilot-task";

  const deletedBranches = [];
  const closedIssues = [];
  const errors = [];

  log(colors.cyan(`\n  [Cleanup] Starting GitHub cleanup for ${owner}/${repo}…`));

  const projectId = projectConfig?.github?._state?.projectId;

  try {
    // ── 1. Fetch all data in parallel ───────────────────────────────────────
    const [allBranches, allPRs, openIssues, board] = await Promise.all([
      listBranches({ client, owner, repo, prefix: COPILOT_BRANCH_PREFIX }).catch(() => []),
      listPRs({ client, owner, repo, state: "all" }).catch(() => []),
      listIssues({ client, owner, repo, labels: taskLabel, state: "open", limit: 100 }).catch(() => []),
      projectId ? getBoard({ client, projectId }).catch(() => null) : Promise.resolve(null),
    ]);

    // Build a map: branch name → PR (most recent PR targeting that branch)
    const branchToPR = new Map();
    for (const pr of allPRs) {
      const head = pr.head?.ref;
      if (!head || !head.startsWith(COPILOT_BRANCH_PREFIX)) continue;
      // Keep the most recent PR for each branch (they're returned newest-first).
      if (!branchToPR.has(head)) branchToPR.set(head, pr);
    }

    // ── 2. Delete stale / resolved branches ─────────────────────────────────
    for (const branchName of allBranches) {
      try {
        const pr = branchToPR.get(branchName);

        // If there's a merged or closed PR → branch is no longer needed.
        if (pr && (pr.state === "closed")) {
          await deleteBranch({ client, owner, repo, branchName });
          deletedBranches.push(branchName);
          log(colors.dim(`  [Cleanup] Deleted branch: ${branchName} (PR #${pr.number} ${pr.merged_at ? "merged" : "closed"})`));
          continue;
        }

        // No PR at all — check if the branch is stale (older than threshold).
        if (!pr) {
          const branchDetails = await client.rest("GET", `/repos/${owner}/${repo}/branches/${encodeURIComponent(branchName)}`).catch(() => null);
          if (!branchDetails) continue;
          const lastCommitDate = new Date(branchDetails.commit?.commit?.committer?.date || branchDetails.commit?.commit?.author?.date || 0);
          if (Date.now() - lastCommitDate.getTime() > STALE_MS) {
            await deleteBranch({ client, owner, repo, branchName });
            deletedBranches.push(branchName);
            log(colors.dim(`  [Cleanup] Deleted stale branch: ${branchName} (no PR, ${STALE_BRANCH_DAYS}d+ old)`));
          }
        }
      } catch (err) {
        // Branch may already be deleted or protected — non-fatal.
        if (!err.message?.includes("Reference does not exist") && err.status !== 404) {
          errors.push(`branch ${branchName}: ${err.message}`);
        }
      }
    }

    // ── 3. Close issues resolved by a merged PR ──────────────────────────────
    for (const issue of openIssues) {
      try {
        // Find PRs that reference this issue number in their body ("Closes #N").
        const closingPR = allPRs.find((pr) => {
          if (pr.state !== "closed" || !pr.merged_at) return false;
          const body = pr.body || "";
          return (
            body.match(new RegExp(`Closes\\s+#${issue.number}\\b`, "i")) ||
            body.match(new RegExp(`Fixes\\s+#${issue.number}\\b`, "i")) ||
            body.match(new RegExp(`Resolves\\s+#${issue.number}\\b`, "i"))
          );
        });

        if (closingPR) {
          await updateIssue({ client, owner, repo, number: issue.number, state: "closed" });
          closedIssues.push(issue.number);
          log(colors.dim(`  [Cleanup] Closed issue #${issue.number} (resolved by merged PR #${closingPR.number})`));

          // Move board card to "Done" so the Kanban reflects the merge
          try {
            const { moveCard } = await import("./projects.js");
            await moveCard({ client, projectConfig, issueNumber: issue.number, column: "Done" });
          } catch { /* non-fatal */ }

          // Remove stale in-progress/review labels now the issue is resolved
          for (const staleLabel of ["copilot-in-progress", "needs-review"]) {
            await removeLabel({ client, owner, repo, number: issue.number, label: staleLabel }).catch(() => {});
          }
        }
      } catch (err) {
        errors.push(`issue #${issue.number}: ${err.message}`);
      }
    }

    // ── 4. Move "Review" cards to "Done" for already-merged PRs ────────────────
    // The board card may still be in "Review" even though the PR merged — GitHub
    // doesn't automatically move project cards on PR merge.
    const reviewCol = board?.columns?.find((c) => c.name === "Review");
    if (reviewCol && reviewCol.items.length > 0) {
      for (const item of reviewCol.items) {
        const issueNum = item.content?.number;
        if (!issueNum) continue;
        try {
          // Check if there's a merged PR for this issue
          const mergedPR = allPRs.find(
            (pr) =>
              pr.merged_at &&
              new RegExp(`Closes\\s+#${issueNum}\\b`, "i").test(pr.body || ""),
          );
          if (mergedPR) {
            const { moveCard } = await import("./projects.js");
            await moveCard({ client, projectConfig, issueNumber: issueNum, column: "Done" });
            log(colors.dim(`  [Cleanup] Moved #${issueNum} card to Done (PR #${mergedPR.number} already merged)`));
          }
        } catch { /* non-fatal */ }
      }
    }
  } catch (err) {
    errors.push(`cleanup phase: ${err.message}`);
    log(colors.yellow(`  [Cleanup] Error during cleanup: ${err.message}`));
  }

  // ── 4. Emit summary ────────────────────────────────────────────────────────
  const parts = [];
  if (deletedBranches.length > 0) parts.push(`${deletedBranches.length} branch${deletedBranches.length > 1 ? "es" : ""} deleted`);
  if (closedIssues.length > 0) parts.push(`${closedIssues.length} issue${closedIssues.length > 1 ? "s" : ""} closed`);

  if (parts.length > 0) {
    const summary = `♻ Cleanup: ${parts.join(", ")}`;
    log(colors.green(`  [Cleanup] ${summary}`));
    eventBus.emit("system_message", { text: summary, type: "info" });
    eventBus.emit("pm_update", { text: summary, level: "cleanup" });
  } else {
    log(colors.dim("  [Cleanup] Nothing to clean up."));
  }

  if (errors.length > 0) {
    log(colors.yellow(`  [Cleanup] ${errors.length} non-fatal error(s): ${errors.slice(0, 3).join("; ")}`));
  }

  return { deletedBranches, closedIssues, errors };
}
