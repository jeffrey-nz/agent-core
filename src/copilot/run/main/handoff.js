import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { getSafeId } from "#utils/format.js";

const HANDOFF_DIR = ".copilot-handoffs";

export async function writeHandoffReport(
  projectId,
  copilot,
  applyRes,
  options,
) {
  const { projectTitle, promptText, state } = options;
  log(`\n📄 Generating final project handoff report...`);

  let summary = "The project milestones completed successfully.";

  try {
    const res = await copilot.sendPromptAndWait(
      "The user has approved all component milestones and the overall project workflow is complete. Please write a final 'Handoff Report' summarizing what was accomplished across all iterations, the current state of the codebase, and any lingering architectural notes or 'gotchas'. Write the report directly in this chat message as plain text markdown — do not open any files, and do not use JSON tool calls.",
      "Generate Final Handoff",
    );
    if (res?.ok && res.text) {
      summary = res.text.replace(/```json[\s\S]*?```/gi, "").trim();
    }
  } catch (e) {
    log(colors.dim("  Failed to generate handoff via AI, using default."));
  }

  let subtaskSummary = "";
  if (state?.subtasks?.length) {
    subtaskSummary =
      "#### ✅ Completed Sub-tasks:\n" +
      state.subtasks.map((s) => `- ${s.task}`).join("\n") +
      "\n\n";
  }

  const content = `### FINAL PROJECT HANDOFF\n**Project:** ${projectTitle || "Unknown"}\n**Goal:** ${promptText || "N/A"}\n**Date:** ${new Date().toLocaleString()}\n\n${subtaskSummary}**AI Summary of Milestones Achieved:**\n${summary}\n`;

  const dir = path.join(process.cwd(), HANDOFF_DIR);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const outPath = path.join(dir, `${getSafeId(projectId)}.md`);

  try {
    await fs.writeFile(outPath, content, "utf8");
    log(colors.green(`✅ Final Handoff report saved to ${outPath}`));
  } catch (e) {
    log(colors.red(`❌ Could not write handoff report: ${e.message}`));
  }

  // Mirror to target repo docs so it lands on GitHub with the PR
  const targetRepoDir = options?.project?.targetRepoDir || null;
  if (targetRepoDir && summary) {
    try {
      const { writePage } = await import("#docs/index.js");
      const { safeExec } = await import("#utils/exec.js");
      await writePage({ projectDir: targetRepoDir, page: "Handoff", content });
      const { stdout } = await safeExec(`git status --porcelain docs/Handoff.md`, { cwd: targetRepoDir }).catch(() => ({ stdout: "" }));
      if (stdout?.trim()) {
        await safeExec(`git add docs/Handoff.md && git commit -m "docs: session handoff report"`, { cwd: targetRepoDir }).catch(() => {});
      }
      log(colors.dim(`  [GitHub] Handoff committed to docs/`));
    } catch {
      // Non-fatal
    }
  }
}
