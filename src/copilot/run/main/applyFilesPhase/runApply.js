import path from "node:path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { execAsync } from "#utils/exec.js";
import { applyAllOperations } from "./applyPatch.js";
import { verifyGitChanges } from "./verifyGit.js";
import { runAdvancedValidator } from "./advancedValidator.js";
import { validateOperations } from "./lib/validation.js";
import { logOperationStats } from "./lib/logging.js";
import { rollbackFilesystem } from "./lib/rollback.js";

export async function applyUpdatesScript(
  projectDir,
  executionOps,
  options = {},
) {
  const { skipGitCheck = false, allowedDirs = [], dryRun = false } = options;
  log(`\n🔍 apply: Applying file operations from JSON tools...`);

  const debugData = { stdout: "", stderr: "" };

  const validation = validateOperations(executionOps);
  if (!validation.ok) {
    log(`\n⚠️  ${validation.error}`);
    return { ok: false, applied: 0, errors: [validation.error], debugData };
  }

  logOperationStats(executionOps);

  if (dryRun) {
    log(colors.cyan('\n[DRY RUN] Simulating file operations (no changes will be written):'));
    for (const f of executionOps.files || []) {
      log(colors.dim(`  Would write file: ${f.filePath}`));
    }
    for (const p of executionOps.patches || []) {
      log(colors.dim(`  Would patch file: ${p.filePath}`));
    }
    for (const m of executionOps.moves || []) {
      log(colors.dim(`  Would move file: ${m.source} -> ${m.destination}`));
    }
    for (const d of executionOps.deletes || []) {
      log(colors.dim(`  Would delete file: ${d.filePath}`));
    }
    for (const diff of executionOps.diffs || []) {
      log(colors.dim(`  Would apply diff to: ${diff.diffContent ? 'content' : 'unknown'}`));
    }
    return { ok: true, applied: 0, errors: [], debugData: { stdout: '', stderr: '' }, dryRun: true };
  }

  const execRes = await applyAllOperations(projectDir, { ...executionOps, allowedDirs, dryRun });
  debugData.stdout = execRes.stdout;
  debugData.stderr = execRes.stderr;

  if (execRes.errors.length > 0) {
    return {
      ok: false,
      applied: execRes.applied,
      errors: execRes.errors,
      debugData,
    };
  }

  const modifiedPaths = [];
  for (const f of executionOps.files || []) modifiedPaths.push(f.filePath);
  for (const p of executionOps.patches || []) modifiedPaths.push(p.filePath);
  for (const m of executionOps.moves || []) modifiedPaths.push(m.destination);

  const absolutePaths = modifiedPaths.map((p) => path.resolve(projectDir, p));

  // Determine which git repos were actually touched.
  // Files may span multiple repos (e.g. self-upgrade mode).
  const touchedRoots = resolveGitRoots(projectDir, absolutePaths, allowedDirs);

  const lintRes = await runAdvancedValidator(projectDir, absolutePaths);

  if (!lintRes.ok) {
    await rollbackFilesystem(touchedRoots, 'static_analysis_failure');
    return {
      ok: false,
      applied: 0,
      errors: [
        `[STATIC ANALYSIS FAILURE] Your changes introduced syntax/type errors. The codebase has been ROLLED BACK. Fix these errors:\n\n${lintRes.errors.join("\n\n")}`,
      ],
      debugData,
      touchedRoots,
    };
  }

  if (skipGitCheck)
    return { ok: true, applied: execRes.applied, errors: [], debugData };

  const gitRes = await verifyGitChanges(touchedRoots, execRes.stdout);

  return {
    ok: gitRes.hasChanges,
    errors: gitRes.errors || [],
    gitStatus: gitRes.gitStatus,
    applied: execRes.applied,
    debugData,
    touchedRoots,
  };
}

/**
 * Given the primary projectDir, a list of absolute file paths that were
 * written, and the allowedDirs list, return the unique set of git repo roots
 * that were touched.  Falls back to [projectDir] when no extra dirs apply.
 */
function resolveGitRoots(projectDir, absolutePaths, allowedDirs = []) {
  const candidateRoots = [path.resolve(projectDir)];
  for (const d of allowedDirs) {
    if (d) candidateRoots.push(path.resolve(d));
  }

  const touched = new Set([path.resolve(projectDir)]);
  for (const absPath of absolutePaths) {
    for (const root of candidateRoots) {
      if (absPath === root || absPath.startsWith(root + path.sep)) {
        touched.add(root);
        break;
      }
    }
  }
  return [...touched];
}
