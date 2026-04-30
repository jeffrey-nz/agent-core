import { execAsync } from "#utils/exec.js";

export function appendGitStatus(msg, gitStatus) {
  const { staged, modified, untracked } = gitStatus;
  msg += `\n\nGit Status Overview:`;
  if (staged.length) msg += `\n- Staged: ${staged.join(", ")}`;
  if (modified.length) msg += `\n- Modified (unstaged): ${modified.join(", ")}`;
  if (untracked.length) msg += `\n- Untracked: ${untracked.join(", ")}`;
  return msg;
}

export async function appendDiffOrStatus(msg, filePath, rootDir, result) {
  try {
    const diffRes = await execAsync(`git diff --color=never "${filePath}"`, {
      cwd: rootDir,
    });

    if (diffRes.stdout && diffRes.stdout.trim().length > 0) {
      const diffText =
        diffRes.stdout.length > 4000
          ? diffRes.stdout.slice(0, 4000) + "\n...[DIFF TRUNCATED]"
          : diffRes.stdout;
      msg += `\n\nVerify your changes below:\n\`\`\`diff\n${diffText}\n\`\`\``;
    } else if (result.gitStatus) {
      msg = appendGitStatus(msg, result.gitStatus);
    }
  } catch (e) {}

  return msg;
}
