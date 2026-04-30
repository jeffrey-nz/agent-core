import { execAsync } from "#utils/exec.js";
import { logStructured } from "#app/ui/log.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Pre-upgrade validation: disk space, file integrity, Node version.
 * @param {string} projectDir - Absolute path to the project root (e.g., /Users/jeffrey/copilot-helper)
 * @param {string} requestId - Correlation ID for structured logging (e.g., session ID)
 * @returns {Promise<{ok: boolean, checks: object}>}
 */
export async function preUpgradeValidate(projectDir, requestId, force = false) {
  const checks = {
    diskSpace: { ok: false, error: null },
    fileIntegrity: { ok: false, error: null },
    nodeVersion: { ok: false, error: null }
  };

  // 1. Disk space check (require at least 100 MB free)
  if (force) {
    checks.diskSpace.ok = true;
  } else {
    try {
      // Get mount point of projectDir
      const dfOut = await execAsync(`df -k "${projectDir}"`);
      const lines = dfOut.stdout.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        // typical df output: Filesystem 1024-blocks Used Available Capacity Mounted on
        // Available is at index 3 (0-based)
        const availableKB = parseInt(parts[3], 10);
        if (!isNaN(availableKB)) {
          const minKB = 102400; // 100 MB
          checks.diskSpace.ok = availableKB >= minKB;
          if (!checks.diskSpace.ok) {
            checks.diskSpace.error = `Insufficient disk space: ${Math.round(availableKB / 1024)} MB available, need at least 100 MB`;
          }
        } else {
          checks.diskSpace.error = "Could not parse df output for available space";
        }
      } else {
        checks.diskSpace.error = "df command returned unexpected output";
      }
    } catch (err) {
      checks.diskSpace.error = `Disk space check failed: ${err.message}`;
    }
  }

  // 2. File integrity: check for package.json only if the project is Node-based
  const packageJsonPath = path.resolve(projectDir, "package.json");
  let packageJson = null;
  try {
    const pkgContent = await fs.readFile(packageJsonPath, "utf8");
    packageJson = JSON.parse(pkgContent);
    checks.fileIntegrity.ok = true;
  } catch (err) {
    if (err.code === "ENOENT") {
      // Not a Node.js project — skip package.json checks entirely
      checks.fileIntegrity.ok = true;
    } else {
      checks.fileIntegrity.error = `package.json unreadable: ${err.message}`;
    }
  }

  // 3. Node version check (only applies when package.json with engines.node exists)
  if (force || !packageJson) {
    checks.nodeVersion.ok = true;
  } else {
    try {
      const engineConstraint = packageJson.engines?.node;
      if (!engineConstraint) {
        checks.nodeVersion.ok = true;
      } else {
        const match = engineConstraint.match(/>=?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (match) {
          const requiredMajor = parseInt(match[1], 10);
          const requiredMinor = match[2] ? parseInt(match[2], 10) : 0;
          const requiredPatch = match[3] ? parseInt(match[3], 10) : 0;
          const currentVersion = process.version.slice(1);
          const [currentMajor, currentMinor, currentPatch] = currentVersion.split(".").map(Number);
          const ok = (currentMajor > requiredMajor) ||
                     (currentMajor === requiredMajor && currentMinor > requiredMinor) ||
                     (currentMajor === requiredMajor && currentMinor === requiredMinor && currentPatch >= requiredPatch);
          checks.nodeVersion.ok = ok;
          if (!ok) {
            checks.nodeVersion.error = `Node version mismatch: required ${engineConstraint}, found ${currentVersion}`;
          }
        } else {
          checks.nodeVersion.error = `Unsupported engines.node format: ${engineConstraint}`;
        }
      }
    } catch (err) {
      checks.nodeVersion.error = `Node version check failed: ${err.message}`;
    }
  }

  // Log each check using structured logging
  const overallOk = checks.diskSpace.ok && checks.fileIntegrity.ok && checks.nodeVersion.ok;
  const logEntry = {
    requestId,
    actor: "upgrader",
    phase: "pre_validation",
    message: overallOk ? "Pre-upgrade validation passed" : "Pre-upgrade validation failed",
    data: {
      diskSpaceOk: checks.diskSpace.ok,
      fileIntegrityOk: checks.fileIntegrity.ok,
      nodeVersionOk: checks.nodeVersion.ok
    },
    success: overallOk
  };
  if (!overallOk) {
    logEntry.error = Object.values(checks).filter(c => !c.ok).map(c => c.error).join("; ");
  }
  logStructured(logEntry);

  return { ok: overallOk, checks };
}
