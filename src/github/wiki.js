/**
 * GitHub Wiki operations
 *
 * GitHub wikis are standalone git repositories at:
 *   https://github.com/{owner}/{repo}.wiki.git
 *
 * We use simple-git for all operations. Each writePage / initWiki call
 * clones into a temp directory, makes changes, and pushes. The clone is
 * discarded after each operation to keep state simple.
 */

import simpleGit from "simple-git";
import fs from "fs/promises";
import path from "path";
import os from "os";

function wikiUrl(owner, repo, token) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.wiki.git`;
}

async function withWikiClone(owner, repo, token, fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `gh-wiki-${repo}-`));
  try {
    const git = simpleGit();
    await git.clone(wikiUrl(owner, repo, token), tmpDir, ["--depth=1"]);
    const repoGit = simpleGit(tmpDir);
    await repoGit.addConfig("user.email", "copilot-helper@noreply");
    await repoGit.addConfig("user.name", "Copilot Helper");
    const result = await fn(tmpDir, repoGit);
    return result;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export async function readPage({ owner, repo, token, page }) {
  return withWikiClone(owner, repo, token, async (dir) => {
    const file = path.join(dir, `${page}.md`);
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return null;
    }
  });
}

export async function writePage({ owner, repo, token, page, content, message = `Update ${page}` }) {
  return withWikiClone(owner, repo, token, async (dir, git) => {
    // Support nested pages like "Research/caching"
    const file = path.join(dir, `${page}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    await git.add(path.relative(dir, file));
    await git.commit(message);
    await git.push("origin", "master");
    return true;
  });
}

export async function listPages({ owner, repo, token }) {
  return withWikiClone(owner, repo, token, async (dir) => {
    const entries = await fs.readdir(dir, { recursive: true });
    return entries
      .filter((e) => e.endsWith(".md") && !e.startsWith("."))
      .map((e) => e.replace(/\.md$/, ""));
  });
}

export async function initWiki({ owner, repo, token }) {
  // If the wiki repo doesn't exist yet, GitHub requires the first page to be
  // created via the web UI. Detect this and return a clear message.
  try {
    await withWikiClone(owner, repo, token, async (dir, git) => {
      const skeleton = {
        "Home": buildHomePage(repo),
        "Architecture": buildArchitecturePage(repo),
        "Sessions/index": buildSessionsIndex(),
        "Research/index": buildResearchIndex(),
        "Decisions/index": buildDecisionsIndex(),
      };

      for (const [page, content] of Object.entries(skeleton)) {
        const file = path.join(dir, `${page}.md`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        // Only create if doesn't exist
        try { await fs.access(file); continue; } catch { /* create it */ }
        await fs.writeFile(file, content, "utf8");
        await git.add(path.relative(dir, file));
      }

      const status = await git.status();
      if (status.staged.length > 0) {
        await git.commit("Initialize wiki skeleton");
        await git.push("origin", "master");
      }
    });
    return { ok: true };
  } catch (err) {
    if (err.message?.includes("not found") || err.message?.includes("Repository not found")) {
      return {
        ok: false,
        message: `Wiki not yet enabled for ${owner}/${repo}. Go to https://github.com/${owner}/${repo}/wiki and create the first page manually to enable it.`,
      };
    }
    throw err;
  }
}

export async function appendSessionToWiki({ owner, repo, token, task, prUrl, prNumber, modifiedFiles = [] }) {
  const today = new Date().toISOString().slice(0, 10);
  const fileList = modifiedFiles.length
    ? modifiedFiles.map((f) => `\`${f}\``).join(", ")
    : "_none_";

  const row = `| ${today} | ${task.slice(0, 60)} | [#${prNumber}](${prUrl}) | ${fileList} |\n`;

  try {
    await withWikiClone(owner, repo, token, async (dir, git) => {
      const indexFile = path.join(dir, "Sessions", "index.md");
      await fs.mkdir(path.dirname(indexFile), { recursive: true });

      let existing = "";
      try { existing = await fs.readFile(indexFile, "utf8"); } catch { existing = buildSessionsIndex(); }

      // Append row before the last line (closing marker) if present, otherwise just append
      const updated = existing.trimEnd() + "\n" + row;
      await fs.writeFile(indexFile, updated, "utf8");
      await git.add("Sessions/index.md");
      await git.commit(`Session: ${task.slice(0, 60)}`);
      await git.push("origin", "master");
    });
  } catch {
    // Non-fatal
  }
}

// ── Skeleton page builders ────────────────────────────────────────────────────

function buildHomePage(repo) {
  return `# ${repo} Wiki

This wiki is maintained by [Copilot Helper](https://github.com/copilot-helper).

## Quick links
- [[Architecture]] — System design and technical decisions
- [[Sessions/index]] — History of all Copilot sessions
- [[Research/index]] — Research findings and investigations
- [[Decisions/index]] — Key architectural decisions log
`;
}

function buildArchitecturePage(repo) {
  return `# Architecture

> This page is updated automatically by Copilot Helper during sessions.

## Overview
_To be filled in._

## Key components
_To be filled in._

## Design decisions
See [[Decisions/index]].
`;
}

function buildSessionsIndex() {
  return `# Sessions

All Copilot Helper sessions for this project.

| Date | Task | PR | Files changed |
|------|------|----|---------------|
`;
}

function buildResearchIndex() {
  return `# Research

Research findings and investigations.

| Topic | Page | Date |
|-------|------|------|
`;
}

function buildDecisionsIndex() {
  return `# Decisions

Key architectural and design decisions.

| Date | Decision | Rationale |
|------|----------|-----------|
`;
}
