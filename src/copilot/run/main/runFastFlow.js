/**
 * Fast Mode — single-shot codebase fix.
 *
 * Scans the project directory, sends the full codebase to the AI in one call,
 * receives back FILE blocks, writes them, and finishes.
 *
 * Best for small well-defined changes (e.g. "change the hero background to dark blue").
 * Not suitable for complex multi-file refactors or new feature development.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { initializeFlow } from "./flow/setup/flowInit.js";
import { finalizeSession } from "./flow/finalizeSession.js";
import { throwIfAborted } from "#utils/abort.js";

// ── File scanner ──────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "vendor", "dist", "build", ".cache",
  ".next", ".nuxt", "coverage", ".vite", "public/node_modules",
]);

const TEXT_EXTS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".php", ".py", ".rb", ".go", ".java", ".cs", ".rs", ".swift", ".kt",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".twig", ".ss", ".blade.php",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example",
  ".md", ".txt", ".sh", ".bash", ".zsh",
  ".sql", ".graphql", ".xml", ".svg",
  ".htaccess", ".editorconfig", ".gitignore",
]);

// Per-extension read limits to avoid bloating context with huge generated files
const EXT_MAX_BYTES = {
  ".json": 8_000,
  ".md":   4_000,
  ".sql":  6_000,
};

const MAX_TOTAL_CHARS = 180_000; // ~45K tokens — safe for most providers

async function scanFiles(dir, base, results = [], totalChars = { v: 0 }) {
  if (totalChars.v >= MAX_TOTAL_CHARS) return results;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  // Directories first so siblings scan before descendants
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) {
      // Allow a few dotfiles that are useful context
      if (![".env.example", ".htaccess", ".editorconfig"].includes(e.name)) continue;
    }
    if (e.isDirectory()) dirs.push(e);
    else if (e.isFile()) files.push(e);
  }

  for (const e of files) {
    if (totalChars.v >= MAX_TOTAL_CHARS) break;
    const ext = path.extname(e.name).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    const fullPath = path.join(dir, e.name);
    try {
      let content = await fs.readFile(fullPath, "utf8");
      const limit = EXT_MAX_BYTES[ext];
      if (limit && content.length > limit) {
        content = content.slice(0, limit) + "\n... (truncated)";
      }
      const relPath = path.relative(base, fullPath);
      totalChars.v += content.length;
      results.push({ relPath, content });
    } catch { /* skip unreadable */ }
  }

  for (const e of dirs) {
    if (totalChars.v >= MAX_TOTAL_CHARS) break;
    await scanFiles(path.join(dir, e.name), base, results, totalChars);
  }
  return results;
}

// ── Response parser ────────────────────────────────────────────────────────────

const FILE_BLOCK_RE = /\[FILE:\s*([^\]]+?)\s*\]\n([\s\S]*?)\n?\[\/FILE\]/g;

function parseFileChanges(text) {
  const changes = [];
  let match;
  FILE_BLOCK_RE.lastIndex = 0;
  while ((match = FILE_BLOCK_RE.exec(text)) !== null) {
    const relPath = match[1].trim().replace(/^\/+/, "");
    // Safety: reject absolute paths or path traversal
    if (path.isAbsolute(relPath) || relPath.includes("..")) continue;
    changes.push({ relPath, content: match[2] });
  }
  return changes;
}

async function applyChanges(gitDir, changes) {
  const applied = [];
  for (const { relPath, content } of changes) {
    const fullPath = path.join(gitDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
    applied.push(relPath);
    log(colors.green(`  [Fast] ✓ ${relPath}`));
  }
  return applied;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runFastFlow(options = {}) {
  const { targetRepoDir, projectDir, providerName, providerMode, project, sessionInfo, signal } = options;
  const gitDir = targetRepoDir || projectDir;
  const task = sessionInfo?.initialPrompt || "";

  eventBus.emit("phase_change", { phase: "EXECUTION", label: "Fast Mode" });
  eventBus.emit("persona_change", {
    id: "fastCoder",
    label: "Fast Coder",
    icon: "⚡",
    color: "#f59e0b",
    description: "Scanning codebase and applying all changes in one shot",
  });

  // Use project's native mode (not the "fast" routing flag) so it doesn't
  // leak to the provider API.  initializeFlow handles workspace config too.
  const provider = await initializeFlow(
    { ...options, providerMode: options.project?.mode ?? null },
    gitDir,
  );

  const session = {
    provider,
    gitDir,
    close: async () => { if (provider.close) await provider.close(); },
  };

  try {
    // ── Scan ──────────────────────────────────────────────────────────────────
    log(colors.cyan("\n  [Fast] Scanning codebase…"));
    eventBus.emit("system_message", { text: "⚡ Fast Mode: scanning codebase…", type: "info" });

    throwIfAborted(signal);
    const files = await scanFiles(gitDir, gitDir);
    const totalKB = Math.round(files.reduce((s, f) => s + f.content.length, 0) / 1024);

    if (files.length === 0) {
      eventBus.emit("system_message", { text: "⚠ Fast Mode: no readable files found in project.", type: "warning" });
      return false;
    }

    log(colors.dim(`  [Fast] ${files.length} file(s) — ${totalKB} KB`));
    eventBus.emit("system_message", { text: `⚡ ${files.length} files scanned (${totalKB} KB)`, type: "info" });

    // ── Build prompt ──────────────────────────────────────────────────────────
    const fileBlock = files
      .map((f) => `[FILE: ${f.relPath}]\n${f.content}\n[/FILE]`)
      .join("\n\n");

    const systemPrompt =
`You are an expert developer applying a targeted change to an existing codebase.

TASK: ${task}

Rules:
- Make ONLY the changes needed to complete the task — nothing else.
- Return EVERY modified or new file using this exact format:

[FILE: relative/path/to/file.ext]
complete new file content here (not a diff — the full file)
[/FILE]

- Do NOT include files you didn't change.
- Do NOT add explanations, markdown, or any text outside of FILE blocks (unless the task is impossible — explain why briefly, then stop).
- Preserve existing code style, indentation, and formatting.`;

    const userMessage =
`Here is the current codebase:\n\n${fileBlock}\n\nPlease apply the task now.`;

    // ── Send to AI ────────────────────────────────────────────────────────────
    log(colors.cyan("  [Fast] Sending to AI…"));
    eventBus.emit("system_message", { text: "⚡ Sending to AI — this may take a moment…", type: "info" });
    throwIfAborted(signal);

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage  },
    ];

    const res = await provider.sendTurn(messages, "fast-coder", {
      rootDir: gitDir,
      interactionMode: "scoping", // no tool calls — text output only
      requireWriteFile: false,
    });

    if (!res?.ok) {
      const reason = res?.reason || "unknown error";
      eventBus.emit("system_message", { text: `✗ Fast Mode: AI call failed — ${reason}`, type: "warning" });
      return false;
    }

    const responseText = res.text || "";
    eventBus.emit("message_complete", { text: responseText });

    // ── Parse & apply ─────────────────────────────────────────────────────────
    const changes = parseFileChanges(responseText);

    if (changes.length === 0) {
      log(colors.yellow("  [Fast] No FILE blocks found in response."));
      eventBus.emit("system_message", { text: "⚠ Fast Mode: AI returned no file changes. Check the task description and try again.", type: "warning" });
    } else {
      log(colors.cyan(`  [Fast] Applying ${changes.length} file change(s)…`));
      eventBus.emit("system_message", { text: `⚡ Applying ${changes.length} file change(s)…`, type: "info" });
      throwIfAborted(signal);

      const applied = await applyChanges(gitDir, changes);
      const fullPaths = applied.map((p) => path.join(gitDir, p));

      eventBus.emit("files_modified", { files: fullPaths });
      eventBus.emit("system_message", {
        text: `✓ Fast Mode: ${applied.length} file(s) updated — ${applied.slice(0, 3).join(", ")}${applied.length > 3 ? ` +${applied.length - 3} more` : ""}`,
        type: "info",
      });
    }

    await finalizeSession(session, options);
    return true;
  } finally {
    await session.close().catch(() => {});
  }
}
