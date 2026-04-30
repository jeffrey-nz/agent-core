import { safeExec } from "#utils/exec.js";

export async function executeGitTool(name, input, context) {
  const cwd = input.working_dir || context.rootDir;

  if (name === "git_inspect") {
    const statusRes = await safeExec("git status -s", { cwd });
    const logRes = await safeExec("git log -n 5 --oneline", { cwd });
    const diffRes = await safeExec("git diff --color=never", { cwd });

    let output = `<git_inspect cwd="${cwd}">\n`;

    output += `=== GIT STATUS ===\n${statusRes.stdout || "Working tree clean"}\n\n`;
    output += `=== RECENT COMMITS ===\n${logRes.stdout || "No commits found"}\n\n`;

    const diffOut = diffRes.stdout;
    if (diffOut) {
      output += `=== UNSTAGED DIFF ===\n${
        diffOut.length > 5000
          ? diffOut.slice(0, 5000) + "\n... [DIFF TRUNCATED]"
          : diffOut
      }\n`;
    }

    output += `</git_inspect>\n`;
    return output;
  }

  if (name === "git_commit") {
    const message = input.message.replace(/"/g, '\\"');
    await safeExec("git add -A", { cwd });
    const commitRes = await safeExec(`git commit -m "${message}"`, { cwd });

    if (commitRes.success) {
      return `<git_commit cwd="${cwd}">\n[SUCCESS] Changes committed: ${input.message}\n${commitRes.stdout}\n</git_commit>`;
    }

    const out = (commitRes.stdout + "\n" + commitRes.stderr).toLowerCase();
    if (out.includes("nothing to commit") || out.includes("working tree clean")) {
      return `<git_commit cwd="${cwd}">\n[INFO] Nothing to commit. Working tree is clean.\n</git_commit>`;
    }

    return `<git_commit cwd="${cwd}">\n[ERROR] Failed to commit changes:\n${commitRes.stderr || commitRes.stdout}\n</git_commit>`;
  }

  if (name === "git_push") {
    const remote = input.remote || "origin";
    const branch = input.branch;
    const pushCmd = branch
      ? `git push -u ${remote} ${branch}`
      : `git push -u ${remote} HEAD`;
    const pushRes = await safeExec(pushCmd, { cwd });
    if (pushRes.success) {
      return `<git_push cwd="${cwd}">\n[SUCCESS] Pushed to ${remote}\n${pushRes.stdout}\n</git_push>`;
    }
    return `<git_push cwd="${cwd}">\n[ERROR] Push failed: ${pushRes.stderr || pushRes.stdout}\n</git_push>`;
  }

  if (name === "git_branch") {
    const branchName = input.name;
    if (!branchName || typeof branchName !== "string") {
      return `[ERROR] git_branch requires a 'name' parameter.`;
    }
    const checkout = input.checkout !== false;
    const cmd = checkout ? `git checkout -b ${branchName}` : `git branch ${branchName}`;
    const res = await safeExec(cmd, { cwd });
    if (res.success) {
      return `<git_branch cwd="${cwd}">\n[SUCCESS] Branch '${branchName}' ${checkout ? "created and checked out" : "created"}\n${res.stdout}\n</git_branch>`;
    }
    return `<git_branch cwd="${cwd}">\n[ERROR] ${res.stderr || res.stdout}\n</git_branch>`;
  }

  return undefined;
}
