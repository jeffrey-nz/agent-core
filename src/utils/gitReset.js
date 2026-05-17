/**
 * Robust git reset utility that handles permission-blocked files.
 *
 * SilverStripe (and other web apps) have files written by the web server
 * process (www-data) such as public/assets/.htaccess. When git tries to
 * reset these during `git reset --hard HEAD`, it fails with:
 *
 *   unable to unlink old 'public/assets/.htaccess': Permission denied
 *   fatal: Could not reset index file to revision 'HEAD'
 *
 * This utility detects that scenario, attempts to fix permissions
 * (via sudo chown or chmod), and retries. If permissions cannot be fixed,
 * it uses `git update-index --skip-worktree` to tell git to leave the
 * blocked files alone, resets everything else, then restores the flags.
 */

import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

// Matches: unable to unlink old 'some/path/file': Permission denied
const UNLINK_RE = /unable to unlink (?:old )?'([^']+)'/gi;
// Matches: error: open("some/path"): Permission denied
const OPEN_RE = /error: open\("([^"]+)"\): Permission denied/gi;

/**
 * Extract repo-relative file paths that git couldn't access.
 */
function extractBlockedPaths(errorText) {
  const files = new Set();
  for (const m of errorText.matchAll(UNLINK_RE)) files.add(m[1]);
  for (const m of errorText.matchAll(OPEN_RE)) files.add(m[1]);
  return [...files];
}

function isPermissionError(errorText) {
  const low = errorText.toLowerCase();
  return low.includes("permission denied") || low.includes("unlink old");
}

/**
 * Try to regain write access to a file.
 * Attempts sudo chown first, falls back to chmod.
 * Returns true if the file is now writable.
 */
async function tryFixPermission(absPath, cwd) {
  // Try sudo chown to current user
  const whoami = (await execAsync("id -un", { cwd })).stdout?.trim();
  if (whoami) {
    const chown = await execAsync(`sudo chown "${whoami}" -- "${absPath}"`, { cwd });
    if (chown.status === 0) return true;
  }

  // Fall back to chmod u+w
  const chmod = await execAsync(`chmod u+w -- "${absPath}"`, { cwd });
  return chmod.status === 0;
}

/**
 * Robust git reset to HEAD.
 *
 * @param {string} cwd - Absolute path to the git repository root
 * @returns {{ ok: boolean, fixedFiles?: string[], skippedFiles?: string[], error?: string }}
 */
export async function gitResetHard(cwd) {
  // ── First attempt ────────────────────────────────────────────────────────
  const first = await execAsync("git reset --hard HEAD", { cwd });

  if (first.status === 0) {
    // Only clean non-source files — nuclear writes source files directly to disk
    // before they're committed, so git clean -fd would delete them. Limit cleanup
    // to known junk: compiled artifacts, logs, temp dirs.
    await execAsync(
      "git clean -fd --exclude='*.js' --exclude='*.ts' --exclude='*.tsx' --exclude='*.jsx' --exclude='*.css' --exclude='*.html' --exclude='*.htm' --exclude='*.py' --exclude='*.rb' --exclude='*.php' --exclude='*.go' --exclude='*.java' --exclude='*.json' --exclude='*.yaml' --exclude='*.yml' --exclude='*.toml' --exclude='*.md' --exclude='*.txt' --exclude='*.svg' --exclude='*.png' --exclude='*.jpg'",
      { cwd }
    );
    return { ok: true };
  }

  const errorText = `${first.stderr}\n${first.stdout}`;

  if (!isPermissionError(errorText)) {
    // Not a permission problem — surface the raw error
    return { ok: false, error: errorText.trim() };
  }

  const blocked = extractBlockedPaths(errorText);

  if (blocked.length === 0) {
    return { ok: false, error: errorText.trim() };
  }

  log(
    colors.yellow(
      `  [GitReset] Permission denied on ${blocked.length} file(s) — attempting auto-fix:\n` +
        blocked.map((f) => `    ${f}`).join("\n"),
    ),
  );

  const fixedFiles = [];
  const skippedFiles = [];

  for (const relPath of blocked) {
    const absPath = path.resolve(cwd, relPath);
    const fixed = await tryFixPermission(absPath, cwd);
    if (fixed) {
      fixedFiles.push(relPath);
      log(colors.dim(`  [GitReset] ✓ Permission fixed: ${relPath}`));
    } else {
      skippedFiles.push(relPath);
      log(
        colors.yellow(
          `  [GitReset] ✗ Cannot fix permissions on: ${relPath} — will exclude from reset`,
        ),
      );
    }
  }

  // ── Mark unfixable files as skip-worktree so git ignores them ────────────
  for (const relPath of skippedFiles) {
    await execAsync(`git update-index --skip-worktree -- "${relPath}"`, { cwd });
  }

  // ── Second attempt (all fixed, or skipped files excluded) ────────────────
  const second = await execAsync("git reset --hard HEAD", { cwd });

  // Always restore skip-worktree flags so normal git operations work afterwards
  for (const relPath of skippedFiles) {
    await execAsync(`git update-index --no-skip-worktree -- "${relPath}"`, { cwd });
  }

  if (second.status === 0) {
    await execAsync(
      "git clean -fd --exclude='*.js' --exclude='*.ts' --exclude='*.tsx' --exclude='*.jsx' --exclude='*.css' --exclude='*.html' --exclude='*.htm' --exclude='*.py' --exclude='*.rb' --exclude='*.php' --exclude='*.go' --exclude='*.java' --exclude='*.json' --exclude='*.yaml' --exclude='*.yml' --exclude='*.toml' --exclude='*.md' --exclude='*.txt' --exclude='*.svg' --exclude='*.png' --exclude='*.jpg'",
      { cwd }
    );

    if (fixedFiles.length > 0) {
      log(
        colors.cyan(
          `  [GitReset] Reset succeeded after fixing permissions on: ${fixedFiles.join(", ")}`,
        ),
      );
    }
    if (skippedFiles.length > 0) {
      log(
        colors.yellow(
          `  [GitReset] Reset succeeded but these files were NOT reverted (owned by another user):\n` +
            skippedFiles.map((f) => `    ${f}  ← run: sudo chown $(id -un) "${path.resolve(cwd, f)}"`).join("\n"),
        ),
      );
    }

    return { ok: true, fixedFiles, skippedFiles };
  }

  const finalError = `${second.stderr}\n${second.stdout}`.trim();
  log(
    colors.red(
      `  [GitReset] Reset failed after permission fix attempts.\n` +
        `  Manual fix: sudo chown $(id -un) ${blocked.map((f) => `"${path.resolve(cwd, f)}"`).join(" ")}\n` +
        `  Then re-run the session.\n` +
        `  Error: ${finalError}`,
    ),
  );

  return { ok: false, fixedFiles, skippedFiles, error: finalError };
}
