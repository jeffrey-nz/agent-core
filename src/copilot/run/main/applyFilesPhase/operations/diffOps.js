import fs from "node:fs/promises";
import path from "node:path";
import { parsePatch, applyPatch } from "diff";
import { validateFileTarget } from "./validator.js";

export async function applyDiffOperations(rootDir, diffs, result, allowedDirs = [], dryRun = false) {
  for (let i = 0; i < diffs.length; i++) {
    const diffItem = diffs[i];
    if (!diffItem.diffContent) continue;

    try {
      const parsedPatches = parsePatch(diffItem.diffContent);

      for (const patch of parsedPatches) {
        const targetFile =
          patch.newFileName.replace(/^[ab]\//, "") ||
          patch.oldFileName.replace(/^[ab]\//, "");

        if (!validateFileTarget(rootDir, targetFile, "apply_diff to", result, allowedDirs)) continue;

        const absPath = path.resolve(rootDir, targetFile);

        if (dryRun) {
          result.stdout += `[DRY RUN] Would apply diff to: ${targetFile}\n`;
          result.applied++;
          continue;
        }

        let oldContent = "";
        try {
          oldContent = await fs.readFile(absPath, "utf8");
        } catch (e) {}

        const newContent = applyPatch(oldContent, patch, { fuzzFactor: 3 });

        if (newContent === false) {
          result.errors.push(
            `Failed to apply diff to ${targetFile}. The context lines did not match the current file state.`,
          );
          result.status = 1;
        } else {
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, newContent, "utf8");
          result.stdout += `Successfully applied unified diff to ${targetFile}.\n`;
          result.applied++;
        }
      }
    } catch (err) {
      result.errors.push(`System error parsing/applying diff: ${err.message}`);
      result.status = 1;
    }
  }
}
