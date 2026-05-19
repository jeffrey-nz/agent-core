import { z } from "zod";

export const gitTools = {
  git_inspect: {
    description:
      "Get the current git status, recent commit history, and a unified diff of unstaged changes. Essential for gaining context on current workspace modifications.",
    parameters: z.object({
      working_dir: z
        .string()
        .optional()
        .describe("Absolute path to the git repository"),
    }),
  },
  git_commit: {
    description:
      "Stage all tracked and untracked changes and commit them to the repository. Use this to save working milestones.",
    parameters: z.object({
      message: z.string().describe("The commit message detailing the changes"),
      working_dir: z
        .string()
        .optional()
        .describe("Absolute path to the git repository"),
    }),
  },
  git_push: {
    description:
      "Push the current branch to the remote origin. Use after committing changes that should be shared or reviewed.",
    parameters: z.object({
      branch: z
        .string()
        .optional()
        .describe("Branch name to push. Defaults to the current branch."),
      remote: z.string().optional().default("origin").describe("Remote name"),
      working_dir: z
        .string()
        .optional()
        .describe("Absolute path to the git repository"),
    }),
  },
  git_branch: {
    description:
      "Create a new git branch and optionally check it out. Useful before starting a set of changes.",
    parameters: z.object({
      name: z.string().describe("Name of the branch to create"),
      checkout: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to check out the new branch immediately"),
      working_dir: z
        .string()
        .optional()
        .describe("Absolute path to the git repository"),
    }),
  },

  git_diff: {
    description:
      "Show the diff for a specific file or the whole working tree. " +
      "Use this to inspect exactly what has changed before committing, or to understand " +
      "the delta between a commit and the current state. Diffs are truncated at 8 KB. " +
      "Optionally compare against a specific commit or branch.",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("File path (relative or absolute) to diff. Omit to diff the entire working tree."),
      base: z
        .string()
        .optional()
        .describe("Git ref to diff against (e.g. 'HEAD', 'HEAD~1', 'main'). Defaults to unstaged changes."),
      staged: z
        .boolean()
        .optional()
        .describe("If true, shows staged (cached) changes instead of unstaged. Defaults to false."),
      working_dir: z
        .string()
        .optional()
        .describe("Absolute path to the git repository."),
    }),
  },
};
