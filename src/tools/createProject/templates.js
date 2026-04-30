export function generateConfigJson(projectName, parentName) {
  return JSON.stringify(
    {
      name: projectName,
      path: `${parentName}/${projectName}`,
    },
    null,
    2,
  );
}

export function generateProjectJs({
  parentName,
  projectName,
  branchName,
  targetDirs,
}) {
  const scopeContext =
    targetDirs.length > 0
      ? targetDirs
          .map(
            (d, i) =>
              `    finalPrompt += \`  ${i + 1}. \${targetDir}/${d}\\n\`;`,
          )
          .join("\n")
      : `    finalPrompt += \`- The code is located in: \${targetDir}\\n\`;`;

  const buildSteps =
    targetDirs.length > 0
      ? targetDirs
          .map(
            (d) => `
      {
        label: "${d} Client: Install & Build",
        cmd: 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \\\\. "$NVM_DIR/nvm.sh" && nvm use && npm i && npm run build',
        cwd: \`/var/www/op/${d}/client\`,
        timeout: 180000,
      }`,
          )
          .join(",")
      : `
      {
        label: "Default Build",
        cmd: "npm install && npm run build",
        cwd: ctx.gitDir,
        timeout: 180000
      }`;

  return `import { runBuildSteps } from "#projects/lib/runBuildSteps.js";

export const project = {
  id: "${parentName}/${projectName}",
  title: "${parentName.toUpperCase()} / ${projectName}",
  ${branchName ? `branch: "${branchName}",` : ""}
  mode: "thinkDeeper",

  async getPrompt(ctx = {}) {
    const rawText = ctx.promptText ?? "Implement requested changes.";
    const targetDir = ctx.targetRepoDir || "/var/www/op";

    let finalPrompt = \`[STRICT GOAL]\\n\${rawText.trim()}\\n\\n\`;
    
    finalPrompt += \`[SCOPE / CONTEXT]\\n\`;
    finalPrompt += \`- You are working in the root directory: \${targetDir}\\n\`;
${scopeContext}
    
    finalPrompt += \`[PROTOCOL]\\n\`;
    finalPrompt += \`- Use ONLY JSON tool calls (read_file, patch_file, write_file).\\n\`;
    finalPrompt += \`- All paths MUST be absolute starting with \${targetDir}.\\n\\n\`;

    finalPrompt += \`[VERIFICATION]\\n\`;
    finalPrompt += \`- You MUST run 'get_workspace_diagnostics' before completing any sub-task.\\n\`;

    return finalPrompt;
  },

  async afterApply(ctx) {
    return await runBuildSteps([${buildSteps}
    ]);
  },
};
`;
}
