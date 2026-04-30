import fs from "node:fs";
import path from "node:path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { askLineWithTimeout } from "#app/ui/readline/index.js";
import { logPhase } from "#app/ui/phases.js";
import {
  suspendDashboardForPrompt,
  resumeDashboardAfterPrompt,
} from "#app/ui/dashboard.js";
import { isWebMode } from "#web/mode.js";
import { webPromptFeedback } from "#web/inputBridge.js";

export async function askForHumanFeedback(rl, context = {}) {
  logPhase(
    "PHASE 3",
    "HUMAN FEEDBACK & WORKFLOW",
    "Awaiting manual verification of applied changes",
  );

  // Check for fresh verification marker to skip manual prompt
  const markerPath = path.join(process.cwd(), ".verification_complete.txt");
  if (fs.existsSync(markerPath)) {
    const mtime = fs.statSync(markerPath).mtimeMs;
    if (Date.now() - mtime < 3600000) { // less than 1 hour old
      log(colors.dim("\n  Verification marker fresh - skipping manual prompt."));
      return "";
    }
  }

  const { diffStat, completedCount } = context;

  // Build a short summary of what the agent accomplished.
  const summaryParts = [];
  if (completedCount > 0) {
    summaryParts.push(`${completedCount} subtask(s) completed`);
  }
  if (diffStat) {
    summaryParts.push(diffStat);
  }
  const summary = summaryParts.join("\n");

  if (isWebMode()) {
    const message = summary
      ? `Task complete.\n\n${summary}\n\nReview the changes and type an adjustment request, or leave blank and submit to finish.`
      : "Task complete. Review the changes and type an adjustment request, or leave blank and submit to finish.";
    return webPromptFeedback(message);
  }

  suspendDashboardForPrompt();

  log(`\n${colors.green("✓ Task complete.")} Review the applied changes.`);
  if (summary) {
    log(colors.dim(`\n${summary}`));
  }
  log(
    `\n  ${colors.green("Enter")}               - done, finish session`,
  );
  log(
    `  ${colors.yellow("Type adjustment")}     - send a follow-up request to the AI`,
  );
  log(
    `  ${colors.magenta("exit")} / ${colors.magenta("done")}         - same as Enter`,
  );

  const answer = await askLineWithTimeout(
    rl,
    colors.cyan("\nAdjustment (or Enter to finish): "),
    300000,
    "",
  );

  resumeDashboardAfterPrompt();
  return String(answer || "").trim();
}
