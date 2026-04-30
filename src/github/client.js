const GH_API = "https://api.github.com";
const GH_GRAPHQL = "https://api.github.com/graphql";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

export function makeGithubClient(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT,
    "X-GitHub-Api-Version": API_VERSION,
    "Content-Type": "application/json",
    "User-Agent": "copilot-helper/1.0",
  };

  async function rest(method, path, body) {
    const url = path.startsWith("http") ? path : `${GH_API}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });

    let data;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    if (!res.ok) {
      const msg = typeof data === "object" ? (data.message || JSON.stringify(data)) : data;
      throw Object.assign(new Error(`GitHub API ${method} ${path}: ${res.status} ${msg}`), {
        status: res.status,
        data,
      });
    }

    return data;
  }

  async function graphql(query, variables = {}) {
    const res = await fetch(GH_GRAPHQL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });

    const json = await res.json();

    if (json.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    return json.data;
  }

  return { rest, graphql, token };
}

export function getGithubClient(projectConfig) {
  const token =
    projectConfig?.github?.token ||
    process.env.GITHUB_TOKEN;
  if (!token) return null;
  return makeGithubClient(token);
}

function cleanGithubSlug(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();

  // SSH: git@github.com:owner/repo.git — extract just the last segment
  const ssh = s.match(/^git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return ssh[2];

  // HTTPS: https://github.com/owner/repo
  const https = s.match(/^https?:\/\/github\.com\/[^/]+\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return https[1];

  // owner/repo shorthand — take the second segment
  const slash = s.match(/^[^/\s]+\/([^/\s]+?)(?:\.git)?$/);
  if (slash) return slash[1];

  // Strip .git suffix if present
  return s.replace(/\.git$/, "");
}

function cleanGithubOwner(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();

  // SSH: git@github.com:owner/repo.git
  const ssh = s.match(/^git@github\.com[:/]([^/]+)\/[^/]+/);
  if (ssh) return ssh[1];

  // HTTPS: https://github.com/owner/
  const https = s.match(/^https?:\/\/github\.com\/([^/]+)/);
  if (https) return https[1];

  // owner/repo — take first segment
  const slash = s.match(/^([^/\s]+)\//);
  if (slash) return slash[1];

  return s;
}

export function getGithubCoords(projectConfig) {
  const g = projectConfig?.github;
  if (!g?.owner || !g?.repo) return null;
  const owner = cleanGithubOwner(g.owner);
  const repo  = cleanGithubSlug(g.repo);
  if (!owner || !repo) return null;
  return { owner, repo };
}
