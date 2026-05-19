import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { fileExists } from "./utils.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function checkStaticAnalysis(
  projectDir,
  { phpFiles, tsFiles, jsFiles, goFiles = [] },
) {
  const errors = [];

  if (tsFiles.length > 0) {
    // Prefer tsconfig.app.json (Vite projects), fall back to tsconfig.json
    const tsconfigApp = path.join(projectDir, "tsconfig.app.json");
    const tsconfigRoot = path.join(projectDir, "tsconfig.json");
    const hasTsconfigApp = await fileExists(tsconfigApp);
    const hasTsconfigRoot = await fileExists(tsconfigRoot);
    if (hasTsconfigApp || hasTsconfigRoot) {
      // Skip TypeScript check if node_modules isn't populated — npm install may not have
      // completed yet (timed out or in progress). Running tsc without packages installed
      // produces false "cannot find module 'react'" errors that revert good code.
      const nodeModulesExists = await fileExists(path.join(projectDir, "node_modules"));
      const hasLocalTsc = await fileExists(path.join(projectDir, "node_modules", ".bin", "tsc"));
      const hasReactTypes = await fileExists(path.join(projectDir, "node_modules", "@types", "react"));
      const packagesReady = nodeModulesExists && (hasLocalTsc || hasReactTypes);
      if (!packagesReady) {
        // Attempt a quick install using the offline cache before giving up.
        // With cached packages (--prefer-offline), this typically completes in ~1s.
        log(colors.dim("  [Verifier] node_modules not ready — attempting npm install --prefer-offline..."));
        const installRes = await execAsync("npm install --prefer-offline", { cwd: projectDir, timeout: 300000 });
        const hasLocalTscAfter = await fileExists(path.join(projectDir, "node_modules", ".bin", "tsc"));
        if (!hasLocalTscAfter) {
          if (installRes.status !== 0) {
            log(colors.yellow(`  [Verifier] npm install failed (exit ${installRes.status}) — skipping TypeScript check`));
          } else {
            log(colors.dim("  [Verifier] npm install succeeded but tsc not found — skipping TypeScript check"));
          }
        } else {
          // Install succeeded — fall through to run the TypeScript check below
          log(colors.dim("  [Verifier] npm install --prefer-offline completed. Running TypeScript check..."));
        }
        if (!hasLocalTscAfter) {
          // truly can't check — skip
        } else {
          const flag = hasTsconfigApp ? "-p tsconfig.app.json" : "";
          const res = await execAsync(`npx tsc --noEmit ${flag}`, { cwd: projectDir });
          if (res.status !== 0)
            errors.push(`TypeScript Compilation Error:\n${res.stdout || res.stderr}`);
        }
      } else {
        log(colors.dim("  [Verifier] Running TypeScript compiler check..."));
        const flag = hasTsconfigApp ? "-p tsconfig.app.json" : "";
        const res = await execAsync(`npx tsc --noEmit ${flag}`, { cwd: projectDir });
        if (res.status !== 0)
          errors.push(`TypeScript Compilation Error:\n${res.stdout || res.stderr}`);
      }
    }
  }

  // Only run ESLint if there is an explicit ESLint config in the project.
  // ESLint ships as a Vite/React peer dep but without a config it rejects
  // TypeScript syntax ("interface is reserved"). Require a config file to
  // confirm the project actually intends to enforce lint rules.
  const eslintConfigExists =
    (await fileExists(path.join(projectDir, ".eslintrc.js"))) ||
    (await fileExists(path.join(projectDir, ".eslintrc.cjs"))) ||
    (await fileExists(path.join(projectDir, ".eslintrc.json"))) ||
    (await fileExists(path.join(projectDir, ".eslintrc.yml"))) ||
    (await fileExists(path.join(projectDir, ".eslintrc.yaml"))) ||
    (await fileExists(path.join(projectDir, ".eslintrc"))) ||
    (await fileExists(path.join(projectDir, "eslint.config.js"))) ||
    (await fileExists(path.join(projectDir, "eslint.config.cjs"))) ||
    (await fileExists(path.join(projectDir, "eslint.config.mjs")));

  // Also require @typescript-eslint/parser when linting TS files, otherwise
  // ESLint treats TypeScript syntax as invalid JavaScript.
  const hasTypescriptParser = tsFiles.length === 0 ||
    (await fileExists(path.join(projectDir, "node_modules", "@typescript-eslint", "parser")));

  // Exclude ESLint and other tooling config files from being linted — they import
  // plugins that may not be installed, causing false failures.
  const LINT_EXCLUDES = /eslint\.config\.|eslint\.setup\.|\.eslintrc|vite\.config\.|jest\.config\.|babel\.config\./;
  const lintableJs = jsFiles.filter((f) => !LINT_EXCLUDES.test(path.basename(f)));
  const lintableTs = tsFiles.filter((f) => !LINT_EXCLUDES.test(path.basename(f)));

  if (
    (lintableJs.length > 0 || lintableTs.length > 0) &&
    (await fileExists(path.join(projectDir, "node_modules", "eslint"))) &&
    eslintConfigExists &&
    hasTypescriptParser
  ) {
    log(colors.dim("  [Verifier] Running ESLint check..."));
    const filesToLint = [...lintableJs, ...lintableTs].map((f) => `"${f}"`).join(" ");
    const res = await execAsync(`npx eslint ${filesToLint}`, {
      cwd: projectDir,
    });
    if (res.status !== 0)
      errors.push(`ESLint Error:\n${res.stdout || res.stderr}`);
  }

  // Chess/game antipattern check: detect legalMoves={[]} hardcoded empty array in JSX.
  // This is a common bug where App.tsx wires the ChessBoard but passes empty moves,
  // breaking legal-move highlighting. Check all TSX files in the project.
  if (tsFiles.length > 0) {
    try {
      const { readFile: fsReadFile } = await import("node:fs/promises");
      for (const f of tsFiles.filter(f => f.endsWith(".tsx"))) {
        const content = await fsReadFile(f, "utf8").catch(() => "");
        // Detect: legalMoves={[]} pattern (hardcoded empty array passed as prop)
        if (/legalMoves=\{(\[\]|new Array\(\)|Array\.from\(\))\}/i.test(content)) {
          errors.push(
            `Chess Game Integration Error in ${f.replace(projectDir + "/", "")}: ` +
            `legalMoves is hardcoded to [] — it must be the legalMoves state returned by useChessGame hook. ` +
            `Fix: ensure useChessGame returns legalMoves and pass it as legalMoves={legalMoves}.`
          );
        }
      }
    } catch { /* non-fatal */ }
  }

  // Go build + vet: runs when any .go files were modified.
  // Build check first — catches compilation errors (undefined names, type mismatches,
  // missing imports). Only run vet if build succeeds; vet output on non-compiling code
  // mixes build errors and semantic warnings in a confusing way.
  if (goFiles.length > 0 && (await fileExists(path.join(projectDir, "go.mod")))) {
    log(colors.dim("  [Verifier] Running go build..."));
    const buildRes = await execAsync("go build ./... 2>&1", { cwd: projectDir, timeout: 60000 });
    const buildOut = (buildRes.stdout || buildRes.stderr || "").trim();
    if (/command not found|No such file/i.test(buildOut)) {
      log(colors.dim("  [Verifier] go not available — skipping Go build/vet"));
    } else if (buildRes.status !== 0 && buildOut.length > 0) {
      errors.push(
        `Go Build Error:\n${buildOut}\n\n` +
        `Common causes: undefined variable/function, type mismatch, missing import, wrong package name.\n` +
        `Run \`go mod tidy\` if you see "no required module provides package" errors.\n` +
        `Fix all build errors above before this subtask can pass.`,
      );
    } else {
      // Build succeeded — run go vet to catch semantic issues
      log(colors.dim("  [Verifier] Running go vet..."));
      const vetRes = await execAsync("go vet ./... 2>&1", { cwd: projectDir, timeout: 30000 });
      const vetOut = (vetRes.stdout || vetRes.stderr || "").trim();
      if (vetRes.status !== 0 && vetOut.length > 0 && !/command not found|No such file/i.test(vetOut)) {
        errors.push(`Go Vet Error:\n${vetOut}\n\nFix all vet issues before this subtask can pass.`);
      }
    }
  }

  if (
    phpFiles.length > 0 &&
    (await fileExists(path.join(projectDir, "phpstan.neon")))
  ) {
    log(colors.dim("  [Verifier] Running PHPStan static analysis..."));
    const res = await execAsync(
      `vendor/bin/phpstan analyse ${phpFiles.map((f) => `"${f}"`).join(" ")} --error-format=raw`,
      { cwd: projectDir },
    );
    if (res.status !== 0)
      errors.push(`PHPStan Error:\n${res.stdout || res.stderr}`);
  }

  return errors;
}
