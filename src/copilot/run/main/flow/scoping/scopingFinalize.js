import { saveScopingState } from "./state.js";
import { forceScopeGeneration } from "./fallback.js";

export async function finalizeScoping({
  provider,
  project,
  projectId,
  sessionId,
  initialPrompt,
  qaHistory,
  scopeDoc,
  research = null,
  state = null, // optional graph state to inject scopeDoc
  githubIssueNumber = null,
}) {
  const targetRepoDir = project?.targetRepoDir || null;

  let finalScope = scopeDoc;

  if (!finalScope) {
    finalScope = await forceScopeGeneration(
      provider,
      targetRepoDir,
      initialPrompt,
    );
  }

  // If a graph state object was provided, inject the final scope document
  // so that downstream nodes (e.g., verifier) can access the Definition of done.
  if (state && typeof state === 'object') {
    state.scopeDoc = finalScope;
  }

  await saveScopingState(
    projectId,
    sessionId,
    initialPrompt,
    qaHistory,
    finalScope,
  );

  // Update GitHub issue body with scope + research sections
  if (githubIssueNumber && project?.github) {
    try {
      const { getGithubClient, getGithubCoords } = await import("#github/client.js");
      const { getIssue, updateIssue } = await import("#github/issues.js");
      const { upsertScopeInBody } = await import("#github/subIssues.js");
      const client = getGithubClient(project);
      const coords = getGithubCoords(project);
      if (client && coords) {
        const issue = await getIssue({ client, owner: coords.owner, repo: coords.repo, number: githubIssueNumber });
        const newBody = upsertScopeInBody(issue.body || "", finalScope, research?.report || null);
        await updateIssue({ client, owner: coords.owner, repo: coords.repo, number: githubIssueNumber, body: newBody });
        const { eventBus } = await import("#web/eventBus.js");
        eventBus.emit("github_activity", { action: "scope_updated", issueNumber: githubIssueNumber });
      }
    } catch { /* non-fatal */ }
  }

  // Write scope + research docs to target repo feature branch
  if (targetRepoDir && finalScope) {
    try {
      const { writePage, readPage } = await import("#docs/index.js");
      const { safeExec } = await import("#utils/exec.js");
      const date = new Date().toISOString().slice(0, 10);

      await writePage({
        projectDir: targetRepoDir,
        page: "Scope",
        content: `# Session Scope\n\n**Date:** ${date}\n**Task:** ${initialPrompt}\n\n## Defined Scope\n\n${finalScope}`,
      });

      if (research?.report) {
        const existing = (await readPage({ projectDir: targetRepoDir, page: "Research" })) || "# Research\n\nResearch findings and investigations.\n\n| Topic | Summary | Date |\n|-------|---------|------|\n";
        const entry = `\n## ${date} — ${initialPrompt.slice(0, 60)}\n\n${research.report}\n`;
        await writePage({ projectDir: targetRepoDir, page: "Research", content: existing.trimEnd() + entry });
      }

      const { stdout } = await safeExec(`git status --porcelain docs/`, { cwd: targetRepoDir }).catch(() => ({ stdout: "" }));
      if (stdout?.trim()) {
        await safeExec(`git add docs/Scope.md docs/Research.md && git commit -m "docs: record scope and research"`, { cwd: targetRepoDir }).catch(() => {});
      }
    } catch {
      // Non-fatal
    }
  }

  return finalScope;
}
