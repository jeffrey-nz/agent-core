import fs from "node:fs/promises";
import path from "node:path";
import { formatBytes } from "#utils/format.js";

export async function listDirectory(rootDir, targetPath) {
  const absPath = path.resolve(rootDir, targetPath || ".");

  if (!absPath.startsWith(path.resolve(rootDir))) {
    return `[Error] Path out of bounds.`;
  }

  try {
    const stats = await fs.stat(absPath);
    if (!stats.isDirectory()) {
      return `[Error] ${absPath} is not a directory.`;
    }

    const entries = await fs.readdir(absPath, { withFileTypes: true });
    const relBase = path.relative(rootDir, absPath) || ".";
    let output = `<dir path="${relBase.replace(/\\/g, "/")}">\n`;

    for (const ent of entries) {
      if (ent.name.startsWith(".git") || ent.name === "node_modules") continue;

      const entRelPath = path
        .relative(rootDir, path.join(absPath, ent.name))
        .replace(/\\/g, "/");
      if (ent.isDirectory()) {
        output += `[D] ${entRelPath}/\n`;
      } else {
        const fileStats = await fs
          .stat(path.join(absPath, ent.name))
          .catch(() => null);
        const sizeStr = fileStats ? ` (${formatBytes(fileStats.size)})` : "";
        output += `[F] ${entRelPath}${sizeStr}\n`;
      }
    }
    output += `</dir>\n\n`;
    return output;
  } catch (err) {
    if (err.code === "ENOENT") {
      return `[Error] Directory not found: ${targetPath}`;
    }
    return `[Error] Could not list directory: ${err.message}`;
  }
}
