import { execAsync, safeExec } from "#utils/exec.js";
import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { logToFileOnly, streamToFileOnly } from "#app/ui/fileLogger.js";
import { buildEnvironment } from "./env.js";
import { formatComposerResult } from "./format.js";

export async function handleComposer(input, rootDir) {
  const cwd = input.working_dir || rootDir;
  let cmdStr =
    input.command ??
    (Array.isArray(input.args) ? input.args.join(" ") : undefined);
  if (!cmdStr) return "[ERROR] run_composer requires a command or args";

  const showMatch = cmdStr.match(/^show\s+([^:\s]+):([^\s]+)(.*)$/);
  if (showMatch) cmdStr = `show ${showMatch[1]} ${showMatch[2]}${showMatch[3]}`;
  if (cmdStr.trim().startsWith("show"))
    cmdStr = cmdStr.replace(/--no-progress/g, "").trim();

  const cmd = cmdStr.includes("--no-interaction")
    ? `composer ${cmdStr}`
    : `composer ${cmdStr} --no-interaction`;

  const timeoutMs =
    cmdStr.includes("update") ||
    cmdStr.includes("install") ||
    cmdStr.includes("require")
      ? 1800000
      : 60000;

  const env = await buildEnvironment(cwd);

  if (cmd.startsWith("composer show ")) {
    const args = cmd
      .split(" ")
      .filter((p) => !p.startsWith("-") && p !== "composer" && p !== "show");
    if (args.length > 1) {
      logToFileOnly(`  ⚡ Note: Splitting multi-package show command.`);
      let combinedOutput = "",
        combinedError = "",
        finalStatus = 0;
      for (const pkg of args) {
        const subRes = await execAsync(
          `composer show ${pkg} --no-interaction`,
          { cwd, timeout: 30000, env },
        );
        combinedOutput += `--- Show: ${pkg} ---\n${subRes.stdout}\n\n`;
        if (subRes.status !== 0) {
          combinedError += `Error showing ${pkg}: ${subRes.stderr}\n`;
          finalStatus = subRes.status;
        }
      }
      return formatComposerResult(
        {
          status: finalStatus,
          stdout: combinedOutput,
          stderr: combinedError,
          success: finalStatus === 0,
        },
        cmd,
        cwd,
      );
    }
  }

  logToFileOnly(
    `\n▶ Running composer: ${cmd}\nStreaming output below:\n` + "─".repeat(60),
  );
  const displayCmd = cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
  const spinner = createSpinner(
    colors.dim(`  - Composer: ${displayCmd}`),
  ).start();

  const onData = (chunk) => {
    const text = chunk.toString();
    streamToFileOnly(text);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      const cleanLine = lines[lines.length - 1].replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        "",
      );
      spinner.update(
        colors.dim(
          `  - Composer: ${cleanLine.length > 60 ? cleanLine.slice(0, 57) + "..." : cleanLine}`,
        ),
      );
    }
  };

  const result = await safeExec(cmd, { cwd, timeout: timeoutMs, env, onData });
  logToFileOnly("\n" + "─".repeat(60));

  if (result.success)
    spinner.succeed(colors.dim(`  - Composer complete: ${displayCmd}`));
  else
    spinner.fail(
      colors.red(`  - Composer failed (Exit ${result.status}): ${displayCmd}`),
    );

  return formatComposerResult(result, cmd, cwd);
}
