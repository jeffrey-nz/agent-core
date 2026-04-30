import path from "node:path";
import { colors } from "#app/ui/colors.js";
import { logToFileOnly } from "#app/ui/fileLogger.js";
import { logRaw } from "#app/ui/log.js";
import { createSpinner } from "#app/ui/spinner.js";
import { runPtyCommand } from "./ptyRunner.js";
import { formatBashResult } from "./formatter.js";

export async function executeBash(rootDir, reqBash) {
  let feedback = "";

  const commands = Array.isArray(reqBash) ? reqBash : [reqBash];

  for (let cmd of commands) {
    let cwd = rootDir;

    const cdPrefixMatch = cmd
      .trim()
      .match(/^cd\s+([^&;]+)\s*(?:&&|;)\s*([\s\S]+)/);

    if (cdPrefixMatch) {
      const targetDir = cdPrefixMatch[1].trim().replace(/['"]/g, "");
      cwd = path.resolve(rootDir, targetDir);
      cmd = cdPrefixMatch[2].trim();
    } else if (
      (cmd.trim().startsWith("cd ") || cmd.trim() === "cd") &&
      !cmd.includes("&&") &&
      !cmd.includes(";")
    ) {
      const displayCmd = cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd;
      logRaw(
        `  ${colors.yellow("⚠️")} Ignored stateful cd command: ${displayCmd}`,
      );
      feedback += `<bash_result cmd="${cmd}">\n[SYSTEM WARNING]\nThe 'execute_bash' tool is STATELESS. Changing directories using isolated 'cd' has no effect. Chain your commands (e.g., cd folder && command) or use absolute paths.\n</bash_result>\n\n`;
      continue;
    }

    logToFileOnly(
      `\n▶ Executing bash (TTY): ${cmd}\nStreaming output below:\n` +
        "─".repeat(60),
    );

    const displayCmd = cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
    const spinner = createSpinner(
      colors.dim(`  - Executing bash: ${displayCmd}`),
    ).start();

    const res = await runPtyCommand(cmd, cwd, spinner);

    logToFileOnly("\n" + "─".repeat(60));
    logToFileOnly(
      `\n--- BASH EXECUTION: ${cmd} ---\n[EXIT CODE: ${res.status}]\n[STDOUT/STDERR]\n${res.output}\n------------------------------\n`,
    );

    feedback += formatBashResult(res, cmd, cwd, displayCmd, spinner);
  }

  return feedback;
}
