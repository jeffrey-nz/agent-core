import { z } from "zod";

export const diagnosticsTools = {
  get_workspace_diagnostics: {
    description:
      "Run static analysis (TypeScript/PHPStan/ESLint) on the current workspace to find type errors, syntax errors, and linting issues before you finish your task.",
    parameters: z.object({
      target_dir: z
        .string()
        .optional()
        .describe("Optional subdirectory to limit the check."),
    }),
  },
};
