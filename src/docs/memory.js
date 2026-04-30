/**
 * Memory bank — structured AI-maintained docs in {projectDir}/docs/memory/
 *
 * Four files, each with a distinct role:
 *   patterns.md  — Architecture invariants and design patterns (AI curates, persists across sessions)
 *   context.md   — Tech stack, config values, commands, gotchas (AI curates, persists across sessions)
 *   active.md    — Current focus, recent changes, open questions (AI rewrites each session)
 *   log.md       — Append-only session history (machine-written, never AI-edited)
 *
 * All files live in docs/memory/ so they're committed to git and visible on GitHub.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const MEMORY_DIR = "docs/memory";

const TEMPLATES = {
  "patterns.md": `# Architecture Patterns

> Auto-maintained by Copilot Helper. Updated after each session.

## Invariants
<!-- Hard rules that must not be violated. Each names a specific component and WHY it must be preserved. -->

## Design Patterns
<!-- Recurring patterns, naming conventions, non-obvious architectural decisions. -->
`,

  "context.md": `# Technical Context

> Auto-maintained by Copilot Helper. Updated after each session.

## Stack
<!-- Frameworks, languages, versions. -->

## Configuration
<!-- Config values, environment variables, base URLs, feature flags. -->

## Commands
<!-- Build, test, deploy — including known workarounds. -->

## Gotchas
<!-- Non-obvious facts that tripped up prior sessions. -->
`,

  "active.md": `# Active Context

> Auto-maintained by Copilot Helper. Rewritten each session.

## Current Focus
<!-- What is being worked on right now. -->

## Recent Changes
<!-- What changed in the last session. -->

## Open Questions
<!-- Unresolved decisions or blockers. -->
`,

  "log.md": `# Session Log

> Machine-generated. Do not edit manually.

| Date | Task | Outcome | Files |
|------|------|---------|-------|
`,
};

export function getMemoryDir(projectDir) {
  return path.join(projectDir, MEMORY_DIR);
}

export async function initMemory(projectDir) {
  const dir = getMemoryDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  for (const [filename, content] of Object.entries(TEMPLATES)) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, content, "utf8");
    }
  }
  return dir;
}

export async function readMemoryFile(projectDir, filename) {
  try {
    return await fs.readFile(path.join(getMemoryDir(projectDir), filename), "utf8");
  } catch {
    return TEMPLATES[filename] || "";
  }
}

export async function writeMemoryFile(projectDir, filename, content) {
  const dir = getMemoryDir(projectDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, "utf8");
}

/**
 * Loads all readable memory files (patterns, context, active) as a structured
 * context block for injection into agent prompts.
 * Returns null if all files are empty/template-only.
 */
export async function loadMemoryContext(projectDir, { maxChars = 12000 } = {}) {
  const files = ["patterns.md", "context.md", "active.md"];
  const parts = [];
  let total = 0;

  for (const filename of files) {
    const content = await readMemoryFile(projectDir, filename);
    const body = content.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (body.length < 30) continue;
    const label = filename.replace(".md", "").toUpperCase();
    const chunk = `[MEMORY:${label}]\n${content.slice(0, maxChars - total)}\n`;
    parts.push(chunk);
    total += chunk.length;
    if (total >= maxChars) break;
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Builds and appends a machine-written log entry for this session.
 * Never calls the AI — prevents hallucinated history.
 */
export async function appendSessionLog(projectDir, { task, outcome, modifiedFiles = [], date }) {
  const d = date || new Date().toISOString().slice(0, 10);
  const taskSnippet = String(task || "(unknown task)").slice(0, 80).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const fileList = modifiedFiles.length
    ? modifiedFiles.slice(0, 5).map((f) => `\`${path.basename(f)}\``).join(", ") + (modifiedFiles.length > 5 ? ` +${modifiedFiles.length - 5}` : "")
    : "—";
  const row = `| ${d} | ${taskSnippet} | ${outcome || "UNKNOWN"} | ${fileList} |\n`;

  const existing = await readMemoryFile(projectDir, "log.md");
  await writeMemoryFile(projectDir, "log.md", existing.trimEnd() + "\n" + row);
}
