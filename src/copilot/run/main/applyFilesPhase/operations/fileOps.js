import fs from "node:fs/promises";
import path from "node:path";
import { validateFileTarget } from "./validator.js";
import { sanitizeCode } from "./sanitize.js";

export async function applyFileOperations(rootDir, files, result, allowedDirs = [], dryRun = false) {
  for (const file of files) {
    if (!validateFileTarget(rootDir, file.filePath, "edit", result, allowedDirs)) continue;

    const absPath = path.resolve(rootDir, file.filePath);
    if (dryRun) {
      result.stdout += `[DRY RUN] Would write file: ${absPath}\n`;
      result.applied++;
      continue;
    }
    try {
      await fs.mkdir(path.dirname(absPath), { recursive: true });

      const finalContent = sanitizeCode(file.content);

      await fs.writeFile(absPath, finalContent, "utf8");
      result.stdout += `Successfully wrote file: ${absPath}\n`;
      result.applied++;
    } catch (err) {
      result.errors.push(`Failed to write ${file.filePath}: ${err.message}`);
      result.status = 1;
    }
  }
}
