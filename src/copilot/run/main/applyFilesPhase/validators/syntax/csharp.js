import path from "node:path";
import fs from "node:fs/promises";
import fg from "fast-glob";
import { execAsync } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { findDotnetWorkspace } from "#utils/findDotnetWorkspace.js";
import { isUnityProject } from "#utils/detectProjectContext.js";

export async function checkCSharpSyntax(projectDir, csFiles) {
  const errors = [];
  if (!csFiles || csFiles.length === 0) return errors;

  // Unity manages its own Roslyn compilation pipeline via the UnityEditor.
  // Running "dotnet build" on a Unity project always fails — skip entirely.
  if (isUnityProject(projectDir)) {
    log(
      colors.dim(
        "  [Verifier] Unity project detected — skipping dotnet build (not applicable to Unity).",
      ),
    );
    return errors;
  }

  const csprojFiles = await fg(["*.csproj"], { cwd: projectDir, deep: 1 });
  const hasDotnet = await execAsync("dotnet --version")
    .then((r) => r.status === 0)
    .catch(() => false);

  if (csprojFiles.length > 0 && hasDotnet) {
    log(colors.dim("  [Verifier] Running dotnet build for C# syntax check..."));

    // Resolve to a specific .sln or .csproj to avoid MSB1011 ambiguity when
    // multiple project files exist in the root (common in Unity projects).
    const workspace = findDotnetWorkspace(projectDir);
    const buildTarget = workspace ? `"${workspace.path}"` : "";

    const res = await execAsync(
      `dotnet build ${buildTarget} --no-restore -clp:ErrorsOnly`,
      { cwd: projectDir },
    ).catch((e) => e);

    if (res && res.status !== 0 && res.stdout) {
      errors.push(`C# Build Error:\n${res.stdout}`);
    }
  } else {
    const hasCsc = await execAsync("csc -version")
      .then((r) => r.status === 0)
      .catch(() => false);

    if (!hasCsc) {
      log(
        colors.yellow(
          "  [Verifier] Skipping C# syntax check: 'dotnet' or 'csc' compiler not found in PATH.",
        ),
      );
    } else {
      for (const absPath of csFiles) {
        const relPath = path.relative(projectDir, absPath);
        const content = await fs.readFile(absPath, "utf8");

        if (
          content.trim() &&
          !content.includes("namespace") &&
          !content.includes("class") &&
          !content.includes("using ")
        ) {
          errors.push(
            `C# Validation Error in ${relPath}: File appears to contain plain text or missing structure instead of a valid C# class.`,
          );
          continue;
        }

        const cscCheck = await execAsync(`csc -t:module -nologo "${absPath}"`, {
          cwd: projectDir,
        }).catch(() => null);

        if (
          cscCheck &&
          cscCheck.status !== 0 &&
          !cscCheck.stderr.includes("not found")
        ) {
          errors.push(
            `C# Syntax Error in ${relPath}:\n${cscCheck.stdout || cscCheck.stderr}`,
          );
        }
      }
    }
  }

  return errors;
}
