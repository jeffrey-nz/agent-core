import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { execAsync } from "#utils/exec.js";
import { gitResetHard } from "#utils/gitReset.js";
import { logStructured } from "#app/ui/log.js";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Roll back all git changes in one or more repositories.
 * @param {string | string[]} projectDirs
 */
export async function rollbackFilesystem(projectDirs, reason = 'unknown') {
  const dirs = Array.isArray(projectDirs) ? projectDirs : [projectDirs];
  for (const dir of dirs) {
    const summary = await execAsync("git status --short", { cwd: dir });
    const changedFiles = (summary.stdout || "").trim();
    // Forensic snapshot: save the bad files that triggered the rollback to .last_bad_attempt/
    // so we can inspect what the AI wrote before the reset wipes it. The snapshot lives
    // outside the working tree so it survives the rollback (git ignores .last_bad_attempt).
    if (changedFiles) {
      const snapshotDir = path.join(dir, ".last_bad_attempt");
      try {
        await fs.mkdir(snapshotDir, { recursive: true });
        for (const line of changedFiles.split("\n")) {
          const match = line.match(/^(\?\?|.M|.A|MM|AM|UU)\s+(.+)$/);
          if (!match) continue;
          const relPath = match[2].trim();
          const absSrc = path.join(dir, relPath);
          try {
            const content = await fs.readFile(absSrc, "utf8");
            // Store with the relative path encoded as filename (slashes -> __)
            const safeName = relPath.replace(/[/\\]/g, "__");
            await fs.writeFile(path.join(snapshotDir, safeName), content, "utf8");
          } catch { /* file not readable as text — skip */ }
        }
      } catch { /* snapshot dir creation failed — non-fatal */ }
    }
    const label = dirs.length > 1 ? `[${dir.split("/").pop()}] ` : "";
    if (changedFiles) {
      log(
        colors.yellow(
          `  [Rollback] ${label}Reverting the following changes:\n${changedFiles
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`,
        ),
      );
    } else {
      log(
        colors.yellow(
          `  [Rollback] ${label}Reverting filesystem to prevent broken state...`,
        ),
      );
    }
    const resetResult = await gitResetHard(dir);
    logStructured({
      requestId: 'rollback',
      actor: 'rollback',
      phase: 'rollback',
      message: resetResult.ok ? 'Rollback successful' : 'Rollback incomplete',
      data: {
        reason,
        repository: dir,
        fixedFiles: resetResult.fixedFiles || [],
        skippedFiles: resetResult.skippedFiles || [],
        error: resetResult.error
      },
      success: resetResult.ok
    });
    if (!resetResult.ok) {
      log(colors.yellow(`  [Rollback] ${label}Could not fully revert: ${resetResult.error}`));
    }
  }
}
