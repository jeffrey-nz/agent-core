/**
 * GitHub Issues CRUD
 */

export async function createIssue({ client, owner, repo, title, body = "", labels = [], assignees = [] }) {
  return client.rest("POST", `/repos/${owner}/${repo}/issues`, {
    title,
    body,
    labels,
    assignees,
  });
}

export async function updateIssue({ client, owner, repo, number, state, title, body, labels }) {
  const patch = {};
  if (state != null) patch.state = state;
  if (title != null) patch.title = title;
  if (body != null) patch.body = body;
  if (labels != null) patch.labels = labels;
  return client.rest("PATCH", `/repos/${owner}/${repo}/issues/${number}`, patch);
}

export async function addComment({ client, owner, repo, number, body }) {
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
}

export async function listIssues({ client, owner, repo, labels, state = "open", limit = 50 }) {
  const params = new URLSearchParams({ state, per_page: String(limit) });
  if (labels) params.set("labels", Array.isArray(labels) ? labels.join(",") : labels);
  return client.rest("GET", `/repos/${owner}/${repo}/issues?${params}`);
}

export async function getIssue({ client, owner, repo, number }) {
  return client.rest("GET", `/repos/${owner}/${repo}/issues/${number}`);
}

export async function findOrCreateIssue({ client, owner, repo, title, body, labels, assignees }) {
  const existing = await listIssues({ client, owner, repo, state: "open", limit: 100 });
  const found = existing.find((i) => i.title === title);
  if (found) return { issue: found, existed: true };
  const issue = await createIssue({
    client, owner, repo, title,
    body: body || "",
    labels: labels || [],
    assignees: assignees || [],
  });
  return { issue, existed: false };
}

export async function addLabels({ client, owner, repo, number, labels }) {
  return client.rest("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, { labels });
}

export async function removeLabel({ client, owner, repo, number, label }) {
  return client.rest("DELETE", `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`).catch(() => {});
}

export async function ensureLabels({ client, owner, repo, labelDefs }) {
  for (const { name, color, description } of labelDefs) {
    try {
      await client.rest("POST", `/repos/${owner}/${repo}/labels`, { name, color, description });
    } catch (err) {
      if (err.status !== 422) throw err; // 422 = already exists, ignore
    }
  }
}

/**
 * List branch names from GitHub, optionally filtered to those starting with `prefix`.
 * Paginates automatically.
 */
export async function listBranches({ client, owner, repo, prefix = "" }) {
  let page = 1;
  const branches = [];
  while (true) {
    const batch = await client.rest("GET", `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const b of batch) {
      if (!prefix || b.name.startsWith(prefix)) branches.push(b.name);
    }
    if (batch.length < 100) break;
    page++;
  }
  return branches;
}

/**
 * Delete a branch from GitHub (deletes the remote ref).
 */
export async function deleteBranch({ client, owner, repo, branchName }) {
  return client.rest("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${branchName.replace(/\//g, "%2F")}`);
}
