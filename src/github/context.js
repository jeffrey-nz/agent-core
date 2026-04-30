/**
 * GitHub Issue Comments as a project context notebook.
 *
 * Context notes are regular issue comments tagged with an HTML comment marker
 * so they are machine-readable but invisible in the GitHub UI when collapsed.
 *
 * Tags used:
 *   <!-- copilot:context -->  — general project notes / decisions
 *   <!-- copilot:review -->   — review feedback and coder responses
 */

const CONTEXT_TAG = "<!-- copilot:context -->";
const REVIEW_TAG = "<!-- copilot:review -->";
const PROGRESS_TAG = "<!-- copilot:progress -->";

/**
 * Read all tagged context and review notes from an issue's comment thread.
 * Returns an array of comment body strings (most recent first, capped at limit).
 */
export async function readContextNotes({ client, owner, repo, issueNumber, limit = 30 }) {
  const comments = await client.rest(
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${limit}&direction=desc`,
  );
  return comments
    .filter((c) => c.body?.includes(CONTEXT_TAG) || c.body?.includes(REVIEW_TAG) || c.body?.includes(PROGRESS_TAG))
    .map((c) => c.body);
}

/**
 * Post a general context/decision note to the issue thread.
 * These are injected as project background at the start of future sessions.
 */
export async function writeContextNote({ client, owner, repo, issueNumber, title, body }) {
  const full = `${CONTEXT_TAG}\n### 📝 ${title}\n\n${body.slice(0, 2000)}`;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body: full });
}

/**
 * Post a reviewer finding to the issue thread.
 * Called by the reviewer persona when code fails review, making the feedback
 * visible on GitHub so the team can track what the AI reviewer flagged.
 */
export async function writeReviewNote({ client, owner, repo, issueNumber, persona, status, feedback }) {
  const icon = status === "PASS" ? "✅" : "❌";
  const body = `${REVIEW_TAG}\n### ${icon} ${persona} Review\n\n${feedback.slice(0, 1500)}\n\n*AI reviewer — automated finding*`;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

/**
 * Post a coder response note when addressing review feedback.
 * Creates a visible thread: reviewer flags issue → coder responds with fix plan.
 */
export async function writeCoderResponseNote({ client, owner, repo, issueNumber, retryCount, summary }) {
  const body = `${REVIEW_TAG}\n### 🔄 Coder Response (attempt ${retryCount})\n\n${summary.slice(0, 1000)}\n\n*AI coder — addressing review findings*`;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

/**
 * Post a final approval note once all reviewers are satisfied.
 */
export async function writeApprovalNote({ client, owner, repo, issueNumber }) {
  const body = `${REVIEW_TAG}\n### ✅ All Reviewers Approved\n\nCode passed security and requirements review. PR created.`;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

/**
 * Post a subtask progress note to the parent issue.
 * Tagged so future sessions can see what was completed and in what order.
 */
export async function writeProgressNote({ client, owner, repo, issueNumber, completed, total, subtaskTitle, outcome }) {
  const icon = outcome === "closed" ? "✅" : "🔄";
  const body = `${PROGRESS_TAG}\n### ${icon} Subtask ${completed}/${total} complete\n\n**${subtaskTitle}**\n\n*Session progress — ${new Date().toISOString().slice(0, 10)}*`;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

/**
 * Post a session summary at end of session (success or failure).
 * Provides a persistent record that future sessions can load to avoid repeating work.
 */
export async function writeSessionSummary({ client, owner, repo, issueNumber, outcome, completedCount, totalCount, prNumber, modifiedFiles = [] }) {
  const icon = outcome === "APPROVED" ? "✅" : outcome === "STUCK_TERMINAL" ? "⚠️" : "ℹ️";
  const prRef = prNumber ? ` · PR #${prNumber}` : "";
  const fileList = modifiedFiles.length
    ? `\n\n**Files changed:** ${modifiedFiles.slice(0, 8).map((f) => `\`${f}\``).join(", ")}${modifiedFiles.length > 8 ? ` +${modifiedFiles.length - 8} more` : ""}`
    : "";
  const body = `${CONTEXT_TAG}\n### ${icon} Session complete — ${outcome}${prRef}\n\n**Subtasks:** ${completedCount}/${totalCount} completed${fileList}\n\n*${new Date().toISOString().slice(0, 10)}*`;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
}

/**
 * Format context notes for injection into AI prompts.
 * Strips HTML comment tags and truncates to a safe length.
 */
export function formatContextForPrompt(notes, maxChars = 3000) {
  if (!notes?.length) return null;
  const cleaned = notes
    .map((n) => n.replace(/<!--[^>]*-->/g, "").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "\n...[truncated]" : cleaned;
}
