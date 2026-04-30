import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

/**
 * Type-checks modified Swift files using `swiftc -typecheck` with the macOS SDK.
 *
 * Strategy:
 * 1. Locate the SDK via `xcrun --show-sdk-path` so SwiftUI/Foundation imports resolve.
 * 2. Collect ALL Swift source files in the project (excluding Pods, .build, Tests) so
 *    cross-file type references (e.g. ContentView used in swift_appApp.swift) resolve.
 * 3. Run a single `swiftc -typecheck` invocation over all project files.
 * 4. Report only errors in the files the coder actually modified — pre-existing errors
 *    in untouched files do not block progress.
 *
 * This catches API-level mistakes (e.g. calling a View modifier on a Scene) that
 * `swiftc -parse` silently misses.
 *
 * Falls back to per-file `swiftc -parse` if `xcrun` is unavailable (CI environments
 * without Xcode Command Line Tools).
 */
export async function checkSwiftSyntax(projectDir, swiftFiles) {
  const errors = [];
  if (!swiftFiles || swiftFiles.length === 0) return errors;

  const hasSwiftc = await execAsync("swiftc --version")
    .then((r) => r.status === 0)
    .catch(() => false);

  if (!hasSwiftc) {
    log(
      colors.yellow(
        "  [Verifier] Skipping Swift syntax check: 'swiftc' not found in PATH.",
      ),
    );
    return errors;
  }

  // Get the SDK path so system framework imports (SwiftUI, UIKit, Foundation) resolve.
  const sdkPath = await execAsync("xcrun --show-sdk-path")
    .then((r) => r.stdout.trim())
    .catch(() => "");

  if (!sdkPath) {
    log(
      colors.yellow(
        "  [Verifier] xcrun unavailable — falling back to swiftc -parse (syntax only, API errors not checked).",
      ),
    );
    return checkSwiftSyntaxParse(projectDir, swiftFiles);
  }

  // Collect all non-test Swift source files so cross-file types resolve.
  const findRes = await execAsync(
    `find . -name "*.swift" -not -path "*/Pods/*" -not -path "*/.build/*" -not -path "*/DerivedData/*" -not -path "*Tests*" -not -path "*UITests*"`,
    { cwd: projectDir },
  ).catch(() => null);

  const allSourceFiles = (findRes?.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((f) => path.resolve(projectDir, f));

  const filesToCheck = allSourceFiles.length > 0 ? allSourceFiles : swiftFiles;
  const fileArgs = filesToCheck.map((f) => `"${f}"`).join(" ");

  log(
    colors.dim(
      `  [Verifier] Running swiftc -typecheck (${filesToCheck.length} files, SDK: ${path.basename(sdkPath)})...`,
    ),
  );

  const res = await execAsync(
    `swiftc -typecheck -sdk "${sdkPath}" ${fileArgs}`,
    { cwd: projectDir },
  ).catch((e) => e);

  if (res && res.status !== 0) {
    const rawOutput = (res.stderr || res.stdout || "").trim();
    const modifiedSet = new Set(swiftFiles);

    // Keep only error lines for files the coder actually modified.
    // This avoids surfacing pre-existing errors in untouched files.
    const filtered = rawOutput
      .split("\n")
      .filter((line) => {
        const fileMatch = line.match(/^(\/[^\s:]+\.swift):/);
        if (!fileMatch) return false;
        if (!modifiedSet.has(fileMatch[1])) return false;
        // Drop errors that are purely about unresolvable external dependencies
        // (missing Pods, SPM packages, types only in other project files).
        if (line.includes("no such module")) return false;
        return true;
      })
      .join("\n")
      .trim();

    if (filtered) {
      errors.push(`Swift Type Error:\n${filtered}`);
    }
  }

  return errors;
}

/**
 * Fallback: per-file syntax-only parse when xcrun/SDK is unavailable.
 * Only catches tokenization/syntax errors — does NOT catch API misuse.
 */
async function checkSwiftSyntaxParse(projectDir, swiftFiles) {
  const errors = [];
  for (const absPath of swiftFiles) {
    const relPath = path.relative(projectDir, absPath);
    const res = await execAsync(`swiftc -parse "${absPath}"`, {
      cwd: projectDir,
    }).catch((e) => e);

    if (res && res.status !== 0) {
      const output = (res.stderr || res.stdout || "").trim();
      const filtered = output
        .split("\n")
        .filter(
          (line) =>
            !line.includes("no such module") &&
            !line.includes("cannot find type") &&
            !line.includes("cannot find '") &&
            !line.includes("use of unresolved identifier"),
        )
        .join("\n")
        .trim();

      if (filtered) {
        errors.push(`Swift Syntax Error in ${relPath}:\n${filtered}`);
      }
    }
  }
  return errors;
}
