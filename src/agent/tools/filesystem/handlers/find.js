import fg from "fast-glob";
import path from "node:path";
import { COMMON_IGNORE_DIRS, COMMON_IGNORE_FILES } from "#config/ignores.js";
import { isSafePath } from "../utils.js";

export async function handleFindFile(input, { rootDir, allowedDirs = [] }) {
  const searchDir = input.path ? path.resolve(rootDir, input.path) : rootDir;

  if (!isSafePath(rootDir, searchDir, allowedDirs)) {
    return `[ERROR] Path out of bounds: ${searchDir} (rootDir: ${rootDir})`;
  }

  const name = input.name ?? "**/*";
  const pattern = name.includes("*") ? name : `**/${name}`;
  const searchPattern = path.posix.join(searchDir.replace(/\\/g, "/"), pattern);

  const ignore = [
    ...Array.from(COMMON_IGNORE_DIRS).map((d) => `**/${d}/**`),
    ...Array.from(COMMON_IGNORE_FILES).map((f) => `**/${f}`),
  ];

  try {
    // Use limit 31 so we can detect truncation without fetching unlimited results.
    let files = await fg([searchPattern], {
      cwd: rootDir,
      ignore,
      dot: true,
      limit: 31,
      absolute: true,
    });

    if (files.length === 0 && input.name && !input.name.includes("*")) {
      const loosePattern = path.posix.join(
        searchDir.replace(/\\/g, "/"),
        `**/*${input.name}*`,
      );
      files = await fg([loosePattern], {
        cwd: rootDir,
        ignore,
        dot: true,
        limit: 31,
        absolute: true,
      });
    }

    if (files.length === 0) {
      return `<find_results query="${name}">No files found matching "${name}".</find_results>\n\n`;
    }

    const wasTruncated = files.length > 30;
    if (wasTruncated) files = files.slice(0, 30);
    const truncationNote = wasTruncated
      ? `\n[RESULTS TRUNCATED — 31+ files match "${name}". Use a more specific name or add a path to narrow results.]\n`
      : "";

    return `<find_results query="${name}">\n${files.join("\n")}${truncationNote}\n</find_results>\n\n`;
  } catch (err) {
    return `[ERROR] find_file failed: ${err.message} (pattern: ${searchPattern}, searchDir: ${searchDir})`;
  }
}
