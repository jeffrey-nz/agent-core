import { spawnAsync } from "#utils/exec.js";
import { COMMON_IGNORE_DIRS } from "#config/ignores.js";
import { validateSearchQuery } from "./validator.js";
import { formatSearchResults } from "./formatter.js";

export async function searchCodebase(rootDir, rawQuery, ignore = []) {
  try {
    const { valid, error, sanitizedQuery } = validateSearchQuery(rawQuery);
    if (!valid) return error;

    const query = sanitizedQuery;
    const gitExcludes = ignore.flatMap((pattern) => [":!" + pattern]);
    const grepExcludes = ignore.flatMap((pattern) => [
      `--exclude=${pattern}`,
      `--exclude-dir=${pattern}`,
    ]);

    const gitRes = await spawnAsync(
      "git",
      ["grep", "-In", "--untracked", query, "--", ".", ...gitExcludes],
      { cwd: rootDir, timeout: 15000 },
    );
    if (gitRes.status === 0 && gitRes.stdout) {
      return formatSearchResults(query, gitRes.stdout, rootDir);
    }

    const defaultExcludes = [...COMMON_IGNORE_DIRS].map(
      (dir) => `--exclude-dir=${dir}`,
    );
    const grepArgs = ["-rnI", ...defaultExcludes, ...grepExcludes, query, "."];

    const grepRes = await spawnAsync("grep", grepArgs, {
      cwd: rootDir,
      timeout: 25000,
    });
    if (grepRes.status === 0 && grepRes.stdout) {
      return formatSearchResults(query, grepRes.stdout, rootDir);
    }
    if (grepRes.status === 1 && !grepRes.stdout) {
      return `<search_results query="${query}">No matches found.</search_results>\n\n`;
    }
    if (grepRes.stderr) {
      return `[Error] Search returned warnings:\n${grepRes.stderr}`;
    }
    return `<search_results query="${query}">No matches found.</search_results>\n\n`;
  } catch (err) {
    return `[Error] Search execution failed: ${err.message}`;
  }
}
