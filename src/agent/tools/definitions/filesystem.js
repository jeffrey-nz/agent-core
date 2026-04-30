import { z } from "zod";

export const filesystemTools = {
  read_file: {
    description:
      "Read the contents of a file. Always read a file before editing it. Use start_line/end_line to read a specific section of a large file.",
    parameters: z.object({
      path: z.string().describe("Absolute path to the file"),
      start_line: z
        .number()
        .optional()
        .describe("First line to read (1-indexed)"),
      end_line: z.number().optional().describe("Last line to read"),
    }),
  },
  list_dir: {
    description: "List the contents of a directory.",
    parameters: z.object({
      path: z.string().describe("Absolute path to the directory"),
    }),
  },
  find_file: {
    description:
      "Find files by name across the project directory. Supports wildcards. Results capped at 30 — if truncated, add a 'path' to narrow the search. Omit 'name' to list all files in the given directory.",
    parameters: z.object({
      name: z
        .string()
        .optional()
        .describe(
          "File name or glob pattern to find (e.g. '*.cs'). Omit to list all files.",
        ),
      path: z
        .string()
        .optional()
        .describe("Optional: Directory to search inside."),
    }),
  },
  outline_file: {
    description:
      "Get a structural outline of a code file (functions, classes, imports).",
    parameters: z.object({
      path: z.string().describe("Absolute path to the file to outline"),
    }),
  },
  write_file: {
    description: "Create a new file or completely overwrite an existing file.",
    parameters: z.object({
      path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Complete file content"),
    }),
  },
  patch_file: {
    description:
      "Apply a targeted search-and-replace edit to an existing file. search_block MUST be an EXACT match.",
    parameters: z.object({
      path: z.string().describe("Absolute path to the file"),
      search_block: z
        .string()
        .describe("Exact existing content to find and replace"),
      replace_block: z.string().describe("New content to substitute in"),
      replace_all: z.boolean().optional(),
    }),
  },
  apply_diff: {
    description: "Apply a standard Unified Diff to a file or multiple files.",
    parameters: z.object({
      diff_content: z.string().describe(
        "The complete unified diff string. MUST be named 'diff_content' — NOT 'diff', 'patch', or 'diff_string'."
      ),
    }),
  },
  delete_file: {
    description: "Delete a file from the filesystem.",
    parameters: z.object({
      path: z.string().describe("Absolute path to the file to delete"),
    }),
  },
  move_file: {
    description: "Move or rename a file.",
    parameters: z.object({
      source: z.string().describe("Current absolute path"),
      destination: z.string().describe("New absolute path"),
    }),
  },
  revert_file: {
    description:
      "Revert a file to its state at the last commit (git checkout HEAD).",
    parameters: z.object({
      path: z.string().describe("Absolute path to the file to revert"),
    }),
  },
};
