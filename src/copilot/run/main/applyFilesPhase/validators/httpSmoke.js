/**
 * HTTP smoke test — fetches the project's real base URL after template / PHP /
 * config changes to catch PHP warnings and errors that wouldn't show up as a
 * 500 status code.
 *
 * PHP warnings and deprecated notices produce HTTP 200 but inject visible
 * warning text into the HTML. This test captures that category of failure
 * which the static syntax checker cannot detect.
 *
 * The base URL is discovered via resolveProjectUrl rather than hardcoded to
 * localhost.  The result is cached in memory so repeated calls within the same
 * process only probe the environment once.
 */

import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { resolveProjectUrl, clearResolvedUrlCache } from "./resolveProjectUrl.js";
import { captureWebScreenshot } from "./captureWebScreenshot.js";
import { eventBus } from "#web/eventBus.js";
import { isSilverStripeProject } from "#utils/detectProjectContext.js";

const WEB_EXTENSIONS = new Set([".ss", ".php", ".yml", ".yaml"]);

// SilverStripe YAML/config extensions — these are the highest-risk changes because
// a single bad class reference prevents SS from bootstrapping entirely.
const SS_CONFIG_EXTENSIONS = new Set([".yml", ".yaml"]);

// These patterns in the response body indicate a PHP problem even on HTTP 200.
// Covers:
//   • PHP engine errors (Fatal, Parse, Warning, Notice, Deprecated)
//   • Uncaught exceptions — including multi-word names like "InvalidArgumentException"
//     preceded by SS dev-mode severity prefix e.g. "[Emergency] Uncaught ..."
//   • Stack trace markers
//   • SilverStripe "references nonexistent" class/extension error
const PHP_BODY_ERROR_RE =
  /(?:PHP\s+(?:Fatal|Parse|Warning|Notice|Deprecated)\s+error:|Uncaught\s+[\w\\]+Exception|Stack trace:|in\s+\/[^\s]+\.php\s+on\s+line\s+\d+|references\s+nonexistent)/i;

// The SilverStripe "yellow screen of death", Laravel Ignition, or other framework error pages.
// Covers:
//   • SS dev mode DebugView — severity-prefixed <h1> e.g. "[Emergency] Uncaught ..."
//   • SS friendly formatter — <h1>Website Error</h1> rendered in live mode
//   • Laravel Whoops / Ignition
//   • Generic "Application Error" / "Website Error" titles
const FRAMEWORK_ERROR_PAGE_RE =
  /SilverStripe\\Dev\\DebugView|Whoops\\|Ignition error page|Application Error|Website Error|\[(?:Emergency|Critical|Alert|Error)\]\s+Uncaught/i;

// Web-server default/placeholder pages — the server is alive but the application
// is NOT responding. A 200 from these pages is a false positive.
// Matched by <title> context to avoid spurious hits on page content.
const SERVER_DEFAULT_PAGE_RE =
  /<title>[^<]*Apache2 Ubuntu Default Page|<title>[^<]*Apache HTTP Server Test Page|<title>\s*Welcome to nginx|<h1>\s*It works!?\s*<\/h1>|<title>[^<]*IIS Windows Server|<title>[^<]*Microsoft Internet Information Services/i;

// resolveProjectUrl has its own module-level cache; just delegate directly.
// The resolved result may include a `curlResolve` field (e.g. "thescopes.local:80:127.0.0.1")
// that callers must pass to curl via --resolve when fetching the URL.
async function getBaseUrl(projectDir) {
  return resolveProjectUrl(projectDir);
}

/**
 * Clears the SilverStripe compiled manifest/config cache.
 *
 * When a bad YAML config is written (e.g. referencing a non-existent class),
 * the HTTP smoke test hits the site with ?flush=1, which triggers SilverStripe
 * to compile and cache a broken manifest. The git rollback then reverts the YAML
 * file, but the cache on disk still contains the poisoned reference — so all
 * subsequent bootstrap attempts fail even though the file is now clean.
 *
 * Clearing the cache here (before returning errors) ensures the next write
 * attempt starts with a fresh manifest rather than a stale poisoned one.
 */
async function clearSilverStripeCache(projectDir) {
  // SS6 compiled config/manifest cache lives in /tmp/silverstripe-cache-{encoded-path}/
  // NOT in the project directory. Clear both configcache and manifestcache subdirectories.
  try {
    await execAsync(
      `find /tmp -maxdepth 3 \\( -name 'configcache' -o -name 'manifestcache' \\) -exec rm -rf {} + 2>/dev/null; echo done`,
      { cwd: projectDir },
    );
    log(colors.yellow(
      `  [HTTP Smoke] Cleared SS compiled config cache from /tmp (prevents cache-poison after rollback)`,
    ));
  } catch {
    // Best effort — silently ignore failures
  }
}

function isWebChange(modifiedFilesAbs) {
  if (!modifiedFilesAbs?.length) return false;
  return modifiedFilesAbs.some((f) => {
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    return WEB_EXTENSIONS.has(ext);
  });
}

/**
 * Returns true if any modified file is a SilverStripe YAML/config file.
 * These are the highest-risk changes — a bad class reference in _config/*.yml
 * prevents the entire framework from bootstrapping.
 */
function hasSSConfigChange(modifiedFilesAbs) {
  if (!modifiedFilesAbs?.length) return false;
  return modifiedFilesAbs.some((f) => {
    const ext = f.slice(f.lastIndexOf(".")).toLowerCase();
    return SS_CONFIG_EXTENSIONS.has(ext);
  });
}

export async function checkHttpSmoke(projectDir, modifiedFilesAbs) {
  if (!isWebChange(modifiedFilesAbs)) return [];

  const { url: baseUrl, source, verified, curlResolve } = await getBaseUrl(projectDir);

  if (!verified) {
    log(
      colors.dim(
        `  [HTTP Smoke] No reachable server found (tried .env, vhosts, hostname) — skipping smoke test`,
      ),
    );
    return [];
  }

  // Detect framework once — cheap filesystem check, result used for supplemental
  // validation rules below.
  const isSS = isSilverStripeProject(projectDir);

  // SilverStripe: append ?flush=1 to clear the manifest cache.
  // Other frameworks: a plain GET of the root is sufficient.
  const testUrl = `${baseUrl}/?flush=1`;

  // When the URL was resolved via --resolve (e.g. *.local on WSL2), we must
  // pass the same flag to every subsequent curl call so we hit the right vhost.
  const resolveArg = curlResolve ? `--resolve "${curlResolve}"` : "";

  const errors = [];
  let statusCode = null;
  let body = "";

  // Baseline probe — check if the site was already broken BEFORE this write.
  // Use a plain GET (no ?flush=1) with a short timeout so we don't trigger
  // manifest compilation. If the baseline is already HTTP 500 the error is
  // pre-existing and unrelated to the current file change.
  let isPreExisting500 = false;
  try {
    const { stdout: baselineOut } = await execAsync(
      `curl -s -L --max-time 5 ${resolveArg} -w "\\n[HTTP_STATUS:%{http_code}]" "${baseUrl}/"`,
      { cwd: projectDir },
    );
    const baselineMatch = baselineOut.match(/\[HTTP_STATUS:(\d+)\]$/);
    const baselineStatus = baselineMatch ? parseInt(baselineMatch[1], 10) : null;
    if (baselineStatus === 500) {
      isPreExisting500 = true;
      log(colors.yellow(
        `  [HTTP Smoke] Pre-existing HTTP 500 at ${baseUrl}/ — site was already broken before this write`,
      ));
    }
  } catch {
    // Probe failed — proceed without baseline info
  }

  try {
    // -s = silent, -L = follow redirects, --max-time 15 = don't hang
    const { stdout } = await execAsync(
      `curl -s -L --max-time 15 ${resolveArg} -w "\\n[HTTP_STATUS:%{http_code}]" "${testUrl}"`,
      { cwd: projectDir },
    );

    const statusMatch = stdout.match(/\[HTTP_STATUS:(\d+)\]$/);
    statusCode = statusMatch ? parseInt(statusMatch[1], 10) : null;
    body = stdout.replace(/\[HTTP_STATUS:\d+\]$/, "").trim();
  } catch (err) {
    // curl exit code 6 (DNS) or 7 (connection refused) — environment issue.
    const msg = err.message || String(err);
    if (/exit code[:\s]*[67]|Could not resolve|Connection refused/i.test(msg)) {
      log(
        colors.dim(
          `  [HTTP Smoke] ${baseUrl} not reachable — skipping (environment issue)`,
        ),
      );
      // Invalidate the resolveProjectUrl cache so next subtask re-probes.
      clearResolvedUrlCache();
      return [];
    }
    log(
      colors.yellow(`  [HTTP Smoke] curl failed unexpectedly: ${msg.slice(0, 120)}`),
    );
    return [];
  }

  if (statusCode === null) {
    log(colors.dim("  [HTTP Smoke] Could not determine HTTP status — skipping smoke test"));
    return [];
  }

  log(
    colors.dim(
      `  [HTTP Smoke] ${testUrl} → HTTP ${statusCode} (via ${source})`,
    ),
  );

  // Capture a browser screenshot and stream it to the feed so the user can
  // see what the page actually looks like at the moment of the smoke test.
  captureWebScreenshot(testUrl).then((shot) => {
    if (!shot) return;
    eventBus.emit("smoke_screenshot", {
      url: testUrl,
      statusCode,
      screenshotBase64: shot.screenshotBase64,
      savedPath: shot.savedPath,
      timestamp: new Date().toISOString(),
    });
    if (shot.savedPath) {
      log(colors.dim(`  [HTTP Smoke] Screenshot saved → ${shot.savedPath}`));
    }
  }).catch(() => {});

  if (statusCode === 500) {
    // For SilverStripe YAML/config changes: clear the compiled manifest cache before
    // returning. The curl request just triggered SS to write a poisoned manifest cache
    // (with the bad class reference). The git rollback that follows will revert the YAML
    // file but NOT the on-disk cache — causing all subsequent bootstrap attempts to fail
    // even after the file is corrected. Clearing now gives the next attempt a clean slate.
    if (isSS && hasSSConfigChange(modifiedFilesAbs)) {
      await clearSilverStripeCache(projectDir);
    }
    const snippet = extractErrorSnippet(body);
    const preExistingNote = isPreExisting500
      ? `\n\n⚠️ PRE-EXISTING ERROR: The site was already at HTTP 500 before this write (baseline probe of ${baseUrl}/ confirmed). This error is NOT caused by the current file change — it is an environment problem from an earlier subtask. Fix the environment (run db:build, fix permissions on public/assets, etc.) rather than rolling back this file.`
      : "";
    errors.push(
      `HTTP smoke test FAILED — server returned HTTP 500 after flush.${preExistingNote}\n\nURL: ${testUrl}\n\nError snippet:\n${snippet}\n\nFix the PHP error before this subtask can pass.`,
    );
    return errors;
  }

  if (statusCode >= 200 && statusCode < 400) {
    // Check for web-server default/placeholder page FIRST — this is a stronger
    // signal than PHP errors: the application did not respond at all.
    if (SERVER_DEFAULT_PAGE_RE.test(body)) {
      errors.push(
        `HTTP smoke test FAILED — the web server returned its default placeholder page instead of the application.\n\nURL: ${testUrl}\n\nThis means the web server is running but the application is not bootstrapping. Likely causes:\n  - A framework build command (sake db:build, artisan migrate, etc.) failed earlier in this turn\n  - YAML/config syntax error preventing the framework from loading\n  - Virtual host not configured for this project directory\n\nFix the underlying build/config error before re-testing.`,
      );
    } else if (PHP_BODY_ERROR_RE.test(body) || FRAMEWORK_ERROR_PAGE_RE.test(body)) {
      const snippet = extractErrorSnippet(body);
      // For SS config changes: clear cache on error body too (SS may return HTTP 200
      // in friendly-error mode while still writing a poisoned manifest to disk).
      if (isSS && hasSSConfigChange(modifiedFilesAbs)) {
        await clearSilverStripeCache(projectDir);
      }
      errors.push(
        `HTTP smoke test FAILED — page returned HTTP ${statusCode} but the response body contains PHP errors or warnings.\n\nURL: ${testUrl}\n\nError snippet:\n${snippet}\n\nFix the PHP issue before this subtask can pass.`,
      );
    } else if (isSS && hasSSConfigChange(modifiedFilesAbs)) {
      // Framework-aware structural check: for SilverStripe YAML/config changes, the
      // response must look like a real SS-rendered page.  An empty body or response
      // shorter than ~200 chars indicates the framework silently failed to bootstrap.
      // Real SS pages always emit at minimum: doctype, <html>, <head>, <body>, </html>.
      const looksLikePage = body.length > 200 && /<\/html>/i.test(body);
      if (!looksLikePage) {
        errors.push(
          `HTTP smoke test FAILED — SilverStripe returned an unexpectedly short or incomplete response (${body.length} bytes) after a YAML/config change.\n\nURL: ${testUrl}\n\nThis indicates the framework is not bootstrapping correctly. The YAML config change likely has a syntax error or references a nonexistent class.\n\nRun vendor/bin/sake db:build --flush to see the underlying error, then fix the config file.`,
        );
      } else {
        log(colors.dim(`  [HTTP Smoke] SilverStripe structural check passed (${body.length} bytes, has </html>)`));
      }
    }
  }

  return errors;
}

function extractErrorSnippet(body, maxLen = 600) {
  if (!body) return "(no response body)";
  // Strip <script>...</script> blocks first — analytics/telemetry JS (e.g. NewRelic)
  // is often injected near the top of every page and will pollute the snippet
  // when no PHP error marker is found in the body.
  const stripped = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const lines = stripped.split("\n");
  const startIdx = lines.findIndex(
    (l) => PHP_BODY_ERROR_RE.test(l) || FRAMEWORK_ERROR_PAGE_RE.test(l),
  );
  const relevant =
    startIdx >= 0
      ? lines.slice(Math.max(0, startIdx - 1), startIdx + 10).join("\n")
      : lines.filter((l) => l.trim().length > 0).slice(0, 10).join("\n");
  return relevant.length > maxLen
    ? relevant.slice(0, maxLen) + "\n...[truncated]"
    : relevant;
}
