import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { logToFileOnly, streamToFileOnly } from "#app/ui/fileLogger.js";
import { smartExtractErrors } from "../utils.js";
import { safeExec } from "#utils/exec.js";

export async function handlePhpUnit(input, rootDir) {
  const cwd = input.working_dir || rootDir;
  if (!cwd) {
    return `<phpunit_result>\n[ERROR] working_dir is required but was not provided and no project root is available.\n</phpunit_result>`;
  }
  const bin = `${cwd}/vendor/bin/phpunit`;
  let cmd = `"${bin}"`;

  if (input.config) cmd += ` --configuration "${input.config}"`;
  if (input.filter) cmd += ` --filter "${input.filter}"`;

  logToFileOnly(
    `\n▶ Running PHPUnit: ${cmd}\nStreaming output below:\n` + "─".repeat(60),
  );

  const displayFilter = input.filter ? ` (${input.filter})` : "";
  const spinner = createSpinner(
    colors.dim(`  - PHPUnit${displayFilter} running...`),
  ).start();

  const onData = (chunk) => {
    const text = chunk.toString();
    streamToFileOnly(text);

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      const lastLine = lines[lines.length - 1];
      const cleanLine = lastLine.replace(
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
        "",
      );
      const shortLine =
        cleanLine.length > 60 ? cleanLine.slice(0, 57) + "..." : cleanLine;
      spinner.update(colors.dim(`  - [phpunit] ${shortLine}`));
    }
  };

  const result = await safeExec(cmd, { cwd, timeout: 300000, onData });
  logToFileOnly("\n" + "─".repeat(60));
  const out = smartExtractErrors(result.stdout || "");
  const err = smartExtractErrors(result.stderr || "");
  if (result.success) {
    spinner.succeed(colors.dim(`  - PHPUnit complete (Success)`));
    return (
      `<phpunit_result cwd="${cwd}">\n` +
      `[EXIT CODE: 0]\n${out || "(empty)"}\n` +
      `</phpunit_result>`
    );
  }
  spinner.fail(colors.red(`  - PHPUnit failed (Exit ${result.status})`));
  return (
    `<phpunit_result cwd="${cwd}">\n` +
    `[EXIT CODE: ${result.status}]\n[STDERR]\n${err}\n[STDOUT]\n${out}\n` +
    `</phpunit_result>`
  );
}
