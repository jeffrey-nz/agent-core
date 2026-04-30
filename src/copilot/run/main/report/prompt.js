export function buildSummaryPrompt({
  promptText,
  projectTitle,
  applyRes,
  changedFiles,
  diffStat,
}) {
  const fileList = changedFiles
    ? `\nFiles changed in git:\n${changedFiles}`
    : "";
  const stat = diffStat ? `\nDiff summary:\n${diffStat}` : "";
  const filesApplied = applyRes?.applied ?? 0;

  if (filesApplied === 0 && !changedFiles) {
    return `The automated coding session finished, but no files were changed in the project's git repository.

Please write an honest, plain-English report that:
1. **States clearly** that no code changes were made to the project files
2. **Explains what happened** based on the task description — e.g. planning was done, dependencies were identified, but implementation was not completed
3. **Lists what still needs to be done** to complete the original task
4. **Recommends next steps** for a developer picking this up

Context:
- Project: ${projectTitle || "(unnamed)"}
- Task: ${promptText || "(no prompt recorded)"}
- Files changed: 0 (no git changes detected)

Be honest and direct. Do NOT claim the task was completed or that commands were run successfully if no files were changed.`;
  }

  return `The automated coding task completed. Please write a clear, plain-English report for a non-technical person (or developer unfamiliar with this codebase) that covers:

1. **What was done** — a brief summary of the changes that were made
2. **How to use it** — step-by-step instructions to run, test, or interact with whatever was built or changed
3. **Anything to be aware of** — e.g. dependencies to install, env vars to set, commands to run first

Context:
- Project: ${projectTitle || "(unnamed)"}
- Task: ${promptText || "(no prompt recorded)"}
- Files applied: ${filesApplied}${fileList}${stat}

Write the report in plain, friendly language. No code blocks with implementation details — focus on what the person needs to DO. Use numbered steps where helpful.`;
}
