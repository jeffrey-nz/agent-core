import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { safeExec } from "#utils/exec.js";

/**
 * Runs after nextSubtaskNode on every subtask advance.
 * Pushes the branch to origin so progress is visible on GitHub immediately,
 * and closes the completed subtask's GitHub sub-issue so progress is tracked
 * natively on GitHub rather than via comment checklists.
 */
export async function subtaskProgressNode(state) {
  const { githubOptions, subtasks, currentSubtaskIndex, subtaskIssueMap, projectDir } = state;

  // currentSubtaskIndex has already been incremented by nextSubtaskNode.
  const completedIndex = (currentSubtaskIndex || 0) - 1;
  const totalCount = subtasks?.length || 0;
  const doneCount = currentSubtaskIndex || 0;

  // Push branch so GitHub always reflects the latest committed state
  if (projectDir) {
    try {
      const { stdout } = await safeExec("git rev-parse --abbrev-ref HEAD", { cwd: projectDir });
      const branchName = stdout?.trim();
      if (branchName && branchName !== "HEAD" && branchName !== "") {
        await safeExec(`git push -u origin ${branchName}`, { cwd: projectDir });
        log(colors.dim(`  [GitHub] Pushed ${branchName} after subtask ${doneCount}/${totalCount}`));
        eventBus.emit("github_activity", {
          action: "branch_pushed",
          branch: branchName,
          text: `Progress push after subtask ${doneCount}/${totalCount}`,
        });
      }
    } catch (err) {
      log(colors.dim(`  [GitHub] Intermediate push skipped: ${err.message}`));
    }
  }

  // Close the completed sub-issue on GitHub so progress shows natively
  if (githubOptions && subtasks?.length && completedIndex >= 0) {
    const completedSubtask = subtasks[completedIndex];
    const subIssueNumber = subtaskIssueMap?.[String(completedSubtask?.id)];
    const { client, owner, repo, issueNumber: parentIssueNumber } = githubOptions;

    if (subIssueNumber) {
      try {
        const { closeSubIssue } = await import("#github/subIssues.js");
        await closeSubIssue({ client, owner, repo, issueNumber: subIssueNumber });
        log(colors.dim(`  [GitHub] Closed sub-issue #${subIssueNumber} for subtask ${doneCount}/${totalCount}`));
        eventBus.emit("github_activity", {
          action: "subtask_closed",
          subIssueNumber,
          text: `Closed sub-issue #${subIssueNumber} (${doneCount}/${totalCount} complete)`,
        });
      } catch (err) {
        log(colors.dim(`  [GitHub] Sub-issue close skipped: ${err.message}`));
      }
    }

    // Post progress note to parent issue so the timeline is visible cross-session
    if (parentIssueNumber) {
      try {
        const { writeProgressNote } = await import("#github/context.js");
        await writeProgressNote({
          client,
          owner,
          repo,
          issueNumber: parentIssueNumber,
          completed: doneCount,
          total: totalCount,
          subtaskTitle: completedSubtask?.task || `Subtask ${doneCount}`,
          outcome: subIssueNumber ? "closed" : "skipped",
        });
      } catch {
        // Non-fatal
      }
    }
  }

  return {};
}
