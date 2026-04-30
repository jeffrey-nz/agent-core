/**
 * Documentation system — markdown files in {projectDir}/docs/
 *
 * Writes to the target repo's docs/ directory. Callers are responsible for
 * git add + commit after writing so docs land on GitHub with the feature branch.
 */

import fs from "fs/promises";
import path from "path";

export function getDocsDir(projectDir) {
  return path.join(projectDir, "docs");
}

const SKELETON = {
  "Home.md":         (name) => buildHomePage(name),
  "Architecture.md": (name) => buildArchitecturePage(name),
  "Sessions.md":     ()     => buildSessionsPage(),
  "Research.md":     ()     => buildResearchPage(),
  "Decisions.md":    ()     => buildDecisionsPage(),
};

export async function initDocs({ projectDir, projectName }) {
  const docsDir = getDocsDir(projectDir);
  await fs.mkdir(docsDir, { recursive: true });

  for (const [filename, builder] of Object.entries(SKELETON)) {
    const filePath = path.join(docsDir, filename);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, builder(projectName || "Project"), "utf8");
    }
  }

  return { ok: true, docsDir };
}

export async function listPages({ projectDir }) {
  const docsDir = getDocsDir(projectDir);
  try {
    const pages = [];
    const top = await fs.readdir(docsDir, { withFileTypes: true });
    for (const entry of top) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        pages.push(entry.name.replace(/\.md$/, ""));
      } else if (entry.isDirectory()) {
        const sub = await fs.readdir(path.join(docsDir, entry.name), { withFileTypes: true }).catch(() => []);
        for (const s of sub) {
          if (s.isFile() && s.name.endsWith(".md")) {
            pages.push(`${entry.name}/${s.name.replace(/\.md$/, "")}`);
          }
        }
      }
    }
    return pages.sort();
  } catch {
    return [];
  }
}

export async function readPage({ projectDir, page }) {
  const docsDir = getDocsDir(projectDir);
  const filePath = path.join(docsDir, `${page}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(docsDir) + path.sep)) return null;
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writePage({ projectDir, page, content }) {
  const docsDir = getDocsDir(projectDir);
  const filePath = path.join(docsDir, `${page}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(docsDir) + path.sep)) {
    throw new Error("Invalid page path");
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return { ok: true };
}

export async function appendSessionToDocs({ projectDir, task, prUrl, prNumber, modifiedFiles = [] }) {
  const today = new Date().toISOString().slice(0, 10);
  const fileList = modifiedFiles.length
    ? modifiedFiles.map((f) => `\`${f}\``).join(", ")
    : "_none_";
  const prLink = prUrl ? `[#${prNumber}](${prUrl})` : prNumber ? `#${prNumber}` : "—";
  const row = `| ${today} | ${task.slice(0, 60)} | ${prLink} | ${fileList} |\n`;

  const sessionsPath = path.join(getDocsDir(projectDir), "Sessions.md");
  try {
    let existing = "";
    try { existing = await fs.readFile(sessionsPath, "utf8"); } catch { existing = buildSessionsPage(); }
    await fs.writeFile(sessionsPath, existing.trimEnd() + "\n" + row, "utf8");
  } catch {
    // Non-fatal
  }
}

// ── Skeleton builders ─────────────────────────────────────────────────────────

function buildHomePage(name) {
  return `# ${name}

Project documentation maintained by Copilot Helper.

## Pages
- [Architecture](Architecture) — System design and component overview
- [Sessions](Sessions) — History of all Copilot sessions
- [Research](Research) — Research findings and investigations
- [Decisions](Decisions) — Key architectural decisions log
`;
}

function buildArchitecturePage(name) {
  return `# Architecture — ${name}

> This page is updated automatically by Copilot Helper during sessions.

## Overview
_To be filled in._

## Key components
_To be filled in._

## Design decisions
See [Decisions](Decisions).
`;
}

function buildSessionsPage() {
  return `# Sessions

All Copilot Helper sessions for this project.

| Date | Task | PR | Files changed |
|------|------|----|---------------|
`;
}

function buildResearchPage() {
  return `# Research

Research findings and investigations.

| Topic | Summary | Date |
|-------|---------|------|
`;
}

function buildDecisionsPage() {
  return `# Decisions

Key architectural and design decisions.

| Date | Decision | Rationale |
|------|----------|-----------|
`;
}
