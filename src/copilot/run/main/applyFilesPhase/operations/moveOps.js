import fs from "node:fs/promises";
import path from "node:path";
import { validateFileTarget } from "./validator.js";

export async function applyMoveOperations(rootDir, moves, result, allowedDirs = [], dryRun = false) {
  for (const move of moves) {
    if (!validateFileTarget(rootDir, move.source, "move (source)", result, allowedDirs))
      continue;
    if (
      !validateFileTarget(
        rootDir,
        move.destination,
        "move (destination)",
        result,
        allowedDirs,
      )
    )
      continue;

    const srcAbs = path.resolve(rootDir, move.source);
    const destAbs = path.resolve(rootDir, move.destination);

    if (dryRun) {
      result.stdout += `[DRY RUN] Would move: ${srcAbs} -> ${destAbs}\n`;
      result.applied++;
      continue;
    }
    try {
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.rename(srcAbs, destAbs);
      result.stdout += `Successfully moved: ${srcAbs} -> ${destAbs}\n`;
      result.applied++;
    } catch (err) {
      result.errors.push(`Failed to move ${move.source}: ${err.message}`);
      result.status = 1;
    }
  }
}
