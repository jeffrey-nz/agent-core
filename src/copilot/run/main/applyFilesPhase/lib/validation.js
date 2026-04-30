import { detectLazyTruncation } from "../detectLazyOutput.js";

export function validateOperations(executionOps) {
  const hasOps =
    executionOps.patches.length > 0 ||
    executionOps.files.length > 0 ||
    executionOps.moves.length > 0 ||
    executionOps.deletes.length > 0;

  if (!hasOps) {
    return {
      ok: false,
      error: "No valid file operations were provided in the tool call.",
    };
  }

  const lazyErrors = detectLazyTruncation(executionOps);
  if (lazyErrors.length > 0) {
    return { ok: false, error: lazyErrors[0] };
  }

  return { ok: true };
}
