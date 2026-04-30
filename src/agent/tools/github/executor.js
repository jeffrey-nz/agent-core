/**
 * Executor for GitHub AI agent tools.
 *
 * context.projectConfig is injected by the dispatcher via __context_projectConfig.
 * Falls back to process.env.GITHUB_TOKEN when no per-project token is set.
 */

import { getGithubClient, getGithubCoords, makeGithubClient } from "#github/client.js";
import { safeExec } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { createIssue, updateIssue, addComment, listIssues, findOrCreateIssue } from "#github/issues.js";
import { moveCard } from "#github/projects.js";
import { writePage } from "#docs/index.js";
import { triggerWorkflow } from "#github/actions.js";
import { createToolDispatcher } from "../dispatcher.js";

function parseRemoteUrl(remoteUrl) {
  const m = remoteUrl?.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function resolveClientAndCoords(ctx) {
  // Prefer explicit project config
  let client = getGithubClient(ctx.projectConfig);
  let coords = getGithubCoords(ctx.projectConfig);

  // Fallback: parse git remote origin
  if ((!client || !coords) && ctx.rootDir) {
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      client = makeGithubClient(token);
      const res = await safeExec("git remote get-url origin", { cwd: ctx.rootDir }).catch(() => null);
      if (res?.stdout) coords = parseRemoteUrl(res.stdout.trim());
    }
  }

  return { client, coords };
}

async function handleCreateIssue(input, ctx) {
  const { client, coords } = await resolveClientAndCoords(ctx);
  if (!client || !coords) return "[ERROR] GitHub not configured for this project.";

  const { issue, existed } = await findOrCreateIssue({
    client,
    owner: coords.owner,
    repo: coords.repo,
    title: input.title,
    body: input.body || "",
    labels: input.labels || ["automated"],
  });

  if (!existed) {
    await moveCard({ client, projectConfig: ctx.projectConfig, issueNumber: issue.number, column: "Backlog" }).catch(() => {});
  }

  return existed
    ? `Issue #${issue.number} already exists: ${issue.html_url}`
    : `Created issue #${issue.number}: ${issue.html_url}`;
}

async function handleUpdateIssue(input, ctx) {
  const { client, coords } = await resolveClientAndCoords(ctx);
  if (!client || !coords) return "[ERROR] GitHub not configured for this project.";

  if (input.comment) {
    await addComment({ client, owner: coords.owner, repo: coords.repo, number: input.issue_number, body: input.comment });
  }

  if (input.close) {
    await updateIssue({ client, owner: coords.owner, repo: coords.repo, number: input.issue_number, state: "closed" });
  }

  return `Issue #${input.issue_number} updated.`;
}

async function handleGetIssues(input, ctx) {
  const { client, coords } = await resolveClientAndCoords(ctx);
  if (!client || !coords) return "[ERROR] GitHub not configured for this project.";

  const issues = await listIssues({
    client,
    owner: coords.owner,
    repo: coords.repo,
    labels: input.label,
    limit: input.limit || 20,
  });

  if (!issues.length) return "No open issues found.";

  return issues
    .map((i) => `#${i.number} [${(i.labels || []).map((l) => l.name).join(", ")}] ${i.title} — ${i.html_url}`)
    .join("\n");
}

async function handleWriteDocsPage(input, ctx) {
  const projectDir = ctx.rootDir;
  if (!projectDir) return "[ERROR] No project directory available.";

  await writePage({ projectDir, page: input.page, content: input.content });

  // Auto-commit the doc to the current git branch so it's pushed to GitHub
  const relPath = `docs/${input.page}.md`;
  const { stdout } = await safeExec(`git status --porcelain "${relPath}"`, { cwd: projectDir }).catch(() => ({ stdout: '' }));
  if (stdout?.trim()) {
    await safeExec(`git add "${relPath}" && git commit -m "docs: update ${input.page}"`, { cwd: projectDir }).catch(() => {});
    log(`  [docs] Committed ${relPath}`);
  }

  return `Docs page '${input.page}' written and committed.`;
}

async function handleMoveCard(input, ctx) {
  const { client } = await resolveClientAndCoords(ctx);
  if (!client) return "[ERROR] GitHub not configured for this project.";

  await moveCard({
    client,
    projectConfig: ctx.projectConfig,
    issueNumber: input.issue_number,
    column: input.column,
  });

  return `Issue #${input.issue_number} moved to '${input.column}'.`;
}

async function handleTriggerWorkflow(input, ctx) {
  const { client, coords } = await resolveClientAndCoords(ctx);
  if (!client || !coords) return "[ERROR] GitHub not configured for this project.";

  await triggerWorkflow({
    client,
    owner: coords.owner,
    repo: coords.repo,
    workflow: input.workflow,
    ref: input.ref || "main",
    inputs: input.inputs,
  });

  return `Workflow '${input.workflow}' triggered on ${input.ref || "main"}.`;
}

const githubHandlers = {
  github_create_issue: handleCreateIssue,
  github_update_issue: handleUpdateIssue,
  github_get_issues: handleGetIssues,
  docs_write_page: handleWriteDocsPage,
  github_move_card: handleMoveCard,
  github_trigger_workflow: handleTriggerWorkflow,
};

export const executeGithubTool = createToolDispatcher(githubHandlers);
