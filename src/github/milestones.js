/**
 * GitHub Milestones CRUD
 */

export async function listMilestones({ client, owner, repo, state = "open" }) {
  const params = new URLSearchParams({ state, per_page: "100" });
  return client.rest("GET", `/repos/${owner}/${repo}/milestones?${params}`);
}

export async function createMilestone({ client, owner, repo, title, dueDate }) {
  const body = { title };
  if (dueDate) body.due_on = dueDate;
  return client.rest("POST", `/repos/${owner}/${repo}/milestones`, body);
}

export async function findOrCreateMilestone({ client, owner, repo, title, dueDate }) {
  const milestones = await listMilestones({ client, owner, repo });
  const found = milestones.find((m) => m.title === title);
  if (found) return { milestone: found, existed: true };
  const milestone = await createMilestone({ client, owner, repo, title, dueDate });
  return { milestone, existed: false };
}

export async function setIssueMilestone({ client, owner, repo, number, milestoneNumber }) {
  return client.rest("PATCH", `/repos/${owner}/${repo}/issues/${number}`, { milestone: milestoneNumber });
}

/** Returns "Month YYYY" title and ISO due-date for the last day of the current month. */
export function currentMonthMilestone() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const title = `${months[month]} ${year}`;
  // Last day of the month at 23:59:59 UTC
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));
  return { title, dueDate: lastDay.toISOString() };
}
