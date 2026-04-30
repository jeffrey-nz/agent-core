import fs from "node:fs/promises";
import path from "node:path";
import { validateFileTarget } from "./validator.js";

export async function applyDeleteOperations(rootDir, deletes, result, allowedDirs = [], dryRun = false) {
  for (const del of deletes) {
    if (!validateFileTarget(rootDir, del.filePath, "delete", result, allowedDirs)) continue;

    const absPath = path.resolve(rootDir, del.filePath);
    if (dryRun) {
      result.stdout += `[DRY RUN] Would delete: ${absPath}\n`;
      result.applied++;
      continue;
    }
    try {
      await fs.unlink(absPath);
      result.stdout += `Successfully deleted: ${absPath}\n`;
      result.applied++;
    } catch (err) {
      if (err.code !== "ENOENT") {
        result.errors.push(`Failed to delete ${del.filePath}: ${err.message}`);
        result.status = 1;
      }
    }
  }
}
