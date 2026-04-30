import { clearSessionState } from "../sessionState/index.js";
import { generateSuccessReport } from "../report/index.js";
import { writeHandoffReport } from "../handoff.js";
import { getGitChangedFiles } from "../report/gitStats.js";
import { onSessionEnd as githubSessionEnd, isEnabled as githubEnabled } from "#github/sync.js";

export async function finalizeSession(session, options) {
  await clearSessionState(options.projectId, options.sessionInfo.sessionId);

  const changedFilesOutput = await getGitChangedFiles(
    session.gitDir || options.projectDir,
  );

  const appliedCount = changedFilesOutput
    ? changedFilesOutput.trim().split("\n").filter(Boolean).length
    : 0;

  await generateSuccessReport({
    copilot: session.provider,
    gitDir: session.gitDir,
    projectId: options.projectId,
    projectDir: options.projectDir,
    projectTitle: options.projectTitle,
    promptText: options.promptText,
    applyRes: { applied: appliedCount },
  });

  await writeHandoffReport(options.projectId, session.provider, null, options);

  if (options.project && typeof options.project.afterSubmit === "function") {
    await options.project.afterSubmit(options);
  }

  if (githubEnabled(options) && options.githubBranch) {
    try {
      const modifiedFiles = changedFilesOutput
        ? changedFilesOutput.trim().split("\n").filter(Boolean)
        : [];
      const subtaskIssueMap = options.sessionInfo?.subtaskIssueMap || {};
      const subIssueNumbers = Object.values(subtaskIssueMap).filter(Boolean);

      // Post a session summary comment to the parent issue for cross-session context
      const issueNumber = options.sessionInfo?.githubIssueNumber;
      if (issueNumber) {
        try {
          const { getGithubClient, getGithubCoords } = await import("#github/client.js");
          const { writeSessionSummary } = await import("#github/context.js");
          const client = getGithubClient(options.project);
          const coords = getGithubCoords(options.project);
          const allPassed = !options.sessionInfo?.reviewerVerdicts?.includes("✗ Failed");
          const outcome = allPassed ? "APPROVED" : "PARTIAL";
          const subtaskCount = Object.keys(subtaskIssueMap).length;
          await writeSessionSummary({
            client,
            owner: coords.owner,
            repo: coords.repo,
            issueNumber,
            outcome,
            completedCount: subtaskCount,
            totalCount: subtaskCount,
            prNumber: null, // PR number not yet known at this point
            modifiedFiles,
          });
        } catch {
          // Non-fatal
        }
      }

      await githubSessionEnd(options, {
        branchName: options.githubBranch,
        archiveData: {
          modifiedFiles,
          subIssueNumbers,
          scopeDoc: options.sessionInfo?.scopeDoc || null,
          dod: options.sessionInfo?.dod || null,
          reviewerVerdicts: options.sessionInfo?.reviewerVerdicts || null,
          completionSummary: options.sessionInfo?.completionSummary || null,
        },
      });
    } catch {
      // Non-fatal: GitHub sync failure must not abort session finalization
    }
  }
}
