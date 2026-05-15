/**
 * Claude-style memory bank for agent-core.
 *
 * Mirrors Claude Code's per-user persistent memory:
 *  - One `MEMORY.md` index always loaded, listing pointers to detail files.
 *  - Detail files with YAML-ish frontmatter (name / description / type) + body.
 *  - Types: user | feedback | project | reference.
 *
 * Storage hierarchy (both searched, project takes precedence on duplicate names):
 *  1. Global  — ~/.agent-core/memory/      (per-user, cross-project)
 *  2. Project — {projectDir}/docs/memory-bank/  (per-repo, committed to git)
 *
 * Interoperable with Claude Code's MEMORY.md format — same frontmatter,
 * same index style. If the user runs `claude` and `agent-core` against the
 * same workspace, memories written by one are loadable by the other.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);
const INDEX_FILE = "MEMORY.md";

// --- Path resolution --------------------------------------------------------

export function globalMemoryDir() {
  return path.join(os.homedir(), ".agent-core", "memory");
}

export function projectMemoryDir(projectDir) {
  return path.join(projectDir, "docs", "memory-bank");
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// --- Frontmatter parsing ----------------------------------------------------

/**
 * Parses a memory file's frontmatter. Returns { meta, body } where meta has
 * { name, description, type, ...other }. Throws on malformed input.
 */
export function parseMemory(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    throw new Error("Memory file missing frontmatter (--- block).");
  }
  const meta = parseYamlSubset(m[1]);
  return { meta, body: m[2].trim() };
}

/**
 * Tiny YAML-subset parser — handles flat key: value plus a single nested
 * `metadata:` block with key/value lines indented two spaces. Enough for the
 * Claude memory schema, no external dependency.
 */
function parseYamlSubset(text) {
  const out = {};
  const lines = text.split("\n");
  let inNested = null; // current nested object key, e.g. "metadata"
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s{2,}/.test(line) && inNested) {
      const m = line.match(/^\s+([\w_-]+)\s*:\s*(.+)$/);
      if (m) out[inNested][m[1]] = stripQuotes(m[2].trim());
      continue;
    }
    const m = line.match(/^([\w_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (rawVal.trim() === "") {
      out[key] = {};
      inNested = key;
    } else {
      out[key] = stripQuotes(rawVal.trim());
      inNested = null;
    }
  }
  return out;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function serializeMemory({ name, description, type, body, extraMeta = {} }) {
  if (!name) throw new Error("Memory needs a name.");
  if (!type || !VALID_TYPES.has(type)) {
    throw new Error(`Memory type must be one of ${[...VALID_TYPES].join(", ")}.`);
  }
  const desc = (description || "").replace(/\n/g, " ").trim();
  const extras = Object.entries(extraMeta)
    .map(([k, v]) => `  ${k}: ${escapeYamlValue(v)}`)
    .join("\n");
  const front =
    `---\n` +
    `name: ${name}\n` +
    `description: ${escapeYamlValue(desc)}\n` +
    `metadata:\n` +
    `  type: ${type}\n` +
    (extras ? extras + "\n" : "");
  return front + `---\n\n${(body || "").trim()}\n`;
}

function escapeYamlValue(v) {
  const s = String(v);
  if (/[:#]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

// --- Read / write -----------------------------------------------------------

/**
 * Lists memory entries from a directory. Returns array of
 * { dir, file, meta, bodyPreview } sorted by name. Skips MEMORY.md and any
 * file without valid frontmatter.
 */
export async function listMemoriesFromDir(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith(".md") || file === INDEX_FILE) continue;
    try {
      const text = await fs.readFile(path.join(dir, file), "utf8");
      const { meta, body } = parseMemory(text);
      out.push({
        dir,
        file,
        meta,
        body,
        bodyPreview: body.slice(0, 200),
      });
    } catch {
      // ignore malformed
    }
  }
  out.sort((a, b) => (a.meta.name || a.file).localeCompare(b.meta.name || b.file));
  return out;
}

/**
 * Lists memories across both global and project scopes. Project entries
 * override global entries with the same `name`.
 */
export async function listMemories({ projectDir = null } = {}) {
  const global = await listMemoriesFromDir(globalMemoryDir());
  const project = projectDir ? await listMemoriesFromDir(projectMemoryDir(projectDir)) : [];

  const byName = new Map();
  for (const m of global) byName.set(m.meta.name || m.file, { ...m, scope: "global" });
  for (const m of project) byName.set(m.meta.name || m.file, { ...m, scope: "project" });
  return [...byName.values()];
}

/**
 * Writes a memory file into the chosen scope and updates that scope's
 * MEMORY.md index. Returns the absolute path written.
 */
export async function writeMemory({
  name,
  description,
  type,
  body,
  extraMeta = {},
  scope = "global",
  projectDir = null,
}) {
  if (!name) throw new Error("Memory name is required.");
  const dir = scope === "project"
    ? (projectDir ? projectMemoryDir(projectDir) : (() => { throw new Error("scope=project requires projectDir"); })())
    : globalMemoryDir();
  await ensureDir(dir);
  const file = `${name}.md`;
  const text = serializeMemory({ name, description, type, body, extraMeta });
  await fs.writeFile(path.join(dir, file), text, "utf8");
  await rebuildIndex(dir);
  return path.join(dir, file);
}

/**
 * Reads a single memory by name from the merged (project ∪ global) set.
 */
export async function readMemoryByName(name, { projectDir = null } = {}) {
  const all = await listMemories({ projectDir });
  return all.find((m) => m.meta.name === name) || null;
}

/**
 * Removes a memory file by name. Returns true if a file was removed.
 */
export async function deleteMemory(name, { scope = "global", projectDir = null } = {}) {
  const dir = scope === "project" ? projectMemoryDir(projectDir) : globalMemoryDir();
  const file = path.join(dir, `${name}.md`);
  try {
    await fs.unlink(file);
    await rebuildIndex(dir);
    return true;
  } catch {
    return false;
  }
}

// --- Index file -------------------------------------------------------------

/**
 * Rebuilds MEMORY.md in `dir` to match the current set of memory files.
 * Each entry: `- [Title](file.md) — one-line description`, keep ≤150 chars.
 */
export async function rebuildIndex(dir) {
  const entries = await listMemoriesFromDir(dir);
  const lines = ["# Memory Index", ""];
  for (const e of entries) {
    const title = e.meta.name || e.file.replace(/\.md$/, "");
    const desc = (e.meta.description || "").trim();
    const line = `- [${title}](${e.file})${desc ? ` — ${desc}` : ""}`;
    lines.push(line.length > 220 ? line.slice(0, 217) + "..." : line);
  }
  await fs.writeFile(path.join(dir, INDEX_FILE), lines.join("\n") + "\n", "utf8");
}
