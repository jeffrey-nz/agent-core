import path from "node:path";
import { isSafePath, isCompiledFile, isProtectedPath } from "./pathUtils.js";

export function validateFileTarget(rootDir, targetPath, actionName, result, allowedDirs = []) {
  if (isCompiledFile(targetPath)) {
    result.errors.push(
      `Validation Error: Attempted to ${actionName} a compiled file -> ${targetPath}. You MUST target source files instead.`,
    );
    result.status = 1;
    return false;
  }

  if (isProtectedPath(targetPath)) {
    result.errors.push(
      `Security Error: Prevented ${actionName} of protected directory -> ${targetPath}. The vendor/, node_modules/, and .git/ directories are read-only and must not be modified.`,
    );
    result.status = 1;
    return false;
  }

  if (!isSafePath(rootDir, targetPath, allowedDirs)) {
    result.errors.push(
      `Security Error: Prevented ${actionName} out of bounds -> ${targetPath}. Paths must be relative or start with: ${path.resolve(rootDir)}`,
    );
    result.status = 1;
    return false;
  }

  return true;
}
