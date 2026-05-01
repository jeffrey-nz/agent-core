import { executeBash } from "#copilot/run/main/flow/executeTools/bash/index.js";

export const shellToolDefs = [
  {
    name: "execute_bash",
    description:
      "Run a shell command in the project root. Useful for running tests, linters, builds, or inspecting the environment. The shell is stateless - each command runs fresh from the project root. Use absolute paths or `cd /path && command` for subdirs.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "run_npm",
    description:
      "Run an npm command in the project root (install, run build, test, etc.).",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "npm subcommand and arguments, e.g. 'install' or 'run build'",
        },
      },
      required: ["command"],
    },
  },
];

// Commands that block indefinitely — kill them before they waste the 2-min stall timeout.
const BLOCKING_CMD_PATTERNS = [
  /\bnpm\s+(run\s+)?(dev|start|serve|preview)\b/,
  /\bvite(\s|$)/,
  /\bnext\s+dev\b/,
  /\bnuxt\s+dev\b/,
  /\bng\s+serve\b/,
  /\bexpo\s+start\b/,
];

export async function executeShellTool(name, input, { rootDir }) {
  if (name === "execute_bash") {
    const cmd = input.command || input.cmd;
    if (!cmd || typeof cmd !== "string") {
      return `[ERROR] execute_bash requires a 'command' string parameter. You provided: ${JSON.stringify(input)}`;
    }

    if (BLOCKING_CMD_PATTERNS.some(p => p.test(cmd))) {
      return `[BLOCKED] "${cmd}" starts a long-running dev server and will hang the pipeline. Do NOT run dev servers directly.\n\n• To verify the build compiles: use \`npm run build\`\n• The pipeline's visual verification system will start and screenshot the app automatically after your files are verified.\n\nProceed with other verification steps (build check, lint, tests).`;
    }

    const safeCmd = cmd;

    const scriptMatches = safeCmd.match(/(\S+\.sh)/g) || [];
    let preamble = "";
    if (scriptMatches.length > 0) {
      const chmodCmds = scriptMatches
        .map((p) => {
          const resolved = p.startsWith("/") ? p : `${rootDir}/${p}`;
          return `chmod +x ${resolved} ${p} 2>/dev/null || true`;
        })
        .join(" && ");
      preamble = chmodCmds + " && ";
    }

    const finalCmd = `${preamble}${safeCmd}`;

    const result = await executeBash(rootDir, [finalCmd]);

    if (
      result.includes("another Unity instance is running") ||
      result.includes("Multiple Unity instances cannot open the same project")
    ) {
      return (
        result +
        "\n\n[ERROR] Unity Editor is currently running and holding file locks. Please close the Unity Editor before running batchmode commands or tests and retry."
      );
    }

    return result;
  }

  if (name === "run_npm") {
    const npmCmd = input.command;
    if (!npmCmd || typeof npmCmd !== "string") {
      return `[ERROR] run_npm requires a 'command' string parameter. You provided: ${JSON.stringify(input)}`;
    }
    return await executeBash(rootDir, [`npm ${npmCmd}`]);
  }

  return undefined;
}
