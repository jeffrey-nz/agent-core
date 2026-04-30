import fs from "node:fs/promises";
import path from "node:path";

export async function readCodeWindow(rootDir, targetPath, startLine, endLine) {
  const absPath = path.resolve(rootDir, targetPath);

  if (!absPath.startsWith(path.resolve(rootDir))) {
    return `[Error] Path out of bounds.`;
  }

  try {
    const content = await fs.readFile(absPath, "utf8");
    const lines = content.split("\n");

    const startIdx = Math.max(0, parseInt(startLine) - 1);
    const endIdx = Math.min(lines.length, parseInt(endLine));

    if (isNaN(startIdx) || isNaN(endIdx) || startIdx >= endIdx) {
      return `[Error] Invalid line range provided. File has ${lines.length} lines.`;
    }

    const snippet = lines
      .slice(startIdx, endIdx)
      .map((l, i) => `${startIdx + i + 1} | ${l}`)
      .join("\n");

    return `Lines ${startLine} to ${endLine} of ${targetPath}:\n\`\`\`\n${snippet}\n\`\`\``;
  } catch (err) {
    return `[Error] Could not read file snippet: ${err.message}`;
  }
}
