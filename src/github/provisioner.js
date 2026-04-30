/**
 * Auto-provisions GitHub resources for a project:
 * - Labels (copilot-task, copilot-in-progress, automated, needs-review)
 * - Projects v2 Kanban board with Status field (Backlog → Done)
 * - Local docs scaffold at {projectDir}/docs/ (no GitHub wiki required)
 *
 * Returns a detailed per-step result array so the UI can show what succeeded,
 * what was skipped, and what needs attention (e.g. missing token scopes).
 */

import fs from "fs/promises";
import path from "path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { ensureLabels } from "./issues.js";
import { findOrCreateProject } from "./projects.js";
import { initDocs } from "#docs/index.js";

const LABELS = [
  { name: "copilot-task",           color: "0075ca", description: "Task for Copilot Helper to pick up" },
  { name: "copilot-in-progress",    color: "e4e669", description: "Copilot Helper is working on this" },
  { name: "automated",              color: "cccccc", description: "Created or managed by automation" },
  { name: "needs-review",           color: "7057ff", description: "Awaiting human review" },
  { name: "type:code-change",       color: "0e8a16", description: "Code implementation task" },
  { name: "type:documentation",     color: "c5def5", description: "Documentation task" },
  { name: "type:investigation",     color: "e4e669", description: "Research or investigation task" },
  { name: "type:quick-edit",        color: "bfd4f2", description: "Small targeted edit" },
];

function classifyError(err) {
  const msg = err?.message || String(err);
  if (err?.status === 404 || msg.includes("404 Not Found")) {
    return {
      hint: "Repository not found. Either the repo doesn't exist yet (create it on GitHub first), or the token doesn't have access to it. For fine-grained PATs, make sure this repository is in the token's allowed repository list at github.com/settings/tokens.",
    };
  }
  if (err?.status === 403 || msg.includes("403") || msg.includes("Write access to repository not granted")) {
    return {
      hint: "Permission denied. For fine-grained PATs: ensure Contents (read/write) is enabled and this repo is in the token's allowed repository list.",
    };
  }
  if (msg.includes("Resource not accessible by personal access token") || msg.includes("not accessible")) {
    return {
      hint: "Token is missing the 'project' permission. For fine-grained PATs: add Projects (read/write) at github.com/settings/tokens. For classic PATs: add the 'project' scope.",
    };
  }
  if (msg.includes("Bad credentials") || err?.status === 401) {
    return { hint: "Invalid or expired GitHub token. Check GITHUB_TOKEN in your .env file." };
  }
  return { hint: null };
}

export async function provision({ client, coords, projectConfig, projectDir, targetRepoDir }) {
  const { owner, repo } = coords;
  const steps = [];

  log(colors.dim(`  [GitHub] Provisioning ${owner}/${repo}...`));

  // 0. Verify repo exists
  let repoData;
  try {
    repoData = await client.rest("GET", `/repos/${owner}/${repo}`);
    steps.push({ step: "repo", ok: true, message: `Repository ${owner}/${repo} found (${repoData.private ? "private" : "public"})` });
  } catch (err) {
    const { hint } = classifyError(err);
    const detail = hint ? ` — ${hint}` : ` — ${err.message}`;
    steps.push({ step: "repo", ok: false, message: `Cannot access repository${detail}` });
    log(colors.yellow(`  [GitHub] Repo check failed: ${err.message}`));
    // Can't continue if the repo isn't accessible
    return { steps, state: {} };
  }

  // 1. Labels
  try {
    await ensureLabels({ client, owner, repo, labelDefs: LABELS });
    steps.push({ step: "labels", ok: true, message: "Labels created/verified" });
    log(colors.dim(`  [GitHub] Labels ready`));
  } catch (err) {
    const { hint } = classifyError(err);
    steps.push({ step: "labels", ok: false, message: hint || err.message });
    log(colors.yellow(`  [GitHub] Label setup failed: ${err.message}`));
  }

  // 2. Projects v2 board
  let state = {};
  try {
    const viewer = await client.graphql(`query { viewer { login } }`);
    const login = viewer.viewer.login;
    state = await findOrCreateProject({ client, login, repoName: repo });
    steps.push({ step: "board", ok: true, message: `Kanban board ready (project #${state.projectNumber})` });
    log(colors.dim(`  [GitHub] Project board ready (number: ${state.projectNumber})`));
  } catch (err) {
    const { hint } = classifyError(err);
    steps.push({ step: "board", ok: false, message: hint || err.message });
    log(colors.yellow(`  [GitHub] Board setup failed: ${err.message}`));
  }

  // 3. Docs skeleton — init in target repo (preferred) or copilot-helper project dir
  const docsTarget = targetRepoDir || projectDir;
  if (docsTarget) {
    try {
      await initDocs({ projectDir: docsTarget, projectName: repo });
      steps.push({ step: "docs", ok: true, message: `Docs scaffold ready (${docsTarget}/docs/)` });
      log(colors.dim(`  [GitHub] Docs scaffold ready in ${docsTarget}`));
    } catch (err) {
      steps.push({ step: "docs", ok: false, message: err.message });
      log(colors.yellow(`  [GitHub] Docs scaffold failed: ${err.message}`));
    }
  }

  // 4. Write _state back to config.json (board IDs)
  if (state.projectId) {
    await writeStateToConfig({ projectDir, state });
    steps.push({ step: "config", ok: true, message: "State saved to config.json" });
  }

  return { steps, state };
}

async function writeStateToConfig({ projectDir, state }) {
  if (!projectDir) return;

  const configPath = path.join(projectDir, "config.json");
  try {
    let existing = {};
    try {
      existing = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {
      // File may not exist yet — will be created
    }

    existing.github = {
      ...(existing.github || {}),
      _state: {
        projectId: state.projectId,
        projectNumber: state.projectNumber,
        statusFieldId: state.statusFieldId,
        statusOptions: state.statusOptions || {},
      },
    };

    await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf8");
    log(colors.dim(`  [GitHub] State written to ${configPath}`));
  } catch (err) {
    log(colors.yellow(`  [GitHub] Could not write state to ${configPath}: ${err.message}`));
  }
}
