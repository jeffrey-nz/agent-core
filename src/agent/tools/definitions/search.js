import { z } from "zod";

export const searchTools = {
  search_codebase: {
    description: "Semantic search across all project files.",
    parameters: z.object({
      query: z.string().describe("Search query - keyword, phrase, or concept"),
      path: z.string().optional(),
    }),
  },
  grep: {
    description:
      "Search for an exact string or regex pattern across project files.",
    parameters: z.object({
      pattern: z.string().describe("Regex or literal string to search for"),
      path: z.string().optional(),
    }),
  },
};
