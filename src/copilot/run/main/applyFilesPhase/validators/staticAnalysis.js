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
        log(colors.dim("  [Verifier] Skipping TypeScript check — node_modules not populated yet (npm install may still be in progress)."));
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
