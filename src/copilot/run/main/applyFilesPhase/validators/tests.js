import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { fileExists } from "./utils.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function checkTests(projectDir, { phpTestFiles, jsTestFiles }) {
  const errors = [];

  if (
    phpTestFiles.length > 0 &&
    (await fileExists(path.join(projectDir, "vendor/bin/phpunit")))
  ) {
    log(colors.dim("  [Verifier] Running PHPUnit tests..."));
    const res = await execAsync(
      `vendor/bin/phpunit ${phpTestFiles.map((f) => `"${f}"`).join(" ")}`,
      { cwd: projectDir },
    );
    if (res.status !== 0) {
      errors.push(`PHPUnit Test Failure:\n${res.stdout || res.stderr}`);
    } else {
      log(colors.green("  [Verifier] PHPUnit tests passed! 🟢"));
    }
  }

  if (
    jsTestFiles.length > 0 &&
    (await fileExists(path.join(projectDir, "package.json")))
  ) {
    log(colors.dim("  [Verifier] Running JS/TS tests..."));

    const res = await execAsync(
      `npx vitest run ${jsTestFiles.map((f) => `"${f}"`).join(" ")} --passWithNoTests || npx jest ${jsTestFiles.map((f) => `"${f}"`).join(" ")} --passWithNoTests`,
      { cwd: projectDir },
    );
    if (res.status !== 0) {
      errors.push(`JS/TS Test Failure:\n${res.stdout || res.stderr}`);
    } else {
      log(colors.green("  [Verifier] JS/TS tests passed! 🟢"));
    }
  }

  return errors;
}
