import path from "node:path";
import { safeExec } from "#utils/exec.js";

export async function handlePackageVersion(input) {
  const { package: pkg, working_dir } = input;
  const lockPath = path.join(working_dir, "composer.lock");

  const cmd = `grep -A 5 '"name": "${pkg}"' "${lockPath}" | grep '"version":' | head -n 1`;

  try {
    const result = await safeExec(cmd);
    if (!result.stdout) {
      return `[NOT FOUND] Package "${pkg}" is not present in ${lockPath}.`;
    }
    const version = result.stdout.match(/"version":\s*"([^"]+)"/)?.[1];
    return `[SUCCESS] ${pkg} version is currently: ${version || "unknown format"}`;
  } catch (err) {
    return `[ERROR] Failed to query composer.lock: ${err.message}`;
  }
}
