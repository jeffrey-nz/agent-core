import fs from "node:fs/promises";
import path from "node:path";
import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { logToFileOnly, streamToFileOnly } from "#app/ui/fileLogger.js";
import { trimTail } from "../utils.js";
import { safeExec } from "#utils/exec.js";

async function findSakeBinary(cwd) {
  for (const bin of [
    "vendor/bin/sake",
    "vendor/silverstripe/framework/sake",
    "framework/sake",
  ]) {
    try {
      await fs.stat(path.join(cwd, bin));
      return `./${bin}`;
    } catch (e) {}
  }
  return null;
}

export async function handleSake(input, rootDir) {
  const cwd = input.working_dir || rootDir;
  const sakeBin = await findSakeBinary(cwd);

  if (!sakeBin) {
    return `<sake_result cwd="${cwd}">\n[ERROR] Could not find 'sake' binary in ${cwd}. Ensure framework is installed.\n</sake_result>`;
  }

  const cmd = `${sakeBin} ${input.command}`;
  const displayCmd =
    input.command.length > 50
      ? input.command.slice(0, 47) + "..."
      : input.command;

  logToFileOnly(
    `\n▶ Running sake: ${cmd}\nStreaming output below:\n` + "─".repeat(60),
  );
  const spinner = createSpinner(
    colors.dim(`  - sake ${displayCmd}...`),
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
          `  - [sake] ${cleanLine.length > 60 ? cleanLine.slice(0, 57) + "..." : cleanLine}`,
        ),
      );
    }
  };

  const result = await safeExec(cmd, { cwd, timeout: 300000, onData });
  logToFileOnly("\n" + "─".repeat(60));
  const out = trimTail(result.stdout || "");
  const err = trimTail(result.stderr || "");
  const is404Page =
    out.includes("<title>Page not found") || out.includes("404 Not Found");
  const combinedOutput = (out + "\n" + err).toLowerCase();
  const hasFatalError =
    combinedOutput.includes("fatal error:") ||
    combinedOutput.includes("error [emergency]") ||
    combinedOutput.includes("error [alert]") ||
    combinedOutput.includes("uncaught exception");
  if (result.success && !is404Page && !hasFatalError) {
    spinner.succeed(colors.dim(`  - sake complete: ${displayCmd}`));
    return `<sake_result cmd="${cmd}" cwd="${cwd}">\n[EXIT CODE: 0]\n[STDOUT]\n${out || "(empty)"}\n</sake_result>`;
  }
  const exitCode = is404Page
    ? "404"
    : hasFatalError && result.success
      ? "1 (Forced by Fatal Error)"
      : result.status;
  const errorMsg = is404Page
    ? "Sake treated your command as a URL and returned a 404. If you used 'dev/build' on SS6, try 'db:build'. If you used 'db:build' on SS4/5, try 'dev/build flush=all'."
    : err;
  spinner.fail(colors.red(`  - sake failed (Exit ${exitCode}): ${displayCmd}`));
  return `<sake_result cmd="${cmd}" cwd="${cwd}">\n[EXIT CODE: ${exitCode}]\n[STDERR]\n${errorMsg}\n[STDOUT]\n${out}\n</sake_result>`;
}
