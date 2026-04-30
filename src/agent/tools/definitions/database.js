import { z } from "zod";

export const databaseTools = {
  query_database: {
    description:
      "Execute a read-only SQL query against the project's MySQL database.",
    parameters: z.object({
      query: z
        .string()
        .describe(
          "SQL query to execute. Must be SELECT, SHOW, DESCRIBE, or EXPLAIN.",
        ),
      env_file: z.string().optional(),
      database: z.string().optional(),
    }),
  },
};
