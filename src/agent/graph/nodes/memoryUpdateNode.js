/**
 * Memory Update Node — runs at the end of each session.
 *
 * Writes structured memory to docs/memory/ in the target repo:
 *   patterns.md  — Architecture invariants + design patterns (AI curates)
 *   context.md   — Tech stack, config, commands, gotchas (AI curates)
 *   active.md    — Current focus, recent changes, open questions (AI rewrites)
 *   log.md       — Append-only session history (machine-written, no AI)
 *
 * All changes are committed to git so they land on GitHub alongside the feature branch.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generateText } from "ai";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { safeExec } from "#utils/exec.js";
import {
  readMemoryFile,
  writeMemoryFile,
  appendSessionLog,
  initMemory,
} from "#docs/memory.js";

const TODAY = () => new Date().toISOString().slice(0, 10);

async function commitMemory(projectDir, issueNumber = null) {
  try {
    const { stdout } = await safeExec(
      `git status --porcelain "docs/memory/"`,
      { cwd: projectDir },
    ).catch(() => ({ stdout: "" }));
    if (!stdout?.trim()) return;
    const ref = issueNumber ? ` (#${issueNumber})` : "";
    await safeExec(
      `git add "docs/memory/" && git commit -m "memory: update after session ${TODAY()}${ref}"`,
      { cwd: projectDir },
    ).catch(() => {});
    log(colors.dim("  [Memory] Committed docs/memory/ to git."));
  } catch { /* non-fatal */ }
}

function buildCurationPrompt({ task, researchSummary, lastResponse, executionErrors, modifiedFiles, subtasks, existingPatterns, existingContext }) {
  const taskSnippet = String(task || "").slice(0, 400);
  const errContext = executionErrors?.length
    ? `\nErrors encountered:\n${executionErrors.map((e) => `- ${e.tool}: ${e.summary}`).join("\n")}`
    : "";
  const subtaskList = (subtasks || []).length > 0
    ? `\nSubtasks:\n${subtasks.map((s, i) => `  ${i + 1}. ${String(s?.task || s || "").slice(0, 100)}`).join("\n")}`
    : "";

  return `You are a project memory curator. A software agent just completed a task on a codebase.
Your job is to update three structured memory files based on what was learned this session.
Only record facts that are non-obvious and would help a future AI agent work faster or avoid repeating mistakes.

[SESSION SUMMARY]
Task: ${taskSnippet}
Research: ${(researchSummary || "").slice(0, 600)}
Files modified: ${(modifiedFiles || []).join(", ") || "(none)"}
Last agent response: ${(lastResponse || "").slice(0, 800)}${errContext}${subtaskList}

[EXISTING patterns.md]
${existingPatterns}

[EXISTING context.md]
${existingContext}

Produce EXACTLY three sections separated by the markers shown. Do not add any other text.

=== PATTERNS ===
(Full updated content for patterns.md — architecture invariants and design patterns.
Keep existing entries unless clearly outdated. Add new invariants for: deleted functions that handled data transformation, severed pipeline connections, or broken features caused by the agent misunderstanding a helper's role.
Format: "# Architecture Patterns\\n\\n## Invariants\\n- ...\\n\\n## Design Patterns\\n- ...")

=== CONTEXT ===
(Full updated content for context.md — tech stack, config, commands, gotchas.
Add only confirmed non-obvious facts from this session. Keep existing entries.
Format: "# Technical Context\\n\\n## Stack\\n...\\n\\n## Configuration\\n...\\n\\n## Commands\\n...\\n\\n## Gotchas\\n...")

=== ACTIVE ===
(Full updated content for active.md — current state after this session.
Rewrite from scratch: what was just worked on, what changed, any open questions or follow-ups.
Format: "# Active Context\\n\\n## Current Focus\\n...\\n\\n## Recent Changes\\n...\\n\\n## Open Questions\\n...")

Rules:
- One bullet per fact, max one line
- Only facts actually observed this session or already present — never invent
- DELETION DETECTION: If a subtask says "remove/delete/replace" a function — add an invariant explaining what was removed and what must replace it
- Omit subsections with nothing to add but keep all headings`;
}

function parseAiOutput(text) {
  const sections = {};
  const markers = ["PATTERNS", "CONTEXT", "ACTIVE"];
  for (let i = 0; i < markers.length; i++) {
    const start = text.indexOf(`=== ${markers[i]} ===`);
    if (start < 0) continue;
    const contentStart = start + `=== ${markers[i]} ===`.length;
    const nextMarker = markers[i + 1] ? text.indexOf(`=== ${markers[i + 1]} ===`, contentStart) : -1;
    const content = (nextMarker > 0 ? text.slice(contentStart, nextMarker) : text.slice(contentStart)).trim();
    if (content.length > 20) sections[markers[i]] = content;
  }
  return sections;
}

export async function memoryUpdateNode(state) {
  if (!state.projectDir) return {};

  // Benchmark workspaces are ephemeral — memory is reset on every run.
  // Skip the AI curation step (which takes 20-45s) and the git commit.
  if (state.benchmarkScenarioId) {
    log(colors.dim("  [Graph] -> 🧠 Memory update skipped (benchmark run)."));
    return {};
  }

  log(colors.dim("  [Graph] -> 🧠 Updating memory bank..."));
  eventBus.emit("system_message", { text: "🧠 Updating project memory…", type: "info" });

  await initMemory(state.projectDir).catch(() => {});

  // Extract issue number from branch name for git commit attribution
  let issueNumber = state.githubOptions?.issueNumber || null;
  if (!issueNumber && state.projectDir) {
    try {
      const { stdout } = await safeExec("git rev-parse --abbrev-ref HEAD", { cwd: state.projectDir });
      const branchMatch = stdout?.trim().match(/copilot\/\d{4}-\d{2}-\d{2}-(\d+)-/);
      if (branchMatch) issueNumber = parseInt(branchMatch[1], 10);
    } catch { /* non-fatal */ }
  }

  const task = state.messages?.[0]?.content || "";
  const outcome = state.verificationFeedback || "UNKNOWN";
  const modifiedFiles = state.modifiedFiles || [];

  // Always append to log.md — no AI involved, no hallucination risk.
  try {
    await appendSessionLog(state.projectDir, { task, outcome, modifiedFiles });
    log(colors.dim("  [Memory] Session log updated."));
  } catch (err) {
    log(colors.yellow(`  [Memory] Log append failed (non-fatal): ${err.message}`));
  }

  // If no SDK model (automation-API-only mode), skip AI curation.
  if (!state.model) {
    await commitMemory(state.projectDir, issueNumber);
    log(colors.dim("  [Memory] No model — skipped AI curation, committed log only."));
    return {};
  }

  const [existingPatterns, existingContext] = await Promise.all([
    readMemoryFile(state.projectDir, "patterns.md"),
    readMemoryFile(state.projectDir, "context.md"),
  ]);

  const prompt = buildCurationPrompt({
    task,
    researchSummary: state.researchSummary,
    lastResponse: state.lastCoderResponse,
    executionErrors: state.lastExecutionErrors,
    modifiedFiles,
    subtasks: state.subtasks,
    existingPatterns,
    existingContext,
  });

  try {
    const { text } = await generateText({
      model: state.model,
      messages: [{ role: "user", content: prompt }],
    });

    const sections = parseAiOutput(text);

    const writes = [];
    if (sections.PATTERNS) writes.push(writeMemoryFile(state.projectDir, "patterns.md", sections.PATTERNS + "\n"));
    if (sections.CONTEXT)  writes.push(writeMemoryFile(state.projectDir, "context.md",  sections.CONTEXT  + "\n"));
    if (sections.ACTIVE)   writes.push(writeMemoryFile(state.projectDir, "active.md",   sections.ACTIVE   + "\n"));
    await Promise.all(writes);

    log(colors.green(`  [Memory] Updated: ${Object.keys(sections).join(", ") || "(none)"}`));
  } catch (err) {
    log(colors.yellow(`  [Memory] AI curation failed (non-fatal): ${err.message}`));
  }

  await commitMemory(state.projectDir, issueNumber);

  // Persist reflexion lessons for cross-session learning (Shinn et al. 2023).
  // Lessons accumulated during THIS session are appended to docs/memory/reflexion.md
  // so contextRetrieverNode can inject them into future sessions.
  const newLessons = (state.reflexionMemory || []).filter((m) => !m.positive);
  if (newLessons.length > 0) {
    try {
      const memDir = path.join(state.projectDir, "docs", "memory");
      await mkdir(memDir, { recursive: true });
      const memFile = path.join(memDir, "reflexion.md");
      const date = TODAY();
      const entries = newLessons.map((m) => `- [${date}] ${m.lesson}`).join("\n");
      await appendFile(memFile, `\n${entries}\n`);
      log(colors.dim(`  [Memory] Persisted ${newLessons.length} reflexion lesson(s) to reflexion.md`));
    } catch (err) {
      log(colors.yellow(`  [Memory] Reflexion persist failed (non-fatal): ${err.message}`));
    }
  }

  return {};
}
