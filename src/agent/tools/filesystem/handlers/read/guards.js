import path from "node:path";
import { isSafePath, isIgnored } from "../../utils.js";

const HARD_BLOCKED_FILES = [
  "composer.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

export function checkReadSafety(rootDir, fileRelPath, ignore, spinner, allowedDirs = []) {
  const fileName = path.basename(fileRelPath).toLowerCase();

  if (HARD_BLOCKED_FILES.includes(fileName)) {
    return `[ERROR: Reading ${fileName} directly is FORBIDDEN. Use 'check_package_version' instead.]`;
  }

  if (!isSafePath(rootDir, fileRelPath, allowedDirs)) {
    spinner?.fail(`Path out of bounds: ${fileRelPath}`);
    return `[ERROR: Path out of bounds]`;
  }

  if (isIgnored(fileRelPath, ignore)) {
    spinner?.fail(`Access Blocked (Ignored): ${fileRelPath}`);
    return `[ERROR: This file is restricted/compiled and cannot be read.]`;
  }

  return null;
}
