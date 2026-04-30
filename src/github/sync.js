import path from "node:path";
import { getGithubClient, getGithubCoords } from "./client.js";
import { listIssues, addLabels, removeLabel } from "./issues.js";
import { buildStructuredIssueBody } from "./subIssues.js";
import { createPR, enableAutoMerge, requestReviewers, addLabelsToPR, enableRepoAutoMerge, buildPRBody } from "./pullRequests.js";
import { findOrCreateMilestone, setIssueMilestone, currentMonthMilestone } from "./milestones.js";
import { readContextNotes, formatContextForPrompt } from "./context.js";
import { createPRReview, listPRFiles, parseInlineComments } from "./pullRequests.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { safeExec } from "#utils/exec.js";

export function isEnabled(options) {
  const g = options.project?.github;
  return !!(g?.owner && g?.repo && getGithubClient(options.project));
}

function slugify(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 30)
    .replace(/-+$/, "");
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function onSessionStart(options) {
  if (!isEnabled(options)) return null;

  const g = options.project.github;
  const client = getGithubClient(options.project);
  const coords = getGithubCoords(options.project);
  const task = options.sessionInfo?.initialPrompt || "";

  // Auto-provision board/labels/wiki on first use.
  // The copilot-helper project folder (where config.json lives) is derived from
  // projectId (e.g. "opcorp/myapp" → projects/opcorp/myapp), NOT from targetRepoDir.
  const gitDir = options.targetRepoDir || options.projectDir;

  if (!g._state?.projectId) {
    try {
      const { provision } = await import("./provisioner.js");
      const copilotProjectDir = path.join(process.cwd(), "projects", options.projectId);
      const state = await provision({ client, coords, projectConfig: options.project, projectDir: copilotProjectDir, targetRepoDir: gitDir });
      // Reflect new _state in-memory so moveCard / wiki calls in this session work
      if (state?.projectId) {
        g._state = {
          projectId: state.projectId,
          projectNumber: state.projectNumber,
          statusFieldId: state.statusFieldId,
          statusOptions: state.statusOptions || {},
        };
        eventBus.emit("github_provisioned", { projectId: options.projectId, state: g._state });
      }
    } catch (err) {
      log(colors.yellow(`  [GitHub] Provisioning skipped: ${err.message}`));
    }
  }

  // Auto-create or find a GitHub issue for this session FIRST so the issue number
  // can be embedded in the branch name and commit messages for full traceability.
  let sessionIssueUrl = null;
  if (!options.sessionInfo?.githubIssueNumber && task && task.length > 5) {
    try {
      const { findOrCreateIssue } = await import("./issues.js");
      const label = g.taskLabel || "copilot-task";
      const { issue, existed } = await findOrCreateIssue({
        client,
        owner: coords.owner,
        repo: coords.repo,
        title: task.slice(0, 72),
        body: buildStructuredIssueBody(task),
        labels: [label, "automated"],
      });
      options.sessionInfo.githubIssueNumber = issue.number;
      sessionIssueUrl = issue.html_url;
      log(colors.dim(`  [GitHub] ${existed ? "Found" : "Created"} issue #${issue.number}: ${issue.title}`));
      eventBus.emit("github_activity", { action: existed ? "issue_linked" : "issue_created", number: issue.number, url: issue.html_url, title: issue.title });

      // Apply copilot-in-progress label so the issue is visually marked active
      try {
        await addLabels({ client, owner: coords.owner, repo: coords.repo, number: issue.number, labels: ["copilot-in-progress"] });
      } catch { /* non-fatal */ }

      // Link to current month milestone for sprint tracking
      try {
        const { title: msTitle, dueDate: msDue } = currentMonthMilestone();
        const { milestone } = await findOrCreateMilestone({ client, owner: coords.owner, repo: coords.repo, title: msTitle, dueDate: msDue });
        await setIssueMilestone({ client, owner: coords.owner, repo: coords.repo, number: issue.number, milestoneNumber: milestone.number });
        log(colors.dim(`  [GitHub] Issue #${issue.number} linked to milestone "${msTitle}"`));
      } catch { /* non-fatal */ }

      // Read context notes from prior sessions (progress, summaries, reviews) so the
      // AI has an accurate picture of what's already been attempted on this issue.
      try {
        const notes = await readContextNotes({ client, owner: coords.owner, repo: coords.repo, issueNumber: issue.number });
        const formatted = formatContextForPrompt(notes);
        if (formatted) {
          options.sessionInfo.issueContext = formatted;
          log(colors.dim(`  [GitHub] Loaded ${notes.length} context note(s) from issue #${issue.number}`));
        }
      } catch { /* non-fatal */ }
    } catch (err) {
      log(colors.yellow(`  [GitHub] Issue auto-create skipped: ${err.message}`));
    }
  }

  // Create feature branch — embed issue number so branch is visually linked to issue on GitHub
  const issueNum = options.sessionInfo?.githubIssueNumber;
  const slug = slugify(task) || options.projectId || "task";
  const branchName = issueNum
    ? `copilot/${todayStr()}-${issueNum}-${slug}`
    : `copilot/${todayStr()}-${slug}`;

  try {
    await safeExec(`git checkout -b ${branchName}`, { cwd: gitDir });
    log(colors.dim(`  [GitHub] Created branch: ${branchName}`));
    eventBus.emit("github_activity", { action: "branch_created", branch: branchName, repoUrl: `https://github.com/${coords.owner}/${coords.repo}` });
  } catch (err) {
    log(colors.yellow(`  [GitHub] Branch creation failed: ${err.message}`));
    eventBus.emit("system_message", { text: `⚠ GitHub branch creation failed: ${err.message.slice(0, 120)}`, type: "warning" });
    return null;
  }

  // Ensure docs scaffold exists in the target repo — commit any new skeleton files
  const issueRef = issueNum ? ` (#${issueNum})` : "";
  try {
    const { initDocs } = await import("#docs/index.js");
    await initDocs({ projectDir: gitDir, projectName: coords.repo });
    const { stdout } = await safeExec(`git status --porcelain docs/`, { cwd: gitDir });
    if (stdout?.trim()) {
      await safeExec(`git add docs/ && git commit -m "docs: init documentation scaffold${issueRef}"`, { cwd: gitDir });
      log(colors.dim(`  [GitHub] Docs scaffold committed`));
    }
  } catch {
    // Non-fatal
  }

  // Poll for open copilot-task issues and surface to frontend
  try {
    const label = g.taskLabel || "copilot-task";
    const issues = await listIssues({ client, owner: coords.owner, repo: coords.repo, labels: label });
    if (issues.length) {
      eventBus.emit("github_issues_available", {
        projectId: options.projectId,
        issues: issues.map((i) => ({ number: i.number, title: i.title, url: i.html_url, labels: i.labels?.map((l) => l.name) })),
      });
    }
  } catch {
    // Non-fatal: issue polling failures don't block the session
  }

  // If this session was started from an issue, move its card to "In Progress"
  if (options.sessionInfo?.githubIssueNumber) {
    try {
      const { moveCard } = await import("./projects.js");
      await moveCard({
        client,
        projectConfig: options.project,
        issueNumber: options.sessionInfo.githubIssueNumber,
        column: "In Progress",
      });
    } catch {
      // Non-fatal
    }
  }

  // Notify frontend so it can show branch + issue context during the session
  eventBus.emit("github_session_started", {
    projectId: options.projectId,
    branch: branchName,
    issueNumber: options.sessionInfo?.githubIssueNumber || null,
    issueUrl: sessionIssueUrl || null,
    repoUrl: `https://github.com/${coords.owner}/${coords.repo}`,
  });

  return branchName;
}

export async function onSessionEnd(options, { branchName, archiveData } = {}) {
  if (!isEnabled(options) || !branchName) return;

  const g = options.project.github;
  const client = getGithubClient(options.project);
  const coords = getGithubCoords(options.project);
  const gitDir = options.targetRepoDir || options.projectDir;

  // Append session log to docs/Sessions.md in the target repo before pushing,
  // so the entry lands on GitHub as part of this branch's PR.
  const task = options.sessionInfo?.initialPrompt || "";
  const prTitle = task.slice(0, 72) || `Copilot session ${todayStr()}`;
  try {
    const { appendSessionToDocs, initDocs } = await import("#docs/index.js");
    await initDocs({ projectDir: gitDir, projectName: coords.repo });
    await appendSessionToDocs({
      projectDir: gitDir,
      task: prTitle,
      prUrl: null,     // PR not created yet — will be updated when PR is known
      prNumber: null,
      modifiedFiles: archiveData?.modifiedFiles || [],
    });
    const { stdout } = await safeExec(`git status --porcelain docs/Sessions.md`, { cwd: gitDir });
    if (stdout?.trim()) {
      await safeExec(`git add docs/Sessions.md && git commit -m "docs: log session"`, { cwd: gitDir });
      log(colors.dim(`  [GitHub] Sessions.md committed`));
    }
  } catch {
    // Non-fatal
  }

  // Push branch (includes code changes + docs updates)
  try {
    await safeExec(`git push -u origin ${branchName}`, { cwd: gitDir });
    log(colors.dim(`  [GitHub] Pushed branch: ${branchName}`));
    eventBus.emit("github_activity", { action: "branch_pushed", branch: branchName, repoUrl: `https://github.com/${coords.owner}/${coords.repo}` });
  } catch (err) {
    log(colors.yellow(`  [GitHub] Push failed: ${err.message}`));
    eventBus.emit("system_message", { text: `⚠ GitHub push failed: ${err.message.slice(0, 120)}`, type: "warning" });
    return;
  }

  // Build PR
  const prBody = buildPRBody({
    task,
    completionSummary: archiveData?.completionSummary,
    modifiedFiles: archiveData?.modifiedFiles || [],
    decisions: archiveData?.decisions || [],
    issueNumber: options.sessionInfo?.githubIssueNumber,
    subIssueNumbers: archiveData?.subIssueNumbers || [],
    scopeDoc: archiveData?.scopeDoc || null,
    dod: archiveData?.dod || null,
    reviewerVerdicts: archiveData?.reviewerVerdicts || null,
  });

  // Check if a PR already exists for this exact head branch (e.g. session retry after failure).
  // Creating a second PR for the same branch is rejected by GitHub anyway, but we catch it
  // early so we can update the existing PR with new content instead of erroring out.
  let pr;
  let isExistingPR = false;
  try {
    const openPRs = await client.rest("GET", `/repos/${coords.owner}/${coords.repo}/pulls?state=open&head=${coords.owner}:${branchName}&per_page=5`).catch(() => []);
    const existing = Array.isArray(openPRs) ? openPRs.find((p) => p.head?.ref === branchName) : null;
    if (existing) {
      pr = existing;
      isExistingPR = true;
      log(colors.dim(`  [GitHub] PR #${pr.number} already exists for branch ${branchName} — updating instead of creating new.`));
      // Update the PR body with new content
      try {
        await client.rest("PATCH", `/repos/${coords.owner}/${coords.repo}/pulls/${pr.number}`, { body: prBody });
      } catch { /* non-fatal */ }
      eventBus.emit("github_activity", { action: "pr_updated", number: pr.number, url: pr.html_url, title: prTitle, branch: branchName });
    }
  } catch { /* non-fatal — fall through to create */ }

  if (!pr) {
    try {
      pr = await createPR({
        client,
        owner: coords.owner,
        repo: coords.repo,
        head: branchName,
        base: g.baseBranch || "main",
        title: prTitle,
        body: prBody,
      });
      log(colors.green(`  [GitHub] PR created: ${pr.html_url}`));
      eventBus.emit("github_activity", { action: "pr_created", number: pr.number, url: pr.html_url, title: prTitle, branch: branchName });
    } catch (err) {
      log(colors.yellow(`  [GitHub] PR creation failed: ${err.message}`));
      eventBus.emit("system_message", { text: `⚠ GitHub PR creation failed: ${err.message.slice(0, 120)}`, type: "warning" });
      return;
    }
  }

  // Remove in-progress label and add needs-review to the issue
  const issueForLabels = options.sessionInfo?.githubIssueNumber;
  if (issueForLabels) {
    await removeLabel({ client, owner: coords.owner, repo: coords.repo, number: issueForLabels, label: "copilot-in-progress" })
      .catch((err) => log(colors.dim(`  [GitHub] removeLabel skipped: ${err.message}`)));
    await addLabels({ client, owner: coords.owner, repo: coords.repo, number: issueForLabels, labels: ["needs-review"] })
      .catch((err) => log(colors.dim(`  [GitHub] addLabels(issue) skipped: ${err.message}`)));
  }

  // Labels + reviewers
  await addLabelsToPR({ client, owner: coords.owner, repo: coords.repo, prNumber: pr.number, labels: ["automated", "needs-review"] })
    .catch((err) => log(colors.dim(`  [GitHub] addLabelsToPR skipped: ${err.message}`)));
  if (g.reviewers?.length) {
    await requestReviewers({ client, owner: coords.owner, repo: coords.repo, prNumber: pr.number, reviewers: g.reviewers })
      .catch((err) => log(colors.dim(`  [GitHub] requestReviewers skipped: ${err.message}`)));
  }

  // Auto-merge
  if (g.autoMerge) {
    try {
      await enableRepoAutoMerge({ client, owner: coords.owner, repo: coords.repo });
      await enableAutoMerge({ client, prNodeId: pr.node_id, mergeMethod: "SQUASH" });
      log(colors.dim(`  [GitHub] Auto-merge enabled on PR #${pr.number}`));
    } catch (err) {
      log(colors.yellow(`  [GitHub] Auto-merge setup failed: ${err.message}`));
    }
  }

  // Post a formal GitHub PR review (APPROVE or COMMENT) with AI reviewer verdicts.
  // This creates a proper GitHub review thread visible on the PR — human reviewers
  // can see the AI panel's findings alongside their own review.
  if (archiveData?.reviewerVerdicts) {
    try {
      const allPassed = !archiveData.reviewerVerdicts.includes("✗ Failed");
      const event = allPassed ? "APPROVE" : "COMMENT";

      // Attempt inline comments: parse reviewer feedback for file:line patterns
      let inlineComments = [];
      try {
        const prFiles = await listPRFiles({ client, owner: coords.owner, repo: coords.repo, prNumber: pr.number });
        inlineComments = parseInlineComments(archiveData.reviewerVerdicts, prFiles);
      } catch { /* non-fatal — fall back to body-only review */ }

      await createPRReview({
        client,
        owner: coords.owner,
        repo: coords.repo,
        prNumber: pr.number,
        body: `## 🤖 AI Peer Review\n\n${archiveData.reviewerVerdicts}`,
        event,
        comments: inlineComments,
      });
      const inlineSuffix = inlineComments.length ? ` with ${inlineComments.length} inline comment(s)` : "";
      log(colors.dim(`  [GitHub] Posted formal PR review (${event}) on PR #${pr.number}${inlineSuffix}`));
      eventBus.emit("github_activity", {
        action: "reviewer_comment_posted",
        issueNumber: options.sessionInfo?.githubIssueNumber,
        prNumber: pr?.number,
        event,
        inlineCount: inlineComments.length,
        text: `PR #${pr.number} ${event === "APPROVE" ? "approved ✓" : "reviewed"} by AI${inlineSuffix}`,
      });
    } catch (err) {
      log(colors.yellow(`  [GitHub] PR review post failed: ${err.message}`));
    }
  }

  // Also post verdict summary as issue comment for visibility before PR merge
  const issueForComment = options.sessionInfo?.githubIssueNumber;
  if (issueForComment && archiveData?.reviewerVerdicts) {
    try {
      const { writeApprovalNote } = await import("./context.js");
      const allPassed = !archiveData.reviewerVerdicts.includes("✗ Failed");
      if (allPassed) {
        await writeApprovalNote({ client, owner: coords.owner, repo: coords.repo, issueNumber: issueForComment });
      }
    } catch { /* non-fatal */ }
  }

  // Move Kanban card to Review
  try {
    const issueNumber = options.sessionInfo?.githubIssueNumber;
    if (issueNumber) {
      const { moveCard } = await import("./projects.js");
      await moveCard({ client, projectConfig: options.project, issueNumber, column: "Review" });
    }
  } catch {
    // Non-fatal
  }

  // Trigger configured workflow
  if (g.actionsWorkflow) {
    try {
      const { triggerWorkflow } = await import("./actions.js");
      await triggerWorkflow({ client, owner: coords.owner, repo: coords.repo, workflow: g.actionsWorkflow, ref: g.baseBranch || "main" });
      log(colors.dim(`  [GitHub] Triggered workflow: ${g.actionsWorkflow}`));
    } catch {
      // Non-fatal
    }
  }

  // Notify frontend
  eventBus.emit("github_pr_created", {
    projectId: options.projectId,
    pr: { number: pr.number, title: prTitle, url: pr.html_url, branch: branchName },
  });
}
