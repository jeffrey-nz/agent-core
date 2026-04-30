import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { logPhase } from "#app/ui/phases.js";

export async function runSmokeTests(urls, options = {}) {
  const { timeoutMs = 15000, label = "" } = options;

  if (!urls || urls.length === 0) return { results: [], hasFailed: false };

  logPhase("SMOKE TEST", label, `Checking ${urls.length} route(s)`);

  const results = [];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
      });
      clearTimeout(timer);

      if (res.status >= 500) {
        const body = await res.text().catch(() => "");
        const errorDetail = extractErrorDetail(body);
        results.push({
          url,
          status: res.status,
          ok: false,
          error: errorDetail || `HTTP ${res.status}`,
        });
        log(
          colors.red(
            `  [Smoke] ✖ ${url} → HTTP ${res.status}${errorDetail ? ": " + errorDetail.slice(0, 120) : ""}`,
          ),
        );
      } else {
        results.push({ url, status: res.status, ok: true });
        log(colors.green(`  [Smoke] ✓ ${url} → HTTP ${res.status}`));
      }
    } catch (err) {
      clearTimeout(timer);
      const errMsg =
        err.name === "AbortError" ? "Request timed out" : err.message;
      results.push({ url, ok: false, error: errMsg, connectionError: true });
      log(colors.yellow(`  [Smoke] ⚠ ${url} → ${errMsg}`));
    }
  }

  const hasFailed = results.some((r) => !r.ok);
  return { results, hasFailed };
}

export function formatSmokeFailures(results) {
  return results
    .filter((r) => !r.ok)
    .map(
      (r) =>
        `  - ${r.url}${r.status ? ` (HTTP ${r.status})` : ""}: ${r.error || "Unknown error"}`,
    )
    .join("\n");
}

function extractErrorDetail(html) {
  const ssMatch = html.match(/class="info-header"[^>]*>\s*<h1[^>]*>([^<]+)/);
  if (ssMatch) return ssMatch[1].trim();

  const phpMatch = html.match(/(?:Fatal error|Parse error|Warning):[^<\n]+/);
  if (phpMatch) return phpMatch[0].trim().slice(0, 200);

  const h1Match = html.match(/<h1[^>]*>([^<]{5,200})/);
  if (h1Match) return h1Match[1].trim();

  return null;
}
