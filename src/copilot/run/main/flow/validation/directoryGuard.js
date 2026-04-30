import fs from "node:fs";

export function validateTargetDirectory(gitDir) {
  if (gitDir && !fs.existsSync(gitDir)) {
    throw new Error(
      `Target directory does not exist: ${gitDir}. Please ensure the path is correct and accessible.`,
    );
  }
}
