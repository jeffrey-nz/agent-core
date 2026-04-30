import { log } from "#app/ui/log.js";
import { simpleGit } from "simple-git";
import { validateModifications } from "./git/validator.js";

/**
 * Verify git changes across one or more git repositories.
 * @param {string | string[]} projectDirs - Primary repo dir, or array of all repos touched.
 * @param {string} scriptOutput - Raw stdout from the apply phase (for fallback validation).
 */
export async function verifyGitChanges(projectDirs, scriptOutput) {
  const dirs = Array.isArray(projectDirs) ? projectDirs : [projectDirs];
  const errors = [];

  const combinedGitStatus = { staged: [], modified: [], untracked: [] };
  let anyHasChanges = false;

  for (const dir of dirs) {
    try {
      const status = await simpleGit(dir).status();
      if (!status.isClean()) {
        anyHasChanges = true;
        combinedGitStatus.staged.push(...status.staged);
        combinedGitStatus.modified.push(...status.modified);
        combinedGitStatus.untracked.push(...status.not_added);
        if (dirs.length > 1) log(`  📂 [${dir.split("/").pop()}] has changes`);
      }
    } catch (err) {
      errors.push(`Git status failed in ${dir}: ${err.message}`);
    }
  }

  if (!anyHasChanges) {
    // Run the fallback validation against the primary dir only.
    const validation = validateModifications("", scriptOutput, dirs[0]);
    if (!validation.ok) {
      log(`⚠️  ${validation.error}`);
      errors.push(
        scriptOutput
          ? `${validation.error}\n\nLast Script Output:\n${scriptOutput}`
          : validation.error,
      );
      return { hasChanges: false, errors };
    }
  }

  if (combinedGitStatus.staged.length)
    log(`  📝 Staged: ${combinedGitStatus.staged.length} file(s)`);
  if (combinedGitStatus.modified.length)
    log(`  📝 Modified: ${combinedGitStatus.modified.length} file(s)`);
  if (combinedGitStatus.untracked.length)
    log(`  📝 Untracked: ${combinedGitStatus.untracked.length} file(s)`);

  return { hasChanges: anyHasChanges, errors, gitStatus: combinedGitStatus };
}
