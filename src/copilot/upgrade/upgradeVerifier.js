import { execAsync } from "#utils/exec.js";
import { logStructured } from "#app/ui/log.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Upgrade verification: run npm test and report success/failure.
 * @param {string} projectDir - Absolute path to the project root (e.g., /Users/jeffrey/copilot-helper)
 * @param {string} requestId - Correlation ID for structured logging (e.g., session ID)
 * @param {number} timeoutMs - Timeout in milliseconds (default 60000)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
async function runStaticAnalysis(projectDir, requestId) {
  const pkgPath = path.join(projectDir, 'package.json');
  let pkg;
  try {
    const pkgContent = await fs.readFile(pkgPath, 'utf8');
    pkg = JSON.parse(pkgContent);
  } catch (err) {
    logStructured({ requestId, actor: 'static-analysis', phase: 'pre-verification', message: `Failed to read package.json: ${err.message}`, success: false, error: err.message });
    return false;
  }
  const hasLintScript = pkg.scripts && pkg.scripts.lint;
  if (hasLintScript) {
    const result = await execAsync('npm run lint', { cwd: projectDir });
    const ok = result.status === 0;
    logStructured({ requestId, actor: 'static-analysis', phase: 'pre-verification', message: ok ? 'npm run lint passed' : 'npm run lint failed', success: ok, error: ok ? undefined : result.stderr });
    return ok;
  } else {
    const findCmd = `find . -name "*.js" -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./dist/*" -exec node --check {} \\;`;
    const result = await execAsync(findCmd, { cwd: projectDir });
    const ok = result.status === 0;
    logStructured({ requestId, actor: 'static-analysis', phase: 'pre-verification', message: ok ? 'node --check passed' : 'node --check failed', success: ok, error: ok ? undefined : result.stderr });
    return ok;
  }
}

export async function verifyUpgrade(projectDir, requestId, timeoutMs = 60000, validationCommand = null) {
  const startTime = Date.now();

  // Skip JS-specific verification for non-Node projects (no package.json).
  // Unity, Swift, PHP etc. have their own verification paths inside the agent graph.
  const pkgExists = await fs.access(path.join(projectDir, 'package.json')).then(() => true).catch(() => false);
  if (!pkgExists && !validationCommand) {
    logStructured({ requestId, actor: 'verifier', phase: 'verification', message: 'Skipping npm verification — no package.json found (non-Node project)', success: true });
    return { ok: true, stdout: '', stderr: '' };
  }

  const staticOk = await runStaticAnalysis(projectDir, requestId);
  if (!staticOk) {
    return { ok: false, stdout: '', stderr: 'Static analysis failed' };
  }
  let result;
  const command = validationCommand || "npm test";
  try {
    result = await execAsync(command, {
      cwd: projectDir,
      timeout: timeoutMs
    });
  } catch (err) {
    // execAsync throws on non-zero exit; capture stdout/stderr from err object if available
    const stdout = err.stdout || "";
    const stderr = err.stderr || err.message || "";
    result = { status: err.code || 1, stdout, stderr };
  }

  const durationMs = Date.now() - startTime;
  const ok = result.status === 0;

  logStructured({
    requestId,
    actor: "verifier",
    phase: "verification",
    message: ok ? "npm test passed" : "npm test failed",
    data: { exitCode: result.status, durationMs },
    success: ok,
    error: ok ? undefined : `npm test exited with code ${result.status}. stderr: ${result.stderr.slice(0, 500)}`
  });

  return {
    ok,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}
