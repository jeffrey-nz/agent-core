import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  COMMON_IGNORE_DIRS,
  COMMON_IGNORE_FILES,
  COMMON_BINARY_EXTS,
  COMMON_IGNORE_EXTS,
} from "#config/ignores.js";

const MAX_SINGLE_FILE_BYTES = 100 * 1024;

export async function bundleDirectoryToText(
  rootDir,
  { maxBytes = 1500000, ignore = [] } = {},
) {
  const ignores = [
    ...Array.from(COMMON_IGNORE_DIRS).map((d) => `**/${d}/**`),
    ...Array.from(COMMON_IGNORE_FILES).map((f) => `**/${f}`),
    ...ignore,
  ];

  const files = await fg(["**"], {
    cwd: rootDir,
    ignore: ignores,
    dot: true,
    onlyFiles: true,
  });

  files.sort();

  let out = "";
  let totalBytes = 0;
  let included = 0;
  let skipped = 0;

  for (const relPath of files) {
    const ext = path.extname(relPath).toLowerCase();
    if (COMMON_BINARY_EXTS.has(ext) || COMMON_IGNORE_EXTS.has(ext)) {
      skipped++;
      continue;
    }

    const absPath = path.resolve(rootDir, relPath);
    try {
      const stats = await fs.stat(absPath);
      if (stats.size > MAX_SINGLE_FILE_BYTES) {
        out += `// [FILE SKIPPED: ${relPath} is too large (${Math.round(stats.size / 1024)}KB)]\n\n`;
        skipped++;
        continue;
      }

      const content = await fs.readFile(absPath, "utf8");

      if (content.includes("\u0000")) {
        skipped++;
        continue;
      }

      const block = `\n// --- FILE START ---\n// Relative Path: ${relPath.replace(/\\/g, "/")}\n// Please acknowledge the path above before processing the following code block:\n${content.replace(/\r\n/g, "\n")}\n\n`;
      const blockBytes = Buffer.byteLength(block, "utf8");

      if (maxBytes > 0 && totalBytes + blockBytes > maxBytes) {
        console.warn(
          `[Bundler] Reached maxBytes limit (${maxBytes}). Truncating.`,
        );
        break;
      }

      out += block;
      totalBytes += blockBytes;
      included++;
    } catch (e) {
      skipped++;
    }
  }

  return {
    text: out,
    stats: {
      included,
      skipped,
      totalBytes,
      maxBytes,
      truncated: totalBytes > maxBytes,
    },
  };
}
