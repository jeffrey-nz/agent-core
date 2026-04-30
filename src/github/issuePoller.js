/**
 * Polls GitHub for open issues labeled as tasks and surfaces them
 * to the frontend as suggested prompts.
 */

import { getGithubClient, getGithubCoords } from "./client.js";
import { listIssues } from "./issues.js";

export async function pollIssues(projectConfig) {
  const client = getGithubClient(projectConfig);
  if (!client) return [];

  const coords = getGithubCoords(projectConfig);
  if (!coords) return [];

  const label = projectConfig?.github?.taskLabel || "copilot-task";

  try {
    const issues = await listIssues({
      client,
      owner: coords.owner,
      repo: coords.repo,
      labels: label,
      state: "open",
    });

    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      url: i.html_url,
      labels: (i.labels || []).map((l) => l.name),
      createdAt: i.created_at,
    }));
  } catch {
    return [];
  }
}
