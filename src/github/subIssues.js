/**
 * GitHub sub-issues management and structured issue body format.
 *
 * Issue body uses fenced HTML comment blocks for machine-readable sections
 * (invisible in the GitHub UI) alongside human-readable markdown headings.
 */

import { createIssue, updateIssue } from "./issues.js";

// ── Body format helpers ───────────────────────────────────────────────────────

export function buildStructuredIssueBody(task) {
  return `## Task\n\n${task}\n\n## Scope\n\n<!-- copilot:scope -->\n_Pending — will be filled after scoping phase._\n<!-- /copilot:scope -->\n\n## Definition of Done\n\n<!-- copilot:dod -->\n_Pending — will be filled after scoping phase._\n<!-- /copilot:dod -->\n\n## Research\n\n<!-- copilot:research -->\n_Pending — will be filled after research phase._\n<!-- /copilot:research -->\n\n## Subtasks\n\n<!-- copilot:subtasks\n{}\n-->\n`;
}

function extractDodFromScope(scopeDoc) {
  if (!scopeDoc) return null;
  const match = scopeDoc.match(/##\s+Definition of done\s*\n([\s\S]*?)(?=\n##|$)/i);
  return match ? match[1].trim() : null;
}

export function parseIssueBody(body) {
  if (!body) return { scope: null, dod: null, research: null, subtasks: null, map: null };

  const scopeMatch = body.match(/<!--\s*copilot:scope\s*-->([\s\S]*?)<!--\s*\/copilot:scope\s*-->/);
  const dodMatch = body.match(/<!--\s*copilot:dod\s*-->([\s\S]*?)<!--\s*\/copilot:dod\s*-->/);
  const researchMatch = body.match(/<!--\s*copilot:research\s*-->([\s\S]*?)<!--\s*\/copilot:research\s*-->/);
  const subtasksMatch = body.match(/<!--\s*copilot:subtasks\s*\n([\s\S]*?)\n-->/);

  let subtasks = null;
  let map = null;

  if (subtasksMatch) {
    try {
      const parsed = JSON.parse(subtasksMatch[1].trim());
      subtasks = parsed.subtasks || null;
      map = parsed.map || null;
    } catch {
      // Malformed JSON — treat as absent
    }
  }

  const scope = scopeMatch ? scopeMatch[1].trim() : null;
  const dod = dodMatch ? dodMatch[1].trim() : null;
  const research = researchMatch ? researchMatch[1].trim() : null;

  const validScope = scope && !scope.startsWith("_Pending") ? scope : null;
  const validDod = dod && !dod.startsWith("_Pending") ? dod : null;
  const validResearch = research && !research.startsWith("_Pending") ? research : null;

  return { scope: validScope, dod: validDod, research: validResearch, subtasks, map };
}

export function upsertScopeInBody(existingBody, scopeDoc, researchReport = null) {
  let body = existingBody || buildStructuredIssueBody("");

  // Replace scope block
  const scopeContent = `<!-- copilot:scope -->\n${scopeDoc}\n<!-- /copilot:scope -->`;
  if (/<!--\s*copilot:scope\s*-->[\s\S]*?<!--\s*\/copilot:scope\s*-->/.test(body)) {
    body = body.replace(/<!--\s*copilot:scope\s*-->[\s\S]*?<!--\s*\/copilot:scope\s*-->/, scopeContent);
  } else {
    body = body + `\n\n## Scope\n\n${scopeContent}\n`;
  }

  // Extract and upsert DoD from scope doc
  const dodText = extractDodFromScope(scopeDoc);
  if (dodText) {
    const dodContent = `<!-- copilot:dod -->\n${dodText}\n<!-- /copilot:dod -->`;
    if (/<!--\s*copilot:dod\s*-->[\s\S]*?<!--\s*\/copilot:dod\s*-->/.test(body)) {
      body = body.replace(/<!--\s*copilot:dod\s*-->[\s\S]*?<!--\s*\/copilot:dod\s*-->/, dodContent);
    } else {
      body = body + `\n\n## Definition of Done\n\n${dodContent}\n`;
    }
  }

  // Replace research block if report provided
  if (researchReport) {
    const researchContent = `<!-- copilot:research -->\n${researchReport}\n<!-- /copilot:research -->`;
    if (/<!--\s*copilot:research\s*-->[\s\S]*?<!--\s*\/copilot:research\s*-->/.test(body)) {
      body = body.replace(/<!--\s*copilot:research\s*-->[\s\S]*?<!--\s*\/copilot:research\s*-->/, researchContent);
    } else {
      body = body + `\n\n## Research\n\n${researchContent}\n`;
    }
  }

  return body;
}

export function upsertResearchInBody(existingBody, researchReport) {
  const body = existingBody || buildStructuredIssueBody("");
  if (!researchReport) return body;
  const researchContent = `<!-- copilot:research -->\n${researchReport}\n<!-- /copilot:research -->`;
  if (/<!--\s*copilot:research\s*-->[\s\S]*?<!--\s*\/copilot:research\s*-->/.test(body)) {
    return body.replace(/<!--\s*copilot:research\s*-->[\s\S]*?<!--\s*\/copilot:research\s*-->/, researchContent);
  }
  return body + `\n\n## Research\n\n${researchContent}\n`;
}

export function upsertSubtasksInBody(existingBody, subtasks, subtaskIssueMap = {}) {
  const block = `<!-- copilot:subtasks\n${JSON.stringify({ subtasks, map: subtaskIssueMap }, null, 2)}\n-->`;
  const body = existingBody || "";

  if (/<!--\s*copilot:subtasks\s*\n[\s\S]*?\n-->/.test(body)) {
    return body.replace(/<!--\s*copilot:subtasks\s*\n[\s\S]*?\n-->/, block);
  }
  return body + `\n\n## Subtasks\n\n${block}\n`;
}

function buildSubIssueBody(subtask, { parentNumber, branchName } = {}) {
  const lines = [`**Task:** ${subtask.task}`];
  if (subtask.files?.length) lines.push(`\n**Files:** ${subtask.files.join(", ")}`);
  if (subtask.constraints) lines.push(`\n**Constraints:** ${subtask.constraints}`);
  if (subtask.implementationNote) lines.push(`\n**Implementation note:** ${subtask.implementationNote}`);
  if (subtask.acceptanceCriteria) lines.push(`\n**Acceptance criteria:** ${subtask.acceptanceCriteria}`);
  if (subtask.failureCriteria) lines.push(`\n**Failure criteria (must NOT happen):** ${subtask.failureCriteria}`);
  const refs = [];
  if (parentNumber) refs.push(`Part of #${parentNumber}`);
  if (branchName) refs.push(`Branch: \`${branchName}\``);
  if (refs.length) lines.push(`\n---\n${refs.join(" · ")}`);
  return lines.join("\n");
}

// ── Sub-issue REST API ────────────────────────────────────────────────────────

export async function createSubIssues({ client, owner, repo, parentNumber, subtasks, branchName }) {
  const refs = [];
  const delay = subtasks.length > 5 ? 300 : 0;

  for (const subtask of subtasks) {
    try {
      const issue = await createIssue({
        client,
        owner,
        repo,
        title: subtask.task.slice(0, 72),
        body: buildSubIssueBody(subtask, { parentNumber, branchName }),
        labels: ["copilot-subtask"],
      });

      // Link as sub-issue of parent
      try {
        await client.rest("POST", `/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues`, {
          sub_issue_id: issue.number,
        });
      } catch {
        // Sub-issues API may not be available on all plans — degrade gracefully
      }

      refs.push({ subtaskId: subtask.id, issueNumber: issue.number });

      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    } catch {
      // Non-fatal: skip this subtask if issue creation fails
    }
  }

  return refs;
}

export async function listSubIssues({ client, owner, repo, parentNumber }) {
  try {
    const items = await client.rest("GET", `/repos/${owner}/${repo}/issues/${parentNumber}/sub_issues`);
    if (!Array.isArray(items)) return [];
    return items.map((i) => ({ number: i.number, title: i.title, state: i.state }));
  } catch {
    return [];
  }
}

export async function closeSubIssue({ client, owner, repo, issueNumber }) {
  try {
    await updateIssue({ client, owner, repo, number: issueNumber, state: "closed" });
  } catch {
    // Non-fatal
  }
}

// ── Resume state reconstruction ───────────────────────────────────────────────

export async function loadResumeState({ client, owner, repo, issueNumber }) {
  const { getIssue } = await import("./issues.js");

  const issue = await getIssue({ client, owner, repo, number: issueNumber });
  if (!issue?.body) return null;

  const { subtasks, map, scope, dod, research } = parseIssueBody(issue.body);
  if (!subtasks?.length || !map) return null;

  // Fetch current open/closed state of sub-issues
  const subIssueStates = await listSubIssues({ client, owner, repo, parentNumber: issueNumber });
  const closedNumbers = new Set(
    subIssueStates.filter((s) => s.state === "closed").map((s) => s.number)
  );

  // Find the first subtask whose sub-issue is still open
  let startIndex = 0;
  for (let i = 0; i < subtasks.length; i++) {
    const subIssueNumber = map[String(subtasks[i].id)];
    if (!subIssueNumber || !closedNumbers.has(subIssueNumber)) {
      startIndex = i;
      break;
    }
    // All subtasks iterated and all are closed
    if (i === subtasks.length - 1) startIndex = subtasks.length;
  }

  return {
    subtasks,
    startIndex,
    map,
    scopeDoc: scope,
    dod,
    researchReport: research,
  };
}
