import fs from "node:fs/promises";
import path from "node:path";
import { safeExec } from "#utils/exec.js";
import { createSpinner } from "#app/ui/spinner.js";
import { colors } from "#app/ui/colors.js";

export async function handleLint(input, rootDir) {
  const target = input.path;
  const absTarget = path.resolve(rootDir, target);
  const safeTarget = String(target || "").replace(/"/g, "&quot;");

  const spinner = createSpinner(
    colors.dim(`  - Linting PHP: ${target}`),
  ).start();

  try {
    await fs.access(absTarget);
  } catch {
    spinner.fail(colors.dim(`  - PHP Lint: Path not found -> ${target}`));
    return `<lint_result path="${safeTarget}">\n[PHP_LINT] 0 file(s) OK, 1 error(s) found\nError: Path does not exist -> ${target}\n</lint_result>`;
  }

  const cmd = target.endsWith(".php")
    ? `php -l "${target}"`
    : `find "${target}" -name "*.php" -not -path "*/vendor/*" | xargs php -l 2>&1`;

  const result = await safeExec(cmd, { cwd: rootDir, timeout: 120000 });
  const combined = (
    (result.stdout || "") +
    "\n" +
    (result.stderr || "")
  ).trim();
  const lines = combined.split("\n").filter(Boolean);
  const passing = lines.filter((l) =>
    l.includes("No syntax errors detected in"),
  );
  const errorLines = lines.filter(
    (l) => !l.includes("No syntax errors detected in"),
  );
  const summary = `${passing.length} file(s) OK, ${errorLines.length} error(s) found`;
  if (errorLines.length === 0) {
    spinner.succeed(colors.dim(`  - PHP Lint: ${summary}`));
    return `<lint_result path="${safeTarget}">\n[PHP_LINT] ${summary}\n</lint_result>`;
  }
  spinner.fail(colors.dim(`  - PHP Lint: ${summary}`));
  return `<lint_result path="${safeTarget}">\n[PHP_LINT] ${summary}\n${errorLines.join("\n")}\n</lint_result>`;
}
