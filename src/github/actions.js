/**
 * GitHub Actions — list workflows, trigger runs, poll status
 */

export async function listWorkflows({ client, owner, repo }) {
  const data = await client.rest("GET", `/repos/${owner}/${repo}/actions/workflows`);
  return (data.workflows || []).map((w) => ({
    id: w.id,
    name: w.name,
    path: w.path,
    state: w.state,
  }));
}

export async function triggerWorkflow({ client, owner, repo, workflow, ref = "main", inputs = {} }) {
  await client.rest("POST", `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    ref,
    inputs,
  });
}

export async function getLatestRun({ client, owner, repo, workflow }) {
  const data = await client.rest(
    "GET",
    `/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
  );
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,         // queued | in_progress | completed
    conclusion: run.conclusion, // success | failure | cancelled | skipped | null
    url: run.html_url,
    startedAt: run.created_at,
    updatedAt: run.updated_at,
    name: run.name,
  };
}

export async function listRecentRuns({ client, owner, repo, limit = 5 }) {
  const data = await client.rest(
    "GET",
    `/repos/${owner}/${repo}/actions/runs?per_page=${limit}`,
  );
  return (data.workflow_runs || []).map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    workflowName: run.workflow_id,
    startedAt: run.created_at,
  }));
}
