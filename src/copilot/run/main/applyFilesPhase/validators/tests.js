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

  if (jsTestFiles.length > 0 && !(await fileExists(path.join(projectDir, "package.json")))) {
    // Fail loudly rather than silently skipping — a "passing" verifier with no
    // package.json means the tests never ran and the result is a false positive.
    errors.push(
      `JS/TS Test Failure: package.json is missing — tests cannot run without it.\n\n` +
      `The coder wrote test files but did not create the project scaffold. ` +
      `You MUST create package.json with the correct dependencies (react, react-dom, vite, ` +
      `@vitejs/plugin-react, vitest, @testing-library/react if needed) so that Vitest can be installed and run.`
    );
  }

  if (
    jsTestFiles.length > 0 &&
    (await fileExists(path.join(projectDir, "package.json")))
  ) {
    // Ensure dependencies are installed before running tests. For brand-new
    // projects the coder may write package.json + source files in one subtask
    // but skip the npm install step — the tests would always fail without this.
    const nodeModulesExists = await fileExists(path.join(projectDir, "node_modules"));
    if (!nodeModulesExists) {
      log(colors.dim("  [Verifier] node_modules missing — running npm install..."));
      const installRes = await execAsync("npm install", { cwd: projectDir });
      if (installRes.status !== 0) {
        errors.push(`npm install failed:\n${installRes.stdout || installRes.stderr}`);
        return errors;
      }
      log(colors.green("  [Verifier] npm install succeeded."));
    }

    log(colors.dim("  [Verifier] Running JS/TS tests..."));

    const res = await execAsync(
      `npx vitest run ${jsTestFiles.map((f) => `"${f}"`).join(" ")} --passWithNoTests || npx jest ${jsTestFiles.map((f) => `"${f}"`).join(" ")} --passWithNoTests`,
      { cwd: projectDir },
    );
    if (res.status !== 0) {
      const rawOutput = res.stdout || res.stderr || "";
      // Extract "Cannot find module './X'" errors and give the coder specific guidance
      // instead of a generic test failure — prevents the "test before source" failure loop.
      const missingModuleMatches = [...rawOutput.matchAll(/Cannot find module ['"]([^'"]+)['"]/g)];
      if (missingModuleMatches.length > 0) {
        const missingPaths = [...new Set(missingModuleMatches.map((m) => m[1]))];
        const hint =
          `\n\nROOT CAUSE — MISSING SOURCE FILE(S):\n` +
          missingPaths.map((p) => `  • The test imports '${p}' but that file does not exist yet.`).join("\n") +
          `\n\nFIX: You MUST create the source file(s) BEFORE the test file can pass.\n` +
          `For each missing module above, use write_file to create it with the exported functions/classes the test expects.\n` +
          `Do NOT rewrite the test file — create the implementation file first.`;
        errors.push(`JS/TS Test Failure:\n${rawOutput}${hint}`);
      } else {
        errors.push(`JS/TS Test Failure:\n${rawOutput}`);
      }
    } else {
      log(colors.green("  [Verifier] JS/TS tests passed! 🟢"));
    }
  }

  return errors;
}
