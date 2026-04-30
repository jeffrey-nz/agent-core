/**
 * GitHub Pull Requests — create, configure auto-merge, request reviews, list
 */

export async function createPR({ client, owner, repo, head, base, title, body = "", draft = false }) {
  return client.rest("POST", `/repos/${owner}/${repo}/pulls`, {
    title,
    body,
    head,
    base,
    draft,
  });
}

export async function enableAutoMerge({ client, prNodeId, mergeMethod = "SQUASH" }) {
  const mutation = `
    mutation EnableAutoMerge($prId: ID!, $method: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $method }) {
        pullRequest { number autoMergeRequest { mergeMethod } }
      }
    }
  `;
  return client.graphql(mutation, { prId: prNodeId, method: mergeMethod });
}

export async function requestReviewers({ client, owner, repo, prNumber, reviewers }) {
  if (!reviewers?.length) return;
  return client.rest("POST", `/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
    reviewers,
  });
}

export async function addLabelsToPR({ client, owner, repo, prNumber, labels }) {
  if (!labels?.length) return;
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${prNumber}/labels`, { labels });
}

export async function listPRs({ client, owner, repo, state = "open" }) {
  return client.rest("GET", `/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`);
}

export async function getPR({ client, owner, repo, prNumber }) {
  return client.rest("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
}

export async function enableRepoAutoMerge({ client, owner, repo }) {
  // Ensure auto-merge is enabled at the repo level (requires admin)
  try {
    await client.rest("PATCH", `/repos/${owner}/${repo}`, { allow_auto_merge: true });
  } catch {
    // Non-fatal — may lack admin rights; auto-merge enablement on the PR itself may still work
  }
}

/**
 * Submit a formal GitHub PR review (APPROVE / REQUEST_CHANGES / COMMENT).
 * `comments` is an optional array of inline review comments:
 *   { path, line, side?, body }
 */
export async function createPRReview({ client, owner, repo, prNumber, body = "", event = "COMMENT", comments = [] }) {
  const payload = { body, event };
  if (comments.length > 0) payload.comments = comments;
  return client.rest("POST", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, payload);
}

/** Returns all files changed in a PR including their `patch` (unified diff). */
export async function listPRFiles({ client, owner, repo, prNumber }) {
  return client.rest("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
}

/** Returns all inline review comments on a PR (review threads). */
export async function listPRReviewComments({ client, owner, repo, prNumber }) {
  return client.rest("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`);
}

/** Returns all submitted reviews on a PR (top-level review objects). */
export async function listPRReviews({ client, owner, repo, prNumber }) {
  return client.rest("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`);
}

/**
 * Build inline comment objects from reviewer feedback text.
 * Parses lines like "In `path/to/file.js` line 42:" or "file.js:42".
 * Returns an array of { path, line, body } for files that appear in prFiles.
 */
export function parseInlineComments(feedbackText, prFiles = []) {
  const comments = [];
  const fileSet = new Set(prFiles.map((f) => f.filename));

  // Pattern: mentions a file path followed by issue text
  const filePattern = /[`']?([^\s`'"]+\.[a-z]{1,6})[`']?(?:\s+(?:line[s]?\s+)?(\d+))?[:\s—–-]+([^\n]{20,})/gi;
  let match;
  while ((match = filePattern.exec(feedbackText)) !== null) {
    const [, filePath, lineStr, issueText] = match;
    // Only post if the file actually appears in this PR
    const prFile = prFiles.find((f) => f.filename === filePath || f.filename.endsWith(`/${filePath}`));
    if (!prFile) continue;
    const line = lineStr ? parseInt(lineStr, 10) : null;
    if (line && line > 0) {
      comments.push({ path: prFile.filename, line, side: "RIGHT", body: issueText.trim().slice(0, 512) });
    }
  }

  return comments.slice(0, 10); // cap at 10 inline comments
}

export async function closePR({ client, owner, repo, prNumber }) {
  return client.rest("PATCH", `/repos/${owner}/${repo}/pulls/${prNumber}`, { state: "closed" });
}

export function buildPRBody({ task, completionSummary, modifiedFiles = [], decisions = [], issueNumber, subIssueNumbers = [], scopeDoc = null, dod = null, reviewerVerdicts = null }) {
  const fileList = modifiedFiles.length
    ? modifiedFiles.map((f) => `- \`${f}\``).join("\n")
    : "_No files modified._";

  const decisionList = decisions.length
    ? decisions.map((d) => `- ${d}`).join("\n")
    : "";

  const issueSection = issueNumber
    ? `\n## Closes\n- Closes #${issueNumber}${subIssueNumbers.length ? `\n${subIssueNumbers.map((n) => `- Refs #${n}`).join("\n")}` : ""}\n`
    : "";

  // Extract the goal line from the scope doc for a concise PR summary
  const goalMatch = scopeDoc?.match(/##\s+Goal\s*\n([^\n]+)/i);
  const goalLine = goalMatch ? goalMatch[1].trim() : null;

  const dodSection = dod
    ? `\n## Definition of done\n${dod}\n`
    : "";

  const reviewSection = reviewerVerdicts
    ? `\n## AI reviewer verdicts\n${reviewerVerdicts}\n`
    : "";

  return `## Summary
${goalLine || completionSummary || task || "Automated changes by Copilot Helper."}

## Files changed
${fileList}
${decisionList ? `\n## Decisions made\n${decisionList}\n` : ""}${dodSection}${reviewSection}${issueSection}
---
*Generated by [Copilot Helper](https://github.com/copilot-helper)*`;
}
