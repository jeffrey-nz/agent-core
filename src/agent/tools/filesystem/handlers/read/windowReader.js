import fs from "node:fs/promises";
import path from "node:path";

export async function readWindow(absPath, startLine, endLine) {
  const content = await fs.readFile(absPath, "utf8");
  const lines = content.split("\n");
  const startIdx = Math.max(0, parseInt(startLine) - 1);
  const endIdx = Math.min(lines.length, parseInt(endLine));

  if (isNaN(startIdx) || isNaN(endIdx) || startIdx >= endIdx) {
    throw new Error(
      `Invalid line range provided. File has ${lines.length} lines.`,
    );
  }

  const snippet = lines
    .slice(startIdx, endIdx)
    .map((l, i) => `${startIdx + i + 1} | ${l}`)
    .join("\n");

  return snippet;
}
