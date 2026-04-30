import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { searchCodebase } from "#lib/interactive/fs/index.js";
import { spawnAsync } from "#utils/exec.js";

export const searchToolDefs = [
  {
    name: "search_codebase",
    description:
      "Semantic search across all project files. Good for finding where a feature, " +
      "concept, or symbol is implemented when you don't know the exact file.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — keyword, phrase, or concept",
        },
        path: {
          type: "string",
          description: "Optional: restrict search to a subdirectory",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "grep",
    description:
      "Search for an exact string or regex pattern across project files. " +
      "Returns file paths and matching lines. Faster and more precise than search_codebase " +
      "when you know the exact string to look for.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex or literal string to search for",
        },
        path: {
          type: "string",
          description: "Optional: directory or file path to search within",
        },
      },
      required: ["pattern"],
    },
  },
];

const MAX_TOTAL_CHARS = 4000;
const MAX_LINE_CHARS = 150;
const MAX_MATCHES = 40;

async function handleGrep(rootDir, pattern, targetPath) {
  const spinner = createSpinner(
    colors.dim(`  - Grepping pattern: ${pattern} in ${targetPath}`),
  ).start();

  try {
    let res = await spawnAsync(
      "git",
      ["grep", "-InE", "--", pattern, targetPath],
      { cwd: rootDir, timeout: 15000 },
    );

    if (res.status !== 0 && !res.stdout) {
      res = await spawnAsync(
        "grep",
        [
          "-rnEI",
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          "--exclude-dir=vendor",
          pattern,
          targetPath,
        ],
        { cwd: rootDir, timeout: 15000 },
      );
    }

    if (res.stdout) {
      const lines = res.stdout.split("\n").filter(Boolean);
      const hitCount = lines.length;

      const formatted = lines
        .slice(0, MAX_MATCHES)
        .map((line) =>
          line.length > MAX_LINE_CHARS
            ? line.slice(0, MAX_LINE_CHARS) + "..."
            : line,
        )
        .join("\n");

      spinner.succeed(
        colors.dim(`  - Grep complete: ${pattern} (${hitCount} hits)`),
      );

      let out = `<grep_results pattern="${pattern}" path="${targetPath}">\n${formatted}\n`;
      if (hitCount > MAX_MATCHES) {
        out += `... [TRUNCATED ${hitCount - MAX_MATCHES} ADDITIONAL MATCHES]\n`;
      }
      out += `</grep_results>\n\n`;

      return out;
    }

    spinner.info(
      colors.dim(`  - Grep: No matches for ${pattern} in ${targetPath}`),
    );
    return `<grep_results pattern="${pattern}" path="${targetPath}">No matches found.</grep_results>\n\n`;
  } catch (err) {
    spinner.fail(colors.dim(`  - Grep failed: ${pattern}`));
    return `[ERROR] Grep failed for ${pattern}: ${err.message}\n\n`;
  }
}

async function handleSearch(rootDir, query, ignore) {
  const spinner = createSpinner(
    colors.dim(`  - Searching for: ${query}`),
  ).start();
  const res = await searchCodebase(rootDir, query, ignore);
  spinner.succeed(colors.dim(`  - Searched for: ${query}`));
  return res + "\n\n";
}

export async function executeSearchTool(name, input, { rootDir, ignore = [] }) {
  if (name === "search_codebase") {
    return await handleSearch(rootDir, input.query, ignore);
  } else if (name === "grep") {
    const res = await handleGrep(rootDir, input.pattern, input.path || ".");
    if (res.length > MAX_TOTAL_CHARS) {
      return (
        res.slice(0, MAX_TOTAL_CHARS) +
        "\n... [TOTAL SEARCH OUTPUT TRUNCATED TO PRESERVE CONTEXT]"
      );
    }
    return res;
  }
  return undefined;
}
