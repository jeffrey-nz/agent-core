import { z } from "zod";

export const shellTools = {
  execute_bash: {
    description: "Run a shell command in the project root.",
    parameters: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
  },
  run_npm: {
    description:
      "Run an npm command in the project root (install, run build, test, etc.).",
    parameters: z.object({
      command: z
        .string()
        .describe("npm subcommand and arguments, e.g. 'install' or 'run build'"),
    }),
  },
};
