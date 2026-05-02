import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { fileExists } from "./utils.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function checkStaticAnalysis(
  projectDir,
  { phpFiles, tsFiles, jsFiles },
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

  if (
    (jsFiles.length > 0 || tsFiles.length > 0) &&
    (await fileExists(path.join(projectDir, "node_modules", "eslint")))
  ) {
    log(colors.dim("  [Verifier] Running ESLint check..."));
    const filesToLint = [...jsFiles, ...tsFiles].map((f) => `"${f}"`).join(" ");
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
