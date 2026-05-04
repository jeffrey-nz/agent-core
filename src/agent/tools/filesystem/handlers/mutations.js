import { applyUpdatesScript } from "#copilot/run/main/applyFilesPhase/index.js";
import { appendDiffOrStatus, appendGitStatus } from "./formatters.js";
import { execAsync } from "#utils/exec.js";
import path from "node:path";
import { colors } from "#app/ui/colors.js";
import { log } from "#app/ui/log.js";

// Filenames that are legitimately written to a project root directory.
const ALLOWED_ROOT_FILENAMES = new Set([
  "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE.md", "CLAUDE.md",
  "TODO.md", "ROADMAP.md", "NOTES.md", ".env.example",
]);

/**
 * Returns true if the file is a junk AI-generated report written directly to a
 * project root. These files accumulate across sessions and are never useful.
 * Examples: FIXUP_COMPLETE.md, VERIFICATION_REPORT.md, research-report-*.md
 */
function isJunkRootFile(filePath, rootDir, allowedDirs) {
  const resolvedFile = path.resolve(filePath);
  const roots = [path.resolve(rootDir), ...allowedDirs.map((d) => path.resolve(d))];
  for (const root of roots) {
    if (path.dirname(resolvedFile) === root) {
      const basename = path.basename(resolvedFile);
      const ext = path.extname(basename).toLowerCase();
      if ((ext === ".md" || ext === ".txt") && !ALLOWED_ROOT_FILENAMES.has(basename)) {
        return true;
      }
    }
  }
  return false;
}

export async function handleApplyDiff(input, { rootDir, state, allowedDirs = [] }) {
  // Accept 'diff' as an alias for 'diff_content' - the AI occasionally uses the
  // shorter name and we don't want a parameter-name mismatch to burn retry turns.
  const diffContent = input.diff_content ?? input.diff ?? null;
  if (typeof diffContent !== "string") {
    return `[ERROR applying diff]\nValidation Error: apply_diff requires a 'diff_content' string parameter (received: ${JSON.stringify(Object.keys(input))}).`;
  }
  const result = await applyUpdatesScript(rootDir, {
    files: [],
    patches: [],
    diffs: [{ diffContent }],
    moves: [],
    deletes: [],
  }, { allowedDirs });
  if (state && result.touchedRoots) {
    if (!state.touchedRoots) state.touchedRoots = [];
    for (const root of result.touchedRoots) {
      if (!state.touchedRoots.includes(root)) state.touchedRoots.push(root);
    }
  }
  if (result.ok) {
    let msg = `[SUCCESS] Unified Diff applied successfully.`;
    if (result.gitStatus) msg = appendGitStatus(msg, result.gitStatus);
    return msg;
  }
  return `[ERROR applying diff]\n${result.errors.join("\n")}`;
}

export async function handleMoveFile(input, { rootDir, state, allowedDirs = [] }) {
  const result = await applyUpdatesScript(rootDir, {
    files: [],
    patches: [],
    diffs: [],
    moves: [{ from: input.source, to: input.destination }],
    deletes: [],
  }, { allowedDirs });
  if (state && result.touchedRoots) {
    if (!state.touchedRoots) state.touchedRoots = [];
    for (const root of result.touchedRoots) {
      if (!state.touchedRoots.includes(root)) state.touchedRoots.push(root);
    }
  }
  if (result.ok) {
    state?.addModifiedFile(input.destination);
    let msg = `[SUCCESS] Moved: ${input.source} -> ${input.destination}`;
    if (result.gitStatus) msg = appendGitStatus(msg, result.gitStatus);
    return msg;
  }
  return `[ERROR moving ${input.source}]\n${result.errors.join("\n")}`;
}

export async function handleDeleteFile(input, { rootDir, state, allowedDirs = [] }) {
  const result = await applyUpdatesScript(rootDir, {
    files: [],
    patches: [],
    diffs: [],
    moves: [],
    deletes: [{ filePath: input.path }],
  }, { allowedDirs });
  if (state && result.touchedRoots) {
    if (!state.touchedRoots) state.touchedRoots = [];
    for (const root of result.touchedRoots) {
      if (!state.touchedRoots.includes(root)) state.touchedRoots.push(root);
    }
  }
  if (result.ok) {
    let msg = `[SUCCESS] Deleted: ${input.path}`;
    if (result.gitStatus) msg = appendGitStatus(msg, result.gitStatus);
    return msg;
  }
  return `[ERROR deleting ${input.path}]\n${result.errors.join("\n")}`;
}

export async function handleRevertFile(input, { rootDir, state }) {
  const relPath = input.path;
  const absPath = path.resolve(rootDir, relPath);

  // ── First attempt ────────────────────────────────────────────────────────
  const res = await execAsync(`git checkout HEAD -- "${relPath}"`, {
    cwd: rootDir,
  });

  if (res.status === 0) {
    if (state && state.modifiedFiles) {
      state.modifiedFiles = state.modifiedFiles.filter((f) => f !== relPath);
    }
    return `[SUCCESS] Reverted ${relPath} to HEAD.`;
  }

  const errorText = `${res.stderr}\n${res.stdout}`;
  const isPermDenied =
    errorText.toLowerCase().includes("permission denied") ||
    errorText.toLowerCase().includes("unlink old");

  if (!isPermDenied) {
    return `[ERROR] Failed to revert ${relPath}: ${errorText.trim()}`;
  }

  // ── Permission denied - try to fix ownership ──────────────────────────
  log(
    colors.yellow(
      `  [Revert] Permission denied on ${relPath} - attempting auto-fix...`,
    ),
  );

  const whoami = (await execAsync("id -un", { cwd: rootDir })).stdout?.trim();
  let fixed = false;

  if (whoami) {
    const chown = await execAsync(
      `sudo chown "${whoami}" -- "${absPath}"`,
      { cwd: rootDir },
    );
    if (chown.status === 0) fixed = true;
  }

  if (!fixed) {
    const chmod = await execAsync(`chmod u+w -- "${absPath}"`, {
      cwd: rootDir,
    });
    fixed = chmod.status === 0;
  }

  if (!fixed) {
    log(
      colors.yellow(
        `  [Revert] Could not fix permissions on ${relPath}.\n` +
          `  Manual fix: sudo chown $(id -un) "${absPath}"`,
      ),
    );
    return (
      `[ERROR] Failed to revert ${relPath}: permission denied.\n` +
      `Manual fix: sudo chown $(id -un) "${absPath}"`
    );
  }

  // ── Second attempt after permission fix ──────────────────────────────
  const res2 = await execAsync(`git checkout HEAD -- "${relPath}"`, {
    cwd: rootDir,
  });

  if (res2.status === 0) {
    log(colors.dim(`  [Revert] ✓ Permission fixed and file reverted: ${relPath}`));
    if (state && state.modifiedFiles) {
      state.modifiedFiles = state.modifiedFiles.filter((f) => f !== relPath);
    }
    return `[SUCCESS] Reverted ${relPath} to HEAD (after fixing permissions).`;
  }

  return `[ERROR] Failed to revert ${relPath} even after permission fix: ${`${res2.stderr}\n${res2.stdout}`.trim()}`;
}

export async function handlePatchFile(input, { rootDir, state, allowedDirs = [] }) {
  if (
    typeof input.search_block !== "string" ||
    typeof input.replace_block !== "string"
  ) {
    return `[ERROR patching ${input.path || "unknown"}]\nValidation Error: patch_file requires 'search_block' and 'replace_block' string parameters.`;
  }
  const result = await applyUpdatesScript(rootDir, {
    files: [],
    patches: [
      {
        filePath: input.path,
        oldBlock: input.search_block,
        newBlock: input.replace_block,
        replaceAll: input.replace_all === true,
      },
    ],
    diffs: [],
    moves: [],
    deletes: [],
  }, { allowedDirs });
  if (result.ok) {
    state?.addModifiedFile(input.path);
    let msg = `[SUCCESS] Patch applied to: ${input.path}`;
    return await appendDiffOrStatus(msg, input.path, rootDir, result);
  }
  return `[ERROR patching ${input.path}]\n${result.errors.join("\n")}`;
}

export async function handleWriteFile(input, { rootDir, state, allowedDirs = [] }) {
  if (typeof input.content !== "string") {
    return `[ERROR writing ${input.path || "unknown"}]\nValidation Error: write_file requires a 'content' parameter containing the file text.`;
  }
  if (input.content.trim().length === 0) {
    return (
      `[ERROR writing ${input.path || "unknown"}]\n` +
      `Content is empty. You MUST provide the actual file content in the 'content' parameter.\n` +
      `Writing an empty file is a pipeline failure — the verifier will reject it immediately.\n` +
      `Re-read the file if needed, then write the complete implementation now.`
    );
  }
  if (isJunkRootFile(input.path, rootDir, allowedDirs)) {
    return (
      `[BLOCKED] Writing .md/.txt report files directly to a project root is not allowed. ` +
      `Do NOT write completion summaries, verification reports, or research notes as files. ` +
      `State your conclusion in your response text instead.`
    );
  }
  try {
    const result = await applyUpdatesScript(rootDir, {
      files: [{ filePath: input.path, content: input.content }],
      patches: [],
      diffs: [],
      moves: [],
      deletes: [],
    }, { allowedDirs });
    if (result.ok) {
      state?.addModifiedFile(input.path);
      let msg = `[SUCCESS] File written: ${input.path}`;
      const text = await appendDiffOrStatus(msg, input.path, rootDir, result);
      return { ok: true, path: input.path, text };
    }
    // Check for transient errors that should be retried
    const errorText = result.errors.join("\n");
    if (errorText.includes("EBUSY") || errorText.includes("EEXIST")) {
      const retryableError = new Error(`Transient write error: ${errorText}`);
      retryableError.retryable = true;
      throw retryableError;
    }
    return `[ERROR writing ${input.path}]\n${errorText}`;
  } catch (err) {
    // If it's already a retryable error, rethrow; otherwise check error code
    if (err.retryable) throw err;
    if (err.code === 'EBUSY' || err.code === 'EEXIST') {
      const retryableError = new Error(`Transient write error: ${err.code}`);
      retryableError.retryable = true;
      throw retryableError;
    }
    throw err;
  }
}
