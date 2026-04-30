import fs from "node:fs/promises";
import path from "node:path";

export async function getModifiedFileBlocks(modifiedFiles, rootDir) {
  if (!modifiedFiles || modifiedFiles.length === 0) return "No files modified.";

  const blocks = await Promise.all(
    modifiedFiles.map(async (filePath) => {
      const absPath =
        rootDir && !path.isAbsolute(filePath)
          ? path.resolve(rootDir, filePath)
          : filePath;
      try {
        const content = await fs.readFile(absPath, "utf8");
        return `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
      } catch (err) {
        return `### ${filePath}\n[Could not read file: ${err.message}]`;
      }
    }),
  );
  return blocks.join("\n\n");
}
