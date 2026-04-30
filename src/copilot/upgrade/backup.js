import fs from 'node:fs/promises';
import path from 'node:path';
import { logStructured } from '#app/ui/log.js';

/**
 * Create timestamped backup of critical files before upgrade.
 * @param {string} projectDir - Absolute path to the project root
 * @param {string} requestId - Correlation ID for structured logging
 * @returns {Promise<{ok: boolean, backupDir?: string, files?: string[], error?: string}>}
 */
export async function createBackup(projectDir, requestId) {
  const backupDir = path.join(projectDir, '.backup');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const filesToBackup = ['package.json', 'src/index.js', 'launcher.js'];
  const backedUpFiles = [];

  try {
    await fs.mkdir(backupDir, { recursive: true });
    for (const relPath of filesToBackup) {
      const srcPath = path.join(projectDir, relPath);
      try {
        await fs.access(srcPath);
      } catch {
        continue; // file doesn't exist in this project — skip silently
      }
      const baseName = path.basename(relPath);
      const destPath = path.join(backupDir, `${baseName}.${timestamp}`);
      await fs.copyFile(srcPath, destPath);
      backedUpFiles.push(destPath);
    }
    logStructured({
      requestId,
      actor: 'backup',
      phase: 'pre-upgrade',
      message: `Backup created in ${backupDir}`,
      data: { backupDir, files: backedUpFiles, timestamp },
      success: true
    });
    return { ok: true, backupDir, files: backedUpFiles };
  } catch (err) {
    logStructured({
      requestId,
      actor: 'backup',
      phase: 'pre-upgrade',
      message: `Backup failed: ${err.message}`,
      success: false,
      error: err.message
    });
    return { ok: false, error: err.message };
  }
}
