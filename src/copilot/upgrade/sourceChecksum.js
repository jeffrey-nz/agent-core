import fg from "fast-glob";
const { glob } = fg;
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logStructured } from "#app/ui/log.js";

/**
 * Compute SHA-256 checksum of all source files in projectDir, excluding common build/cache directories.
 * @param {string} projectDir - Absolute path to the project root
 * @param {string} expectedChecksum - Expected SHA-256 hex string (64 chars)
 * @param {string} requestId - Correlation ID for logging
 * @returns {Promise<boolean>} - True if checksum matches, false otherwise
 */
export async function verifySourceChecksum(projectDir, expectedChecksum, requestId) {
  const startTime = Date.now();
  const ignorePatterns = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/coverage/**",
    "**/.copilot-sessions/**",
    "**/*.log",
    "**/.env",
    "**/package-lock.json"
  ];

  try {
    const files = await glob("**/*", {
      cwd: projectDir,
      absolute: true,
      ignore: ignorePatterns,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false
    });

    logStructured({
      requestId,
      actor: "source-checksum",
      phase: "compute",
      message: `Found ${files.length} source files to checksum`,
      data: { fileCount: files.length },
      success: true
    });

    const hash = crypto.createHash("sha256");

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath);
        hash.update(content);
      } catch (readErr) {
        logStructured({
          requestId,
          actor: "source-checksum",
          phase: "compute",
          message: `Failed to read file: ${path.relative(projectDir, filePath)}`,
          success: false,
          error: readErr.message
        });
        return false;
      }
    }

    const computedChecksum = hash.digest("hex");
    const durationMs = Date.now() - startTime;
    const ok = computedChecksum === expectedChecksum;

    logStructured({
      requestId,
      actor: "source-checksum",
      phase: "verification",
      message: ok ? "Source checksum matches expected" : "Source checksum mismatch",
      data: {
        expectedChecksum,
        computedChecksum: ok ? undefined : computedChecksum,
        durationMs
      },
      success: ok,
      error: ok ? undefined : `Expected ${expectedChecksum}, got ${computedChecksum}`
    });

    return ok;
  } catch (err) {
    logStructured({
      requestId,
      actor: "source-checksum",
      phase: "verification",
      message: `Source checksum verification failed: ${err.message}`,
      success: false,
      error: err.message
    });
    return false;
  }
}
