import path from "node:path";
import { execAsync } from "#utils/exec.js";

export async function checkPhpSyntax(projectDir, phpFiles) {
  const errors = [];
  for (const absPath of phpFiles) {
    const res = await execAsync(`php -l "${absPath}"`, { cwd: projectDir });
    if (res.status !== 0) {
      const cleanErr = (res.stderr || res.stdout)
        .replace(/^Errors parsing.*$/gm, "")
        .trim();
      errors.push(
        `PHP Syntax Error in ${path.relative(projectDir, absPath)}:\n${cleanErr}`,
      );
    }
  }
  return errors;
}
