import fs from "node:fs";
import { simpleGit } from "simple-git";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function cleanGitWorkspace(projectDir) {
  if (!projectDir || !fs.existsSync(projectDir)) {
    log(colors.yellow(`\n  [Git] Skipping git clean — directory does not exist: ${projectDir}`));
    return;
  }
  log(
    `\n${colors.dim("🧹 Cleaning git working directory (reset & clean)...")}`,
  );

  // Remove stale lock files left by a crashed git process. These block all git
  // operations and must be cleared before reset/clean can run.
  for (const lockFile of ["index.lock", "HEAD.lock", "MERGE_HEAD.lock", "CHERRY_PICK_HEAD.lock"]) {
    const lockPath = `${projectDir}/.git/${lockFile}`;
    if (fs.existsSync(lockPath)) {
      try {
        fs.rmSync(lockPath);
        log(colors.yellow(`  [Git] Removed stale lock file: .git/${lockFile}`));
      } catch (e) {
        log(colors.yellow(`  [Git] Could not remove .git/${lockFile}: ${e.message}`));
      }
    }
  }

  const git = simpleGit(projectDir);
  await git.reset(["--hard", "HEAD"]);
  await git.clean("f", ["-d"]);
}

export async function checkoutBranch(projectDir, branchName) {
  log(`\n🌿 Checking out git branch: ${branchName} ...`);
  const git = simpleGit(projectDir);

  try {
    await git.checkoutLocalBranch(branchName);
    log(`🌿 Created and switched to new branch: ${branchName}`);
  } catch (err) {
    if (
      err.message.includes("already exists") ||
      err.message.includes("already a branch")
    ) {
      await git.checkout(branchName);
      log(`🌿 Switched to existing branch: ${branchName}`);
      await cleanGitWorkspace(projectDir);
    } else {
      throw new Error(
        `Git checkout failed for branch '${branchName}': ${err.message}`,
      );
    }
  }
}
