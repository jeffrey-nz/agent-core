import { simpleGit } from "simple-git";

export async function getGitChangedFiles(gitDir) {
  try {
    const git = simpleGit(gitDir);

    const res = await git.raw(["status", "-s"]);
    return (res || "").trim();
  } catch (err) {
    return "";
  }
}

export async function getHeadSha(gitDir) {
  try {
    const git = simpleGit(gitDir);
    const res = await git.raw(["rev-parse", "HEAD"]);
    return (res || "").trim();
  } catch {
    return "";
  }
}

/**
 * Returns true if the agent made any progress since `startSha` — either by
 * committing new work or by leaving uncommitted changes in the working tree.
 * This is the right check after a graph run that auto-commits each subtask.
 */
export async function hasProgressSince(gitDir, startSha) {
  const [uncommitted, currentSha] = await Promise.all([
    getGitChangedFiles(gitDir),
    getHeadSha(gitDir),
  ]);
  return !!(uncommitted || (startSha && currentSha && currentSha !== startSha));
}

export async function getGitDiffStat(gitDir) {
  try {
    const git = simpleGit(gitDir);

    const res = await git.raw(["diff", "HEAD", "--stat"]);
    return (res || "").trim();
  } catch (err) {
    return "";
  }
}
