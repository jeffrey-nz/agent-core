import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";

export async function githubSyncNode(state) {
  const { githubOptions, subtasks, taskType } = state;
  if (!githubOptions || !subtasks?.length) return {};

  // scopeDoc: prefer human-confirmed scope (scopeDoc from webSetup),
  // then fall back to the agent scoper's output (scopeDocument).
  const effectiveScopeDoc = state.scopeDoc || state.scopeDocument || null;

  // researchReport: not a formal state field — derive from refined or raw research.
  const effectiveResearch = state.refinedResearch || state.researchSummary || null;

  const { client, owner, repo, issueNumber, branchName } = githubOptions;

  try {
    const { getIssue, updateIssue, addLabels } = await import("#github/issues.js");
    const { createSubIssues, upsertSubtasksInBody, upsertScopeInBody, upsertResearchInBody } = await import("#github/subIssues.js");

    // Apply task-type label so issues are categorised by work type
    if (taskType) {
      const typeLabel = `type:${taskType.replace(/_/g, "-")}`;
      await addLabels({ client, owner, repo, number: issueNumber, labels: [typeLabel] }).catch(() => {});
    }

    const issue = await getIssue({ client, owner, repo, number: issueNumber });
    let body = issue.body || "";

    // Upsert scope and/or research into the issue body so it stays current.
    // Only write scope block when we have actual scope content — never blank it.
    if (effectiveScopeDoc) {
      body = upsertScopeInBody(body, effectiveScopeDoc, effectiveResearch);
    } else if (effectiveResearch) {
      body = upsertResearchInBody(body, effectiveResearch);
    }

    const refs = await createSubIssues({ client, owner, repo, parentNumber: issueNumber, subtasks, branchName });

    const subtaskIssueMap = Object.fromEntries(
      refs.map(({ subtaskId, issueNumber: n }) => [String(subtaskId), n])
    );

    const newBody = upsertSubtasksInBody(body, subtasks, subtaskIssueMap);
    await updateIssue({ client, owner, repo, number: issueNumber, body: newBody });

    log(colors.dim(`  [GitHub] Created ${refs.length} sub-issues for #${issueNumber}`));

    if (refs.length > 0) {
      eventBus.emit("github_activity", {
        action: "subtasks_created",
        count: refs.length,
        issueNumber,
        subtaskNumbers: refs.map((r) => r.issueNumber),
      });
    }

    return { subtaskIssueMap };
  } catch (err) {
    log(colors.yellow(`  [GitHub] githubSyncNode skipped: ${err.message}`));
    return {};
  }
}
