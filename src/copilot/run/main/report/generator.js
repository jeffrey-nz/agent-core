import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { log } from "#app/ui/log.js";
import { getGitChangedFiles, getGitDiffStat } from "./gitStats.js";
import { buildSummaryPrompt } from "./prompt.js";

export async function generateSuccessReport({
  copilot,
  gitDir,
  projectId,
  projectDir,
  projectTitle,
  promptText,
  applyRes,
}) {
  const safeId = String(projectId || "default").replace(/[^a-zA-Z0-9-_]/g, "_");
  const baseDir = path.join(process.cwd(), "copilot-reports", safeId);
  await fs.mkdir(baseDir, { recursive: true }).catch(() => {});

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportName = `copilot-report-${timestamp}.txt`;
  const reportPath = path.join(baseDir, reportName);

  const changedFiles = await getGitChangedFiles(gitDir || projectDir);
  const diffStat = await getGitDiffStat(gitDir || projectDir);

  const lines = [];
  lines.push("COPILOT-HELPER REPORT");
  lines.push("=====================");
  lines.push(`Generated : ${new Date().toLocaleString()}`);
  if (projectTitle) lines.push(`Project   : ${projectTitle}`);
  lines.push("");

  lines.push("TASK");
  lines.push("----");
  lines.push((promptText || "(no prompt text recorded)").trim());
  lines.push("");

  lines.push("RESULT");
  lines.push("------");
  lines.push(
    `${applyRes?.applied ?? 0} file operation(s) applied successfully.`,
  );
  lines.push("");

  if (changedFiles) {
    lines.push("FILES CHANGED");
    lines.push("-------------");
    lines.push(changedFiles);
    lines.push("");
  }

  if (diffStat) {
    lines.push("GIT DIFF SUMMARY");
    lines.push("----------------");
    lines.push(diffStat);
    lines.push("");
  }

  let summaryText = null;
  if (copilot) {
    try {
      log(`\n📄 Asking AI to write a plain-English summary for the report...`);
      const prompt = buildSummaryPrompt({
        promptText,
        projectTitle,
        applyRes,
        changedFiles,
        diffStat,
      });

      const messages = [{ role: "user", content: prompt }];
      const res = await copilot.sendTurn(messages, "report-summary", {
        interactionMode: "readOnly",
        requireWriteFile: false,
        readOnly: true,
      });

      if (res?.ok && res.text?.trim()) {
        summaryText = res.text
          .replace(/\x1b\[[0-9;]*m/g, "")
          .replace(/<file[^>]*>[\s\S]*?<\/file>/gi, "")
          .replace(/<patch[^>]*>[\s\S]*?<\/patch>/gi, "")
          .trim();
      }
    } catch (err) {
      log(`\n⚠️  Could not get Copilot summary: ${err.message}`);
    }
  }

  if (summaryText) {
    lines.push("WHAT THE AI DID & HOW TO USE IT");
    lines.push("--------------------------------");
    lines.push(summaryText);
    lines.push("");
  }

  try {
    await fs.writeFile(reportPath, lines.join("\n"), "utf8");
    log(`\n📄 Report saved: ${reportPath}`);
    return reportPath;
  } catch (err) {
    log(`\n⚠️  Could not write report: ${err.message}`);
    return null;
  }
}
