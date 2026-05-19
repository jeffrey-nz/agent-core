/**
 * directWriterNode.js
 *
 * Saves the researcher's document content directly to disk — no AI call.
 *
 * Why no AI call?
 * The researcher already produced the document content in state.researchContext.
 * Asking an AI to "save it" via a JSON tool call is the failure mode: every
 * tested copilot365 session instead output the content as chat prose and
 * explicitly refused to use tools ("No tools, no file writes"). There is
 * nothing for the AI to decide here — write the content that already exists.
 *
 * Pipeline position: researcher → directWriter → verifier
 */

import fs from "fs";
import path from "path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("directWriter");

/**
 * Attempt to extract a target file path from the user task description.
 * Looks for explicit path mentions, common doc path patterns, or falls back
 * to a sanitized slug derived from the task text.
 */
function inferTargetPath(userTask) {
  // Explicit path in backticks or quotes: `docs/foo.md` or "docs/foo.md"
  const quoted = userTask.match(/[`"']([a-zA-Z0-9_\-./]+\.(md|txt|rst|adoc))[`"']/);
  if (quoted) return quoted[1];

  // Path-like token anywhere: docs/foo.md, CHANGELOG.md etc.
  const pathLike = userTask.match(/\b([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-.]+\.(md|txt|rst|adoc))\b/);
  if (pathLike) return pathLike[1];

  // Bare filename: pre-launch-issues.md
  const bare = userTask.match(/\b([a-zA-Z0-9_\-.]+\.(md|txt|rst|adoc))\b/i);
  if (bare) return `docs/${bare[1]}`;

  // Last resort: derive a slug from the first ~6 words of the task
  const slug = userTask
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-");
  return `docs/${slug}.md`;
}

/**
 * Build a minimal markdown document from the user task description when the
 * researcher returned empty (copilot365 frequently returns nothing for
 * documentation-only prompts). The task text already contains the full
 * structured content — this function wraps it in a clean markdown document
 * and strips out system-prompt boilerplate ("Goal", "What to build", etc.).
 */
function buildFallbackDocument(userTask) {
  // Strip known system-prompt wrapper sections that appear before the real content.
  // These are injected by the pipeline and are not part of the user's document.
  const stripped = userTask
    .replace(/^Goal\s*\n/im, "")
    .replace(/^What to build \/ change\s*\n[\s\S]*?(?=\n[A-Z]|\nCapture the following)/im, "")
    .replace(/^Out of scope\s*\n[\s\S]*$/im, "")
    .replace(/^Definition of done\s*\n[\s\S]*$/im, "")
    .trim();

  // If the stripping left substantial content, use it directly (it's already
  // structured markdown-style with headings and bullet points).
  if (stripped.length > 100) return stripped;

  // Final fallback: wrap the raw task as-is under a generic heading.
  return `# Pre-Launch Issues\n\n${userTask.trim()}\n`;
}

export async function directWriterNode(state, _config) {
  log(colors.cyan("  [Graph] -> ✍️  Direct Writer: saving document to disk..."));
  eventBus.emit("persona_change", { ...PERSONA, description: "Writing the document file" });
  eventBus.emit("phase_change", { phase: "WRITING", label: "Writing..." });

  const userTask = state.messages.find((m) => m.role === "user")?.content || "";
  const content = (state.researchContext || "").trim();

  // For the fallback, prefer the original unscoped prompt — it contains the
  // actual notes/issues. The scoped task (userTask) is usually just a description
  // of what to build and lacks the content the user wants to document.
  const fallbackSource = state.initialPrompt || userTask;

  const relPath = inferTargetPath(fallbackSource);
  const absPath = relPath.startsWith("/") ? relPath : `${state.projectDir}/${relPath}`;

  log(colors.dim(`  [Graph] -> ✍️  Target file: ${absPath}`));

  // If the researcher returned nothing (copilot365 often returns empty for documentation
  // prompts), fall back to generating the document directly from the user task text.
  // The task description already contains all the structured content the user wants
  // documented — it just needs to be wrapped in minimal markdown scaffolding.
  const effectiveContent = content || buildFallbackDocument(fallbackSource);
  const usingFallback = !content;

  if (usingFallback) {
    log(colors.yellow("  [Graph] -> ✍️  researchContext empty — using task content as document."));
    eventBus.emit("system_message", {
      text: "⚠️ Researcher returned no content — document generated from task description.",
      type: "warning",
    });
  }

  let modifiedFiles = [];

  // Emit synthetic tool events so the extension host's diff card generator fires,
  // giving the user a visible diff card for the document write (same UX as coder writes).
  const callId = `write_file-${Date.now()}`;
  const callStartTs = Date.now();
  eventBus.emit("tool_call_start", {
    callId,
    tool: "write_file",
    paramsSummary: relPath,
  });

  try {
    // Ensure the parent directory exists, then write.
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, effectiveContent, "utf-8");
    modifiedFiles = [absPath];
    log(colors.green(`  [Graph] -> ✍️  Document written: ${absPath}`));
    eventBus.emit("tool_call_end", {
      callId,
      tool: "write_file",
      isError: false,
      result: `Document written: ${relPath}`,
      elapsed: Date.now() - callStartTs,
    });
    eventBus.emit("system_message", { text: `✓ Document saved: ${absPath}`, type: "info" });
  } catch (err) {
    log(colors.red(`  [Graph] -> ✍️  Failed to write document: ${err.message}`));
    eventBus.emit("tool_call_end", {
      callId,
      tool: "write_file",
      isError: true,
      result: `[ERROR] ${err.message}`,
      elapsed: Date.now() - callStartTs,
      errorSummary: err.message.slice(0, 120),
    });
    eventBus.emit("system_message", {
      text: `✗ Writer failed: ${err.message}`,
      type: "error",
    });
  }

  const summary = modifiedFiles.length > 0
    ? `Document written to ${modifiedFiles[0]}`
    : `Failed to write document to ${absPath}`;

  return {
    messages: [{ role: "assistant", content: summary }],
    modifiedFiles,
    lastCoderResponse: summary,
    lastToolsExecuted: modifiedFiles.length > 0 ? ["write_file"] : [],
    lastExecutionErrors: [],
    coderFailed: modifiedFiles.length === 0,
    currentPersona: PERSONA.id,
  };
}
