/**
 * environmentNode.js — Pre-flight Environment Inspector
 *
 * Runs ONCE before the first coder turn (guarded by state.environmentChecked).
 * Establishes a baseline environment report BEFORE any files are written.
 *
 * Problem this solves (session 0816d5d5):
 *   The site was already at HTTP 500 before any YAML files were written.
 *   Every subsequent write_file triggered the smoke test, which failed on the
 *   pre-existing 500 — but the coder couldn't see that the 500 was NOT caused
 *   by their changes. They exhausted all retries on an unwinnable loop.
 *
 * What it checks:
 *   1. HTTP BASELINE — is the site already broken before the first write?
 *      If HTTP 500: flag as pre-existing, provide chown/chmod fix command
 *      If HTTP 200: site is healthy — all smoke test failures are our fault
 *   2. GIT STATUS — are there uncommitted changes from a prior session?
 *      Stale changes can confuse the verifier's modified-files tracking
 *   3. COMPOSER INTEGRITY — is vendor/ present and composer.json parseable?
 *   4. CACHE STATE — is there a stale SilverStripe compiled config in /tmp/?
 *
 * Output:
 *   - state.environmentReport: human-readable summary of findings
 *   - state.environmentHealthy: boolean (true = safe to proceed)
 *   - state.preExistingErrors: array of error strings (pre-existing issues)
 *   - state.environmentChecked: true (prevents re-running on subtask advances)
 *
 * Position: critic → environment → coder (first run)
 *           nextSubtask → planReviewer → coder (subsequent runs, node skips)
 *
 * No AI calls. Uses execAsync for shell checks.
 */

import { execAsync } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { personaMeta } from "../personas.js";

const PERSONA = personaMeta("environment");

/**
 * Discover the project's local dev URL from:
 *   1. .env SS_BASE_URL
 *   2. Apache/nginx vhost config
 *   3. Fallback: http://localhost
 */
async function discoverBaseUrl(projectDir) {
  // Try .env first (SilverStripe standard)
  try {
    const { stdout } = await execAsync(`grep -E "^SS_BASE_URL" .env 2>/dev/null || true`, { cwd: projectDir });
    const match = stdout.trim().match(/SS_BASE_URL\s*=\s*["']?([^"'\s]+)["']?/);
    if (match?.[1]) return { url: match[1].replace(/\/$/, ""), source: ".env SS_BASE_URL" };
  } catch { /* ignore */ }

  // Try Apache vhost
  try {
    const { stdout } = await execAsync(
      `grep -rh "ServerName\\|server_name" /etc/apache2/sites-enabled/ /etc/nginx/sites-enabled/ 2>/dev/null | grep -v "#" | head -5`,
      { cwd: projectDir },
    );
    const match = stdout.trim().match(/(?:ServerName|server_name)\s+(\S+)/);
    if (match?.[1] && match[1] !== "_") return { url: `http://${match[1]}`, source: "vhost config" };
  } catch { /* ignore */ }

  return { url: "http://localhost", source: "fallback" };
}

/**
 * Run a lightweight HTTP probe against the site's root URL.
 * Returns { status: number|null, body: string, error: string|null }
 */
async function probeHttp(baseUrl, projectDir) {
  try {
    const { stdout } = await execAsync(
      `curl -s -L --max-time 8 -w "\\n[HTTP_STATUS:%{http_code}]" "${baseUrl}/" 2>/dev/null`,
      { cwd: projectDir },
    );
    const statusMatch = stdout.match(/\[HTTP_STATUS:(\d+)\]$/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : null;
    const body = stdout.replace(/\[HTTP_STATUS:\d+\]$/, "").trim();
    return { status, body: body.slice(0, 2000), error: null };
  } catch (err) {
    return { status: null, body: "", error: err.message?.slice(0, 200) };
  }
}

/**
 * Check git status for uncommitted changes.
 * Returns { hasChanges: boolean, summary: string }
 */
async function checkGitStatus(projectDir) {
  try {
    const { stdout } = await execAsync(`git status --porcelain`, { cwd: projectDir });
    const lines = stdout.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return { hasChanges: false, summary: "clean" };
    return {
      hasChanges: true,
      summary: `${lines.length} uncommitted change(s): ${lines.slice(0, 3).join(", ")}${lines.length > 3 ? "..." : ""}`,
    };
  } catch {
    return { hasChanges: false, summary: "git unavailable" };
  }
}

/**
 * Check composer/vendor integrity.
 */
async function checkComposer(projectDir) {
  try {
    // Only applicable to projects that declare PHP dependencies
    const { stdout: hasPkg } = await execAsync(`test -f composer.json && echo EXISTS || echo MISSING`, { cwd: projectDir });
    if (hasPkg.includes("MISSING")) return { ok: true, note: "composer check skipped (no composer.json)" };

    // Check vendor/autoload.php exists
    const { stdout: ls } = await execAsync(`test -f vendor/autoload.php && echo EXISTS || echo MISSING`, { cwd: projectDir });
    if (ls.includes("MISSING")) return { ok: false, note: "vendor/autoload.php not found — run composer install" };

    // Quick parse of composer.json
    const { stdout: json } = await execAsync(`php -r "json_decode(file_get_contents('composer.json')); echo json_last_error() === 0 ? 'OK' : 'INVALID';"`, { cwd: projectDir });
    if (json.includes("INVALID")) return { ok: false, note: "composer.json is not valid JSON" };

    return { ok: true, note: "vendor present, composer.json valid" };
  } catch {
    return { ok: true, note: "composer check skipped (not a PHP project)" };
  }
}

/**
 * Check node_modules integrity for Node.js / npm projects.
 * Mirrors the composer check: ensures the package manager artifacts are present.
 */
async function checkNodeModules(projectDir) {
  try {
    const { stdout: hasPkg } = await execAsync(`test -f package.json && echo EXISTS || echo MISSING`, { cwd: projectDir });
    if (hasPkg.includes("MISSING")) return { ok: true, note: "node_modules check skipped (no package.json)" };

    // Confirm node_modules exists and has something in it
    const { stdout: hasNm } = await execAsync(`test -d node_modules && echo EXISTS || echo MISSING`, { cwd: projectDir });
    if (hasNm.includes("MISSING")) return { ok: false, note: "node_modules directory not found — run npm install (or yarn/pnpm install)" };

    // Quick sanity: .bin directory should be present if deps installed correctly
    const { stdout: hasBin } = await execAsync(`test -d node_modules/.bin && echo EXISTS || echo MISSING`, { cwd: projectDir });
    if (hasBin.includes("MISSING")) return { ok: false, note: "node_modules/.bin missing — dependencies may be incomplete, run npm install" };

    return { ok: true, note: "node_modules present" };
  } catch {
    return { ok: true, note: "node_modules check skipped" };
  }
}

/**
 * Check for stale SilverStripe compiled config cache in /tmp.
 */
async function checkSilverStripeCache(projectDir) {
  try {
    const { stdout } = await execAsync(
      `find /tmp -maxdepth 3 \\( -name 'configcache' -o -name 'manifestcache' \\) 2>/dev/null | head -5`,
      { cwd: projectDir },
    );
    const caches = stdout.trim().split("\n").filter(Boolean);
    return { count: caches.length, paths: caches };
  } catch {
    return { count: 0, paths: [] };
  }
}

/**
 * Extract a short PHP error snippet from an HTTP response body.
 * Strips script tags first (avoids NewRelic JS pollution).
 */
function extractPhpError(body) {
  const stripped = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const lines = stripped.split("\n");
  const PHP_ERROR_RE = /(?:Fatal error|Parse error|Warning:|Notice:|Uncaught|Exception|Stack trace|Error in )/i;
  const idx = lines.findIndex((l) => PHP_ERROR_RE.test(l));
  if (idx >= 0) {
    return lines.slice(idx, idx + 6).join("\n").trim().slice(0, 400);
  }
  return null;
}

export async function environmentNode(state) {
  // Only run once per session (not on every subtask advance or coder retry)
  if (state.environmentChecked) {
    return {};
  }

  // Skip for tasks that don't involve a running web server
  if (state.taskType === "documentation" || state.taskType === "investigation" || state.taskType === "direct_fix") {
    return { environmentChecked: true };
  }

  // For non-web projects (Python, Ruby, Go, Swift, Unity, Godot), skip the HTTP probe
  // but still run the git status check — stale uncommitted changes are relevant to all project types.
  const webProjectTypes = new Set(["silverstripe", "php", "laravel", "wordpress", "web", "node", "nodejs", "react", "nextjs", "unknown"]);
  const isWebProject = !state.projectType || webProjectTypes.has(state.projectType);

  if (!isWebProject) {
    // Lightweight git check only — no HTTP probe, no composer/npm checks
    const projectDir = state.projectDir;
    if (!projectDir) return { environmentChecked: true };
    const git = await checkGitStatus(projectDir);
    const gitNote = git.hasChanges
      ? `⚠️ Git has uncommitted changes from a prior session: ${git.summary}\n   If these are stale/broken, run: git reset --hard HEAD`
      : "✓ Git: working tree clean";
    if (git.hasChanges) {
      log(colors.yellow(`  [Environment] Uncommitted changes detected`));
    }
    return {
      environmentReport: `## Environment Baseline\n${gitNote}`,
      environmentHealthy: true,
      preExistingErrors: [],
      environmentChecked: true,
      currentPersona: PERSONA.id,
    };
  }

  log(colors.cyan("  [Graph] -> 🌐 Running Environment Inspector (pre-flight check)..."));
  eventBus.emit("persona_change", {
    ...PERSONA,
    description: "Establishing environment baseline before implementation begins",
  });
  eventBus.emit("phase_change", { phase: PERSONA.phase, label: "Checking environment..." });

  const projectDir = state.projectDir;
  if (!projectDir) return { environmentChecked: true };

  const findings = [];
  const preExistingErrors = [];
  let environmentHealthy = true;

  // ── 1. HTTP baseline probe ────────────────────────────────────────────────
  const { url: baseUrl, source: urlSource } = await discoverBaseUrl(projectDir);
  log(colors.dim(`  [Environment] Base URL: ${baseUrl} (via ${urlSource})`));

  const { status, body, error: httpError } = await probeHttp(baseUrl, projectDir);

  if (httpError) {
    findings.push(`⚠️ HTTP probe failed (${httpError}) — site may not be running`);
    // Not necessarily fatal — site might just not be a web app
  } else if (status === 500) {
    environmentHealthy = false;
    const phpError = extractPhpError(body);
    const errorNote = phpError
      ? `\n   Error: ${phpError}`
      : "\n   (no PHP error text found — may be a permissions or cache issue)";

    const preExistingMsg = `⚠️ SITE IS ALREADY AT HTTP 500 BEFORE ANY CHANGES${errorNote}`;
    preExistingErrors.push(preExistingMsg);
    findings.push(preExistingMsg);
    findings.push(
      `   Fix options:\n` +
      `   1. Permissions:  sudo chown -R www-data:www-data "${projectDir}/public/assets" && sudo chmod -R 775 "${projectDir}/public/assets"\n` +
      `   2. Clear cache:  find /tmp -maxdepth 3 \\( -name 'configcache' -o -name 'manifestcache' \\) -exec rm -rf {} + 2>/dev/null; echo done\n` +
      `   3. Rebuild DB:   vendor/bin/sake db:build --flush`,
    );
    log(colors.red(`  [Environment] ⚠️ Pre-existing HTTP 500 detected at ${baseUrl}`));
  } else if (status === 0) {
    // curl returns HTTP 0 when the TCP connection is refused (ECONNREFUSED).
    // This means the web server process is not running — not an application error.
    environmentHealthy = false;
    const preExistingMsg = `⚠️ WEB SERVER IS NOT RUNNING — HTTP 0 (connection refused) at ${baseUrl}/`;
    preExistingErrors.push(preExistingMsg);
    findings.push(preExistingMsg);
    findings.push(
      `   Fix: start the web server before implementing.\n` +
      `   Apache:  sudo service apache2 start  (or: sudo systemctl start apache2)\n` +
      `   Nginx:   sudo service nginx start\n` +
      `   PHP-FPM: sudo service php8.3-fpm start  (adjust version as needed)\n` +
      `   After starting, verify: curl -s -o /dev/null -w "%{http_code}" "${baseUrl}/"`,
    );
    log(colors.red(`  [Environment] ⚠️ Web server not running (HTTP 0 / connection refused) at ${baseUrl}`));
  } else if (status === 200) {
    findings.push(`✓ HTTP baseline: ${baseUrl} → HTTP 200 (site is healthy)`);
    log(colors.dim(`  [Environment] HTTP baseline: 200 OK`));
  } else if (status === 302 || status === 301) {
    findings.push(`ℹ️ HTTP baseline: ${baseUrl} → HTTP ${status} (redirect — may be login page, auth redirect, or canonical URL change)`);
    log(colors.dim(`  [Environment] HTTP baseline: ${status} redirect`));
  } else if (status !== null) {
    findings.push(`⚠️ HTTP baseline: ${baseUrl} → HTTP ${status} (unexpected status — check web server logs)`);
    log(colors.yellow(`  [Environment] HTTP baseline: unexpected status ${status}`));
  }

  // ── 2. Git status ─────────────────────────────────────────────────────────
  const git = await checkGitStatus(projectDir);
  if (git.hasChanges) {
    findings.push(`⚠️ Git has uncommitted changes from a prior session: ${git.summary}`);
    findings.push(`   If these are stale/broken, run: git reset --hard HEAD`);
    log(colors.yellow(`  [Environment] Uncommitted changes detected`));
  } else {
    findings.push(`✓ Git: working tree clean`);
  }

  // ── 3. Composer integrity ─────────────────────────────────────────────────
  const composer = await checkComposer(projectDir);
  if (!composer.ok) {
    preExistingErrors.push(`⚠️ Composer: ${composer.note}`);
    findings.push(`⚠️ Composer: ${composer.note}`);
    environmentHealthy = false;
    log(colors.yellow(`  [Environment] Composer issue: ${composer.note}`));
  } else {
    findings.push(`✓ Composer: ${composer.note}`);
  }

  // ── 3b. Node.js node_modules integrity ────────────────────────────────────
  const nodeModules = await checkNodeModules(projectDir);
  if (!nodeModules.ok) {
    preExistingErrors.push(`⚠️ npm: ${nodeModules.note}`);
    findings.push(`⚠️ npm: ${nodeModules.note}`);
    environmentHealthy = false;
    log(colors.yellow(`  [Environment] Node.js issue: ${nodeModules.note}`));
  } else if (!nodeModules.note.includes("skipped")) {
    findings.push(`✓ npm: ${nodeModules.note}`);
  }

  // ── 4. SilverStripe cache state ───────────────────────────────────────────
  const cache = await checkSilverStripeCache(projectDir);
  if (cache.count > 0) {
    findings.push(
      `ℹ️ SilverStripe compiled config cache detected in /tmp (${cache.count} dir(s)): ${cache.paths.slice(0, 2).join(", ")}\n` +
      `   This cache is CLEARED automatically when you run db:build --flush.\n` +
      `   If you see stale config errors after writing YAML: execute_bash("find /tmp -maxdepth 3 -name 'configcache' -exec rm -rf {} + 2>/dev/null; echo done")`,
    );
    log(colors.dim(`  [Environment] SS cache: ${cache.count} dir(s) in /tmp`));
  }

  const environmentReport = [
    `## Environment Baseline (checked before first implementation turn)`,
    `Base URL: ${baseUrl} (discovered via ${urlSource})`,
    ``,
    findings.join("\n"),
  ].join("\n");

  log(
    environmentHealthy
      ? colors.cyan(`  [Environment] ✓ Environment healthy — safe to proceed`)
      : colors.red(`  [Environment] ⚠️ Environment issues detected — see environment report`),
  );

  if (!environmentHealthy) {
    eventBus.emit("system_message", {
      text: `⚠️ Environment issues detected before implementation: ${preExistingErrors[0]?.slice(0, 80) || "see report"}`,
      type: "warning",
    });
  } else {
    eventBus.emit("system_message", {
      text: `🌐 Environment pre-flight: ${baseUrl} → HTTP ${status ?? "unknown"} — baseline established`,
      type: "info",
    });
  }

  return {
    environmentReport,
    environmentHealthy,
    preExistingErrors,
    environmentChecked: true,
    currentPersona: PERSONA.id,
  };
}
