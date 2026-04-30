import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { execAsync } from "#utils/exec.js";
import { gitResetHard } from "#utils/gitReset.js";
import { logStructured } from "#app/ui/log.js";

/**
 * Roll back all git changes in one or more repositories.
 * @param {string | string[]} projectDirs
 */
export async function rollbackFilesystem(projectDirs, reason = 'unknown') {
  const dirs = Array.isArray(projectDirs) ? projectDirs : [projectDirs];
  for (const dir of dirs) {
    const summary = await execAsync("git status --short", { cwd: dir });
    const changedFiles = (summary.stdout || "").trim();
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
