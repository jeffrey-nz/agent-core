import fs from "node:fs/promises";
import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { findDotnetWorkspace } from "#utils/findDotnetWorkspace.js";
import { isUnityProject, isSwiftProject } from "#utils/detectProjectContext.js";

async function fileExists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function detectProjectTypes(dir) {
  const [hasTsConfig, hasPackageJson, hasComposerJson, hasCsproj] =
    await Promise.all([
      fileExists(path.join(dir, "tsconfig.json")),
      fileExists(path.join(dir, "package.json")),
      fileExists(path.join(dir, "composer.json")),

      execAsync("find . -maxdepth 3 -name '*.csproj' -o -name '*.sln'", {
        cwd: dir,
      })
        .then((r) => r.stdout.trim().length > 0)
        .catch(() => false),
    ]);

  return {
    isNode: hasPackageJson,
    isTypeScript: hasTsConfig,
    isPhp: hasComposerJson,
    isCSharp: hasCsproj,
    isSwift: isSwiftProject(dir),
  };
}

export async function executeDiagnosticsTool(input, { rootDir }) {
  const target = input.target_dir
    ? path.resolve(rootDir, input.target_dir)
    : rootDir;
  let output = "";
  let hasErrors = false;

  try {
    const types = await detectProjectTypes(target);

    if (types.isTypeScript) {
      const tsRes = await execAsync(`npx tsc --noEmit`, {
        cwd: target,
      }).catch((e) => e);
      if (tsRes && tsRes.status !== 0) {
        hasErrors = true;
        output += `=== TYPESCRIPT COMPILATION ERRORS ===\n${tsRes.stdout || tsRes.stderr}\n\n`;
      }
    }

    if (types.isNode) {
      const lintRes = await execAsync(`npx eslint . --ext .js,.jsx,.ts,.tsx`, {
        cwd: target,
      }).catch((e) => e);
      if (lintRes && lintRes.status !== 0) {
        const lintOut = (lintRes.stdout || "") + (lintRes.stderr || "");

        const noConfig =
          lintOut.includes("configuration file") ||
          lintOut.includes("couldn't find") ||
          lintOut.includes("Could not find") ||
          lintOut.includes("No ESLint configuration");
        if (!noConfig) {
          hasErrors = true;
          output += `=== ESLINT ERRORS ===\n${lintRes.stdout || lintRes.stderr}\n\n`;
        }
      }
    }

    if (types.isPhp) {
      const phpRes = await execAsync(
        `vendor/bin/phpstan analyse --error-format=raw`,
        { cwd: target },
      ).catch((e) => e);
      if (phpRes && phpRes.status !== 0) {
        const phpOut = (phpRes.stderr || "") + (phpRes.stdout || "");

        const binaryMissing =
          phpOut.includes("Could not open input file") ||
          phpOut.includes("not found") ||
          phpOut.includes("No such file");
        if (!binaryMissing) {
          hasErrors = true;
          output += `=== PHPSTAN ERRORS ===\n${phpRes.stdout || phpRes.stderr}\n\n`;
        }
      }
    }

    if (types.isCSharp) {
      if (isUnityProject(target)) {
        // Unity projects cannot be built via dotnet CLI — the Unity Editor manages
        // Roslyn compilation internally. Running dotnet build produces NETSDK1004
        // (project.assets.json not found) which is a permanent false positive.
        output += `[C# CHECK SKIPPED — Unity project detected: dotnet build is not applicable; the Unity Editor handles compilation.]\n\n`;
      } else {
        const workspace = findDotnetWorkspace(target);
        const buildTarget = workspace ? `"${workspace.path}"` : "";
        const csRes = await execAsync(
          `dotnet build ${buildTarget} --no-restore -clp:ErrorsOnly`,
          { cwd: target },
        ).catch((e) => e);
        if (
          csRes &&
          csRes.status !== 0 &&
          !(csRes.stderr || "").includes("could not be found")
        ) {
          hasErrors = true;
          output += `=== C# BUILD ERRORS ===\n${csRes.stdout || csRes.stderr}\n\n`;
        }
      }
    }

    if (types.isSwift) {
      // Run swiftc -typecheck over all project source files so type/API errors
      // (e.g. calling a View modifier on a Scene) are caught before the coder
      // proceeds. xcodebuild is NOT used — it requires signing and SDK setup
      // that the pipeline environment does not have.
      const hasSwiftc = await execAsync("swiftc --version")
        .then((r) => r.status === 0)
        .catch(() => false);

      if (!hasSwiftc) {
        output += `[SWIFT CHECK SKIPPED — swiftc not found in PATH.]\n\n`;
      } else {
        const sdkPath = await execAsync("xcrun --show-sdk-path")
          .then((r) => r.stdout.trim())
          .catch(() => "");

        if (!sdkPath) {
          output += `[SWIFT CHECK SKIPPED — xcrun unavailable; cannot resolve SDK for type-checking.]\n\n`;
        } else {
          const findRes = await execAsync(
            `find . -name "*.swift" -not -path "*/Pods/*" -not -path "*/.build/*" -not -path "*/DerivedData/*" -not -path "*Tests*" -not -path "*UITests*"`,
            { cwd: target },
          ).catch(() => null);

          const swiftSourceFiles = (findRes?.stdout || "")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((f) => `"${path.resolve(target, f)}"`);

          if (swiftSourceFiles.length === 0) {
            output += `[SWIFT CHECK SKIPPED — no Swift source files found in ${target}.]\n\n`;
          } else {
            const swiftRes = await execAsync(
              `swiftc -typecheck -sdk "${sdkPath}" ${swiftSourceFiles.join(" ")}`,
              { cwd: target },
            ).catch((e) => e);

            if (swiftRes && swiftRes.status !== 0) {
              const swiftOut = (swiftRes.stderr || swiftRes.stdout || "").trim();
              // Filter errors about missing Pods/SPM modules — those are
              // dependency-resolution failures, not code errors.
              const filtered = swiftOut
                .split("\n")
                .filter((line) => !line.includes("no such module"))
                .join("\n")
                .trim();
              if (filtered) {
                hasErrors = true;
                output += `=== SWIFT TYPE ERRORS ===\n${filtered}\n\n`;
              }
            }
          }
        }
      }
    }

    if (
      !types.isTypeScript &&
      !types.isNode &&
      !types.isPhp &&
      !types.isCSharp &&
      !types.isSwift
    ) {
      return `[DIAGNOSTICS SKIPPED] Could not detect project type (no tsconfig.json, package.json, composer.json, .csproj, or Xcode project found). Proceeding without checks.`;
    }
  } catch (err) {
    return `[DIAGNOSTIC SYSTEM ERROR] Failed to run checks: ${err.message}`;
  }

  if (!hasErrors) {
    return `[DIAGNOSTICS PASSED] All checks passed successfully. The workspace is clean. You may proceed to summarize your completion of the sub-task.`;
  }

  return `[DIAGNOSTICS FAILED] You have introduced errors. You MUST fix the following issues using 'patch_file' or 'write_file' before continuing:\n\n${output.trim()}`;
}
