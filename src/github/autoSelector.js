/**
 * AI project manager — selects the next task from GitHub state.
 *
 * Priority tiers (evaluated in order, short-circuiting):
 *   Tier 1 (deterministic): copilot/* PRs with CHANGES_REQUESTED reviews
 *   Tier 2 (deterministic): Issues "In Progress" with no open PR (interrupted sessions)
 *   Tier 3 (LLM): Pick highest-priority Backlog issue, or generic improvement
 *
 * This means existing work is always resolved before new work is created.
 */

import { getGithubClient, getGithubCoords } from "./client.js";
import { listIssues } from "./issues.js";
import { listPRReviews, listPRReviewComments } from "./pullRequests.js";
import { getBoard } from "./projects.js";
import { createProvider } from "#providers/factory.js";
import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

const FALLBACK_PROMPT =
  "Review the codebase for bugs, runtime errors, edge cases, missing error handling, and security issues. Fix any you find.";

// Used only for Tier 3 (backlog selection). Tiers 1 and 2 are deterministic.
const SYSTEM_PROMPT = `You are an AI project manager. Given a summary of the current GitHub project state, choose the single highest-priority task to work on next.

Selection rules:
- Prefer issues in the Backlog column over anything already in progress
- Prefer bug reports over feature requests
- Prefer specific, actionable issues over vague ones
- If no suitable Backlog issues exist, set issueNumber to null and write a generic improvement task
- If standing instructions from the project owner are provided, follow them as the primary selection criteria

Respond ONLY with a single JSON object (no markdown, no explanation outside the JSON):
{"issueNumber": <number or null>, "title": "<short title>", "prompt": "<complete task description for an autonomous AI coder, 2-5 sentences>", "reasoning": "<1-2 sentence explanation of why this was chosen>"}`;

function pmEmit(text, level = "info", extra = {}) {
  eventBus.emit("pm_update", { text, level, t: Date.now(), ...extra });
}

// ── Tier 1: PR feedback detection ───────────────────────────────────────────

/**
 * For each copilot/* PR, check if any reviewer has requested changes.
 * Returns an array of { pr, rejectedReviews } for PRs that need work.
 *
 * Uses the most recent review per reviewer — a subsequent APPROVE from the same
 * reviewer overrides a prior CHANGES_REQUESTED, so we don't re-open resolved issues.
 */
async function detectPRsNeedingWork(client, owner, repo, copilotPRs) {
  if (copilotPRs.length === 0) return [];

  const results = await Promise.allSettled(
    copilotPRs.map(async (pr) => {
      const reviews = await listPRReviews({ client, owner, repo, prNumber: pr.number }).catch(() => []);
      // Group by reviewer — keep only the most recent review per user
      const byUser = new Map();
      for (const rev of reviews) {
        if (rev.state === "DISMISSED" || !rev.user?.login) continue;
        const existing = byUser.get(rev.user.login);
        if (!existing || new Date(rev.submitted_at) > new Date(existing.submitted_at)) {
          byUser.set(rev.user.login, rev);
        }
      }
      const rejectedReviews = [...byUser.values()].filter((r) => r.state === "CHANGES_REQUESTED");
      return rejectedReviews.length > 0 ? { pr, rejectedReviews } : null;
    }),
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

/**
 * Build a task prompt for addressing PR review feedback.
 * Fetches inline comments in addition to top-level review bodies.
 */
async function buildPRFeedbackTask(client, owner, repo, pr, rejectedReviews) {
  // Also fetch inline review comments for detail
  let inlineComments = [];
  try {
    const raw = await listPRReviewComments({ client, owner, repo, prNumber: pr.number });
    inlineComments = (raw || []).filter((c) => c.body?.trim());
  } catch { /* non-fatal */ }

  const reviewText = rejectedReviews
    .map((r) => {
      const body = (r.body || "").trim();
      return body ? `**${r.user?.login}**: ${body.slice(0, 600)}` : null;
    })
    .filter(Boolean)
    .join("\n\n");

  const inlineText = inlineComments.length > 0
    ? `\n\nInline comments:\n${inlineComments
        .slice(0, 10)
        .map((c) => `- \`${c.path}\` line ${c.original_line || c.line || "?"}: ${c.body.slice(0, 300)}`)
        .join("\n")}`
    : "";

  // Extract issue number from PR body ("Closes #N")
  const issueMatch = (pr.body || "").match(/Closes\s+#(\d+)/i);
  const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : null;

  const prompt =
    `Address reviewer feedback on PR #${pr.number}: "${pr.title}"\n\n` +
    `The following changes were requested by reviewers:\n\n${reviewText}${inlineText}\n\n` +
    `Read the relevant files on branch \`${pr.head?.ref}\`, fix the issues raised above, ` +
    `then write the corrected files. After fixing, verify that the acceptance criteria in the issue are still met.`;

  return {
    issueNumber,
    prNumber: pr.number,
    title: `Address feedback on PR #${pr.number}: ${pr.title.slice(0, 50)}`,
    prompt,
    reasoning: `PR #${pr.number} has ${rejectedReviews.length} reviewer(s) requesting changes — must be resolved before creating new work.`,
  };
}

// ── Tier 2: Stalled "In Progress" detection ──────────────────────────────────

/**
 * Find issues in the "In Progress" board column that have no open PR.
 * These are interrupted sessions that need to be resumed or retried.
 */
function detectStalledInProgress(board, openPRs) {
  const inProgressCol = board?.columns?.find((c) => c.name === "In Progress");
  if (!inProgressCol) return [];

  return inProgressCol.items
    .filter((item) => item.content?.number && item.content?.state !== "closed")
    .filter((item) => {
      const issueNum = item.content.number;
      // Check if any open PR references this issue via branch name or body
      const hasPR = openPRs.some(
        (pr) =>
          pr.head?.ref?.includes(`-${issueNum}-`) ||
          new RegExp(`Closes\\s+#${issueNum}\\b`, "i").test(pr.body || ""),
      );
      return !hasPR;
    });
}

function buildResumePrompt(issue) {
  const title = issue.content?.title || `issue #${issue.content?.number}`;
  return (
    `Resume interrupted work on issue #${issue.content?.number}: "${title}"\n\n` +
    `This issue was moved to "In Progress" but the session was interrupted before a pull request was created. ` +
    `Review the issue description, check the codebase for any partial changes on an existing copilot/* branch, ` +
    `then complete the implementation and push the changes.`
  );
}

// ── Tier 3: LLM backlog selection ────────────────────────────────────────────

function buildDigest({ issues, board, commits, prs, inProgressNumbers }) {
  const lines = [];

  if (board) {
    lines.push("## GitHub Board");
    for (const col of board.columns) {
      const titles = col.items
        .filter((i) => i.content)
        .map((i) => `#${i.content.number} ${i.content.title}`)
        .slice(0, 6);
      lines.push(`${col.name}: ${titles.length ? titles.join(", ") : "(empty)"}`);
    }
    lines.push("");
  }

  const backlog = (issues || []).filter((i) => !inProgressNumbers.has(i.number));
  if (backlog.length > 0) {
    lines.push("## Open Backlog Issues (candidates)");
    for (const issue of backlog.slice(0, 20)) {
      const labels = (issue.labels || []).map((l) => l.name || l).join(", ");
      const body = (issue.body || "").trim().slice(0, 300);
      lines.push(`#${issue.number}: ${issue.title}${labels ? ` [${labels}]` : ""}`);
      if (body) lines.push(`  > ${body.replace(/\n/g, " ")}`);
    }
    lines.push("");
  } else {
    lines.push("## Open Backlog Issues\n(none — backlog is empty)\n");
  }

  if (prs && prs.length > 0) {
    lines.push("## Open PRs (for context)");
    for (const pr of prs.slice(0, 5)) {
      lines.push(`#${pr.number}: ${pr.title} [${pr.head?.ref || "?"}]`);
    }
    lines.push("");
  }

  if (commits && commits.length > 0) {
    lines.push("## Recent Commits");
    for (const c of commits.slice(0, 8)) {
      const msg = (c.commit?.message || "").split("\n")[0].slice(0, 100);
      lines.push(`- ${msg}`);
    }
  }

  return lines.join("\n");
}

async function selectFromBacklog({ issues, board, commits, prs, inProgressNumbers, provider, pmInstructions, coords }) {
  const digest = buildDigest({ issues, board, commits, prs, inProgressNumbers });

  log(colors.dim("  [AutoSelector] Tier 3: querying LLM for backlog selection…"));
  pmEmit("Consulting AI to select highest-priority backlog task…", "thinking");

  let aiProvider;
  try {
    aiProvider = await createProvider(provider);
    await aiProvider.startNewChat();
  } catch (err) {
    log(colors.yellow(`  [AutoSelector] Could not create provider: ${err.message} — using fallback.`));
    pmEmit(`Could not reach AI provider (${err.message}) — using generic task.`, "warning");
    return { issueNumber: null, title: "General improvement", prompt: FALLBACK_PROMPT, reasoning: "Provider unavailable." };
  }

  const instrBlock = pmInstructions ? `\n\nSTANDING INSTRUCTIONS FROM PROJECT OWNER:\n${pmInstructions}` : "";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Here is the current GitHub project state:\n\n${digest}${instrBlock}\n\nSelect the next task.` },
  ];

  let raw;
  try {
    const result = await aiProvider.sendTurn(messages, "chat", {});
    if (!result.ok) throw new Error(result.reason || "Provider error");
    raw = result.text?.trim() || "";
  } catch (err) {
    log(colors.yellow(`  [AutoSelector] LLM call failed: ${err.message} — using fallback.`));
    pmEmit(`AI selection failed (${err.message}) — using generic task.`, "warning");
    return { issueNumber: null, title: "General improvement", prompt: FALLBACK_PROMPT, reasoning: "LLM call failed." };
  }

  const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
    }
  }

  if (!parsed || typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
    log(colors.yellow("  [AutoSelector] Could not parse LLM response — using fallback."));
    pmEmit("AI response was unreadable — using generic task.", "warning");
    return { issueNumber: null, title: "General improvement", prompt: FALLBACK_PROMPT, reasoning: "LLM response unparseable." };
  }

  return {
    issueNumber: typeof parsed.issueNumber === "number" ? parsed.issueNumber : null,
    title: typeof parsed.title === "string" ? parsed.title : parsed.prompt.slice(0, 60),
    prompt: parsed.prompt.trim(),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * @param {{ projectConfig: object, provider?: string, pmInstructions?: string }} opts
 * @returns {Promise<{issueNumber: number|null, prNumber?: number, title: string, prompt: string, reasoning: string}|null>}
 */
export async function selectNextTask({ projectConfig, provider = "copilot365", pmInstructions = "" }) {
  pmEmit("Analysing project state…", "thinking");

  const client = getGithubClient(projectConfig);
  if (!client) {
    log(colors.dim("  [AutoSelector] No GitHub client — using fallback prompt."));
    pmEmit("No GitHub client configured — using generic improvement task.", "warning");
    return { issueNumber: null, title: "General improvement", prompt: FALLBACK_PROMPT, reasoning: "No GitHub client configured." };
  }

  const coords = getGithubCoords(projectConfig);
  if (!coords) {
    pmEmit("No GitHub coordinates configured — using generic improvement task.", "warning");
    return { issueNumber: null, title: "General improvement", prompt: FALLBACK_PROMPT, reasoning: "No GitHub coords configured." };
  }

  const projectId = projectConfig?.github?._state?.projectId;

  pmEmit(`Fetching GitHub state for ${coords.owner}/${coords.repo}…`, "thinking");

  const [issuesResult, boardResult, commitsResult, prsResult] = await Promise.allSettled([
    listIssues({ client, owner: coords.owner, repo: coords.repo, state: "open", limit: 30 }),
    projectId ? getBoard({ client, projectId }) : Promise.resolve(null),
    client.rest("GET", `/repos/${coords.owner}/${coords.repo}/commits?per_page=10`).catch(() => []),
    client.rest("GET", `/repos/${coords.owner}/${coords.repo}/pulls?state=open&per_page=20`).catch(() => []),
  ]);

  const issues = issuesResult.status === "fulfilled" ? issuesResult.value : [];
  const board = boardResult.status === "fulfilled" ? boardResult.value : null;
  const commits = commitsResult.status === "fulfilled" ? commitsResult.value : [];
  const allOpenPRs = prsResult.status === "fulfilled" ? prsResult.value : [];

  // Issues currently being worked (In Progress or Review columns)
  const inProgressNumbers = new Set();
  if (board) {
    for (const col of board.columns) {
      if (col.name === "In Progress" || col.name === "Review") {
        for (const item of col.items) {
          if (item.content?.number) inProgressNumbers.add(item.content.number);
        }
      }
    }
  }

  const backlogCount = (issues || []).filter((i) => !inProgressNumbers.has(i.number)).length;
  const openPRCount = (allOpenPRs || []).length;
  pmEmit(
    `GitHub state: ${backlogCount} backlog issue${backlogCount !== 1 ? "s" : ""}, ${openPRCount} open PR${openPRCount !== 1 ? "s" : ""}.`,
    "info",
  );

  if (pmInstructions) {
    pmEmit(`Standing instructions: "${pmInstructions.slice(0, 80)}${pmInstructions.length > 80 ? "…" : ""}"`, "instructions");
  }

  // ── Tier 1: PRs with CHANGES_REQUESTED ──────────────────────────────────
  const copilotPRs = (allOpenPRs || []).filter((pr) => pr.head?.ref?.startsWith("copilot/"));
  if (copilotPRs.length > 0) {
    pmEmit(`Checking ${copilotPRs.length} copilot PR${copilotPRs.length !== 1 ? "s" : ""} for review feedback…`, "thinking");
    const prsNeedingWork = await detectPRsNeedingWork(client, coords.owner, coords.repo, copilotPRs);
    if (prsNeedingWork.length > 0) {
      const { pr, rejectedReviews } = prsNeedingWork[0];
      log(colors.cyan(`  [AutoSelector] Tier 1: PR #${pr.number} has changes_requested — addressing review feedback first.`));
      pmEmit(`Tier 1: PR #${pr.number} has changes requested from ${rejectedReviews.map((r) => r.user?.login).join(", ")}`, "decision");

      const task = await buildPRFeedbackTask(client, coords.owner, coords.repo, pr, rejectedReviews);
      pmEmit(`Selected: ${task.title}`, "decision", { issueNumber: task.issueNumber, prNumber: task.prNumber, title: task.title, reasoning: task.reasoning });
      if (task.reasoning) pmEmit(`Reasoning: ${task.reasoning}`, "reasoning");
      return task;
    }
    pmEmit("All copilot PRs are clean (no changes requested).", "info");
  }

  // ── Tier 2: Stalled "In Progress" issues ────────────────────────────────
  if (board) {
    const stalled = detectStalledInProgress(board, allOpenPRs || []);
    if (stalled.length > 0) {
      const item = stalled[0];
      const issueNumber = item.content.number;
      const title = item.content.title || `issue #${issueNumber}`;
      log(colors.cyan(`  [AutoSelector] Tier 2: Issue #${issueNumber} is stalled in "In Progress" — resuming.`));
      pmEmit(`Tier 2: Resuming stalled issue #${issueNumber}: ${title}`, "decision");

      const task = {
        issueNumber,
        title: `Resume #${issueNumber}: ${title.slice(0, 50)}`,
        prompt: buildResumePrompt(item),
        reasoning: `Issue #${issueNumber} has been "In Progress" with no open PR — session was interrupted.`,
      };
      pmEmit(`Selected: ${task.title}`, "decision", { issueNumber, title: task.title, reasoning: task.reasoning });
      if (task.reasoning) pmEmit(`Reasoning: ${task.reasoning}`, "reasoning");
      return task;
    }
  }

  // ── Tier 3: LLM selects from backlog ────────────────────────────────────
  pmEmit("No urgent backlog (all PRs clean, no stalled sessions) — selecting next backlog task…", "info");
  const selected = await selectFromBacklog({
    issues,
    board,
    commits,
    prs: allOpenPRs,
    inProgressNumbers,
    provider,
    pmInstructions,
    coords,
  });

  log(colors.cyan(`  [AutoSelector] Tier 3 selected: ${selected.issueNumber ? `#${selected.issueNumber} ` : ""}${selected.title}`));
  pmEmit(
    selected.issueNumber ? `Selected #${selected.issueNumber}: ${selected.title}` : `Selected: ${selected.title}`,
    "decision",
    { issueNumber: selected.issueNumber, title: selected.title, reasoning: selected.reasoning },
  );
  if (selected.reasoning) pmEmit(`Reasoning: ${selected.reasoning}`, "reasoning");

  return selected;
}
