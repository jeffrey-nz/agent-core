import { applyFileOperations } from "./operations/fileOps.js";
import { applyPatchOperations } from "./operations/patchOps.js";
import { applyMoveOperations } from "./operations/moveOps.js";
import { applyDeleteOperations } from "./operations/deleteOps.js";
import { applyDiffOperations } from "./operations/diffOps.js";

export async function applyAllOperations(
  rootDir,
  { patches = [], files = [], moves = [], deletes = [], diffs = [], allowedDirs = [], dryRun = false },
) {
  const result = { status: 0, stdout: "", stderr: "", errors: [], applied: 0 };

  await applyFileOperations(rootDir, files, result, allowedDirs, dryRun);
  await applyPatchOperations(rootDir, patches, result, allowedDirs, dryRun);
  await applyDiffOperations(rootDir, diffs, result, allowedDirs, dryRun);
  await applyMoveOperations(rootDir, moves, result, allowedDirs, dryRun);
  await applyDeleteOperations(rootDir, deletes, result, allowedDirs, dryRun);

  return result;
}
