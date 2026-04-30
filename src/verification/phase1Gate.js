import fs from "node:fs";
import path from "node:path";

export function verifyPhase1Gate({
  projectRoot,
  modifiedFiles = [],
  diagnosticsRun = false,
}) {
  const errors = [];

  if (!Array.isArray(modifiedFiles) || modifiedFiles.length === 0) {
    errors.push("Phase 1 requires at least one modified file.");
  }

  const composerJson = path.join(projectRoot, "composer.json");
  const composerLock = path.join(projectRoot, "composer.lock");

  if (!fs.existsSync(composerJson)) {
    errors.push("composer.json is missing.");
  }

  if (!fs.existsSync(composerLock)) {
    errors.push("composer.lock is missing.");
  }

  if (!diagnosticsRun) {
    errors.push(
      "Required diagnostics (get_workspace_diagnostics) were not run.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
