/**
 * resolveProjectUrl — ranked-evidence URL discovery for smoke testing.
 *
 * Instead of assuming `localhost`, this module builds a prioritised list of
 * URL candidates from the best available evidence and verifies each one with
 * a live HTTP request before returning it.  The first reachable URL wins.
 *
 * Evidence chain (highest → lowest confidence):
 *   1. Project .env file  — SS_BASE_URL, APP_URL, BASE_URL, SITE_URL, HTTP_HOST
 *   2. Project .env.example — same keys, weaker signal
 *   3. Apache vhosts      — ServerName/ServerAlias whose DocumentRoot covers projectDir
 *   4. Nginx server blocks — server_name whose root covers projectDir
 *   5. System FQDN        — `hostname -f`
 *   6. localhost          — unconditional fallback
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

// ─── Environment-file parsing ────────────────────────────────────────────────

/**
 * Ordered list of .env keys that may hold the project's base URL.
 * Keys earlier in the list take precedence over later ones.
 */
const ENV_URL_KEYS = [
  "SS_BASE_URL",
  "APP_URL",
  "BASE_URL",
  "SITE_URL",
  "HTTP_HOST",
  "WEB_ROOT",
  "APP_DOMAIN",
];

async function parseEnvFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const urls = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;

    const key = trimmed.slice(0, eqIdx).trim().toUpperCase();
    if (!ENV_URL_KEYS.includes(key)) continue;

    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    value = value.replace(/^["']|["']$/g, "");
    if (!value) continue;

    // Normalise: if the value looks like a bare hostname (no scheme), add http://
    const url = normaliseUrl(value);
    if (url) urls.push(url);
  }

  return urls;
}

// ─── Apache vhost parsing ────────────────────────────────────────────────────

const APACHE_DIRS = [
  "/etc/apache2/sites-enabled",
  "/etc/apache2/sites-available",
  "/etc/httpd/conf.d",
  "/etc/httpd/vhosts.d",
];

async function parseApacheVhosts(projectDir) {
  const urls = [];
  const realProject = path.resolve(projectDir);

  for (const dir of APACHE_DIRS) {
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!/\.(conf|vhost)$|^[^.]+$/.test(file)) continue;
      const filePath = path.join(dir, file);
      let text;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      // Split into <VirtualHost> blocks and check each one
      const vhostBlocks = text.split(/<\/?VirtualHost[^>]*>/i).filter(Boolean);
      for (let i = 0; i < vhostBlocks.length; i += 1) {
        const block = vhostBlocks[i];

        // Check if the DocumentRoot is related to our project.
        // We match in both directions because:
        //   • Legacy layout: DocumentRoot === projectDir (e.g. /var/www/thescopes)
        //   • Modern layout:  DocumentRoot is a subdir of projectDir
        //     (e.g. /var/www/thescopes/public for SilverStripe 4+)
        //   • Monorepo:       projectDir is a subdir of DocumentRoot
        const docRootMatch = block.match(/^\s*DocumentRoot\s+"?([^"\s]+)/im);
        if (!docRootMatch) continue;
        const docRoot = path.resolve(docRootMatch[1]);
        const docRootWithSep = docRoot.endsWith(path.sep) ? docRoot : docRoot + path.sep;
        const realProjectWithSep = realProject.endsWith(path.sep) ? realProject : realProject + path.sep;
        const related =
          docRoot === realProject ||
          realProject.startsWith(docRootWithSep) ||   // project inside docRoot (legacy/monorepo)
          docRoot.startsWith(realProjectWithSep);      // docRoot inside project (modern public/ layout)
        if (!related) continue;

        // Extract ServerName and ServerAlias
        const serverNameMatch = block.match(/^\s*ServerName\s+(\S+)/im);
        const aliasMatches = [...block.matchAll(/^\s*ServerAlias\s+(\S+)/gim)];

        const scheme = /^\s*SSLEngine\s+on/im.test(block) ? "https" : "http";
        const port = extractPort(block, scheme);
        const suffix = port ? `:${port}` : "";

        if (serverNameMatch) {
          urls.push(normaliseUrl(`${scheme}://${serverNameMatch[1]}${suffix}`));
        }
        for (const m of aliasMatches) {
          urls.push(normaliseUrl(`${scheme}://${m[1]}${suffix}`));
        }
      }
    }
  }

  return urls.filter(Boolean);
}

function extractPort(block, scheme) {
  // Look for Listen or VirtualHost *:PORT
  const portMatch = block.match(/\*:(\d+)/);
  if (!portMatch) return null;
  const port = parseInt(portMatch[1], 10);
  // Only include non-standard ports
  if ((scheme === "https" && port === 443) || (scheme === "http" && port === 80)) return null;
  return port;
}

// ─── Nginx config parsing ────────────────────────────────────────────────────

const NGINX_DIRS = [
  "/etc/nginx/sites-enabled",
  "/etc/nginx/sites-available",
  "/etc/nginx/conf.d",
];

async function parseNginxConfig(projectDir) {
  const urls = [];
  const realProject = path.resolve(projectDir);

  for (const dir of NGINX_DIRS) {
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      let text;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      // Rough block extraction — find server { } sections.
      // Match in both directions (root inside project for modern public/ layout,
      // or project inside root for legacy / monorepo setups).
      const rootMatches = [...text.matchAll(/^\s*root\s+([^;]+);/gim)];
      const blockRoots = rootMatches.map((m) => path.resolve(m[1].trim()));
      const matchesProject = blockRoots.some((r) => {
        const rWithSep = r.endsWith(path.sep) ? r : r + path.sep;
        const pWithSep = realProject.endsWith(path.sep) ? realProject : realProject + path.sep;
        return r === realProject || realProject.startsWith(rWithSep) || r.startsWith(pWithSep);
      });
      if (!matchesProject) continue;

      const serverNameMatches = [...text.matchAll(/^\s*server_name\s+([^;]+);/gim)];
      const scheme = /ssl\s+on|listen\s+443\s+ssl/i.test(text) ? "https" : "http";

      for (const m of serverNameMatches) {
        const names = m[1].trim().split(/\s+/);
        for (const name of names) {
          if (name === "_" || name === "localhost") continue;
          urls.push(normaliseUrl(`${scheme}://${name}`));
        }
      }
    }
  }

  return urls.filter(Boolean);
}

// ─── System hostname ─────────────────────────────────────────────────────────

async function getSystemHostname() {
  try {
    const { stdout } = await execAsync("hostname -f", { timeout: 3000 });
    const h = stdout.trim();
    if (h && h !== "localhost" && !h.startsWith("localhost.")) return h;
  } catch {
    /* not fatal */
  }
  return null;
}

// ─── URL normalisation ────────────────────────────────────────────────────────

function normaliseUrl(raw) {
  if (!raw) return null;
  let s = raw.trim().replace(/\/+$/, ""); // strip trailing slashes
  // If it looks like a bare hostname (no scheme), add http://
  if (!/^https?:\/\//i.test(s)) {
    // If it contains a dot or colon it's likely a hostname/port, not a path
    if (/[.:]/.test(s) || /^[a-zA-Z0-9-]+$/.test(s)) {
      s = `http://${s}`;
    } else {
      return null;
    }
  }
  try {
    // Validate with URL constructor
    new URL(s);
    return s;
  } catch {
    return null;
  }
}

// ─── Reachability check ───────────────────────────────────────────────────────

/**
 * Returns true if the URL responds with any HTTP status (even 4xx/5xx — the
 * point is just that a server is listening, not that the page is correct).
 *
 * Uses curl rather than Node's fetch() because:
 *   • .local mDNS domains don't resolve in Node.js on WSL2 but do via curl
 *   • curl uses the system's full resolver/nsswitch stack (consistent with the
 *     actual smoke test)
 *   • fetch() silently treats all network errors as unreachable, masking the
 *     difference between DNS failure and connection refused
 */
async function isReachable(url) {
  try {
    // -s = silent  -o /dev/null = discard body  -L = follow redirects
    // --max-time 5 = bail after 5 s  -w = write status code to stdout
    const { stdout } = await execAsync(
      `curl -s -o /dev/null -L --max-time 5 -w "%{http_code}" "${url}"`,
      { timeout: 6000 },
    );
    const code = parseInt(stdout.trim(), 10);
    return code > 0;
  } catch {
    return false;
  }
}

/**
 * Returns true if the URL is reachable when its hostname is forcibly resolved
 * to 127.0.0.1 via curl --resolve.
 *
 * This is specifically needed for WSL2 environments where .local mDNS domains
 * do not resolve via the system resolver but Apache/nginx IS running locally
 * with a matching virtual host.  Using --resolve bypasses DNS entirely and
 * sends the request to localhost while preserving the correct Host header so
 * the right vhost is selected.
 */
async function isReachableViaLocalhost(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const resolveFlag = `${parsed.hostname}:${port}:127.0.0.1`;
    const { stdout } = await execAsync(
      `curl -s -o /dev/null -L --max-time 5 --resolve "${resolveFlag}" -w "%{http_code}" "${url}"`,
      { timeout: 6000 },
    );
    const code = parseInt(stdout.trim(), 10);
    return code > 0 ? resolveFlag : null;
  } catch {
    return null;
  }
}

/**
 * Returns true for development-only TLDs that typically don't resolve via
 * public DNS but are commonly used as local virtual host names.
 * These are candidates for the localhost-resolve fallback.
 */
function isDevDomain(hostname) {
  return /\.(local|test|dev|localhost|internal|lan|home\.arpa)$/i.test(hostname);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Module-level cache — result is stable within a process lifetime. */
const _cache = new Map();

/** Clear the cache (call at session start to force re-resolution). */
export function clearResolvedUrlCache() { _cache.clear(); }

/**
 * @typedef {{ url: string, source: string, verified: boolean, curlResolve?: string }} ResolvedUrl
 *
 * curlResolve — when set, callers MUST pass `--resolve "<curlResolve>"` to curl
 * when making HTTP requests to `url`.  Present when the URL was only reachable
 * via localhost --resolve (e.g. *.local on WSL2 where mDNS is unavailable).
 *
 * @param {string} projectDir  Absolute path to the project root.
 * @returns {Promise<ResolvedUrl>}
 */
export async function resolveProjectUrl(projectDir) {
  const key = path.resolve(projectDir);
  if (_cache.has(key)) return _cache.get(key);
  const candidates = [];

  // 1. .env (primary)
  for (const url of await parseEnvFile(path.join(projectDir, ".env"))) {
    candidates.push({ url, source: ".env" });
  }

  // 2. .env.example (weaker signal — only queue if .env found nothing so far)
  if (candidates.length === 0) {
    for (const url of await parseEnvFile(path.join(projectDir, ".env.example"))) {
      candidates.push({ url, source: ".env.example" });
    }
  }

  // 3. Apache vhosts
  for (const url of await parseApacheVhosts(projectDir)) {
    candidates.push({ url, source: "apache vhost" });
  }

  // 4. Nginx config
  for (const url of await parseNginxConfig(projectDir)) {
    candidates.push({ url, source: "nginx config" });
  }

  // 5. System hostname
  const hostname = await getSystemHostname();
  if (hostname) {
    candidates.push({ url: `http://${hostname}`, source: "system hostname" });
  }

  // 6. Unconditional fallback
  candidates.push({ url: "http://localhost", source: "fallback" });

  // Deduplicate while preserving order
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const key = c.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Walk the list and return the first reachable URL.
  // For dev-only TLDs (*.local, *.test, etc.) that fail normal DNS resolution,
  // also try forcing curl to resolve the hostname to 127.0.0.1 via --resolve.
  // This handles WSL2 environments where mDNS is not available but Apache/nginx
  // IS running locally with the matching virtual host configured.
  for (const candidate of unique) {
    const ok = await isReachable(candidate.url);
    if (ok) {
      log(colors.dim(`  [HTTP Smoke] URL resolved via ${candidate.source}: ${candidate.url}`));
      const result = { url: candidate.url, source: candidate.source, verified: true };
      _cache.set(key, result);
      return result;
    }

    // Try localhost --resolve for dev domains that fail mDNS (e.g. WSL2)
    let curlResolve = null;
    try {
      const parsed = new URL(candidate.url);
      if (isDevDomain(parsed.hostname)) {
        curlResolve = await isReachableViaLocalhost(candidate.url);
      }
    } catch { /* invalid URL — skip */ }

    if (curlResolve) {
      log(colors.dim(
        `  [HTTP Smoke] URL resolved via ${candidate.source} (localhost --resolve): ${candidate.url}`,
      ));
      const result = { url: candidate.url, source: `${candidate.source} (localhost)`, verified: true, curlResolve };
      _cache.set(key, result);
      return result;
    }

    log(colors.dim(`  [HTTP Smoke] Not reachable (${candidate.source}): ${candidate.url} — trying next...`));
  }

  // Nothing reachable — return localhost anyway and let the caller decide
  log(colors.yellow(`  [HTTP Smoke] No reachable URL found — defaulting to localhost (unreachable)`));
  const fallback = { url: "http://localhost", source: "fallback (unreachable)", verified: false };
  _cache.set(key, fallback);
  return fallback;
}
