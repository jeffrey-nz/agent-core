/**
 * browser.js — executor for browser/dev-server agent tools.
 *
 * Delegates to the browser-ai-bridge sidecar (/api/screenshot, /api/page-inspect,
 * /api/devserver) so the agent can visually verify web apps, check DOM state,
 * and start/stop dev servers without desktop automation.
 *
 * Tool results that include a screenshot set `result._image` — sdkRegistry reads
 * this field and returns a multi-part content array (text + image) so the model
 * can literally see the screenshot.
 */

import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import { getBaseUrl } from "#providers/api/config.js";

const SCREENSHOT_TIMEOUT_MS = 25_000;
const DEVSERVER_TIMEOUT_MS  = 75_000; // bridge waits up to 45s internally

// ── Helpers ────────────────────────────────────────────────────────────────

function apiBase() {
  return getBaseUrl() ?? "http://localhost:3333";
}

async function saveScreenshot(base64, label = "agent") {
  try {
    const dir = path.resolve(process.cwd(), "screenshots");
    await fs.mkdir(dir, { recursive: true });
    const ts  = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(dir, `${ts}-${label}.png`);
    await fs.writeFile(out, Buffer.from(base64, "base64"));
    return out;
  } catch {
    return null;
  }
}

// ── Tool: screenshot_url ───────────────────────────────────────────────────

async function screenshotUrl({ url, width = 1280, height = 900, full_page = false, delay_ms = 0 }) {
  const base = apiBase();
  const params = new URLSearchParams({
    url,
    width:    String(width),
    height:   String(height),
    fullPage: String(full_page),
    ...(delay_ms > 0 ? { delay: String(delay_ms) } : {}),
  });

  let data;
  try {
    const resp = await fetch(`${base}/api/screenshot?${params}`, {
      signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, text: `[screenshot_url] Bridge returned HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    data = await resp.json();
  } catch (err) {
    return {
      ok: false,
      text: `[screenshot_url] Bridge unreachable: ${err.message?.slice(0, 120)}\n` +
            `Is the browser-ai-bridge running? Try: start_dev_server first, then screenshot_url.`,
    };
  }

  const { screenshotBase64 } = data;
  if (!screenshotBase64) {
    return { ok: false, text: `[screenshot_url] Bridge responded but returned no screenshot data.` };
  }

  const savedPath = await saveScreenshot(screenshotBase64, "agent");
  const summary   = [
    `Screenshot of ${url}`,
    `Viewport: ${width}×${height}px${full_page ? " (full page)" : ""}`,
    savedPath ? `Saved to: ${savedPath}` : null,
  ].filter(Boolean).join("\n");

  return {
    ok:     true,
    text:   summary,
    _image: { base64: screenshotBase64, mimeType: "image/png" },
  };
}

// ── Tool: inspect_page ─────────────────────────────────────────────────────

async function inspectPage({ url }) {
  const base = apiBase();

  let data;
  try {
    const resp = await fetch(
      `${base}/api/page-inspect?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, text: `[inspect_page] Bridge returned HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    data = await resp.json();
  } catch (err) {
    return { ok: false, text: `[inspect_page] Bridge unreachable: ${err.message?.slice(0, 120)}` };
  }

  // Normalise varying field shapes from the bridge
  const reactMounted   = data.reactMounted   ?? data.mounted   ?? null;
  const consoleErrors  = data.consoleErrors  ?? data.errors    ?? [];
  const errorOverlay   = data.errorOverlay   ?? data.error     ?? null;
  const title          = data.title          ?? "";
  const domSnippet     = data.domSnippet     ?? data.html      ?? "";
  const importErrors   = data.importErrors   ?? [];

  const lines = [
    `<page_inspect url="${url}">`,
    `  title         : ${title || "(none)"}`,
    `  react_mounted : ${reactMounted === null ? "unknown" : reactMounted ? "YES ✅" : "NO ❌"}`,
    `  error_overlay : ${errorOverlay ? "YES ❌ — " + String(errorOverlay).slice(0, 200) : "none ✅"}`,
  ];

  if (importErrors.length > 0) {
    lines.push(`  import_errors :`);
    importErrors.slice(0, 5).forEach(e => lines.push(`    - ${String(e).slice(0, 200)}`));
  }

  if (consoleErrors.length > 0) {
    lines.push(`  console_errors:`);
    consoleErrors.slice(0, 10).forEach(e => lines.push(`    - ${String(e).slice(0, 200)}`));
  } else {
    lines.push(`  console_errors: none ✅`);
  }

  if (domSnippet) {
    const snippet = String(domSnippet).slice(0, 600);
    lines.push(`  dom_snippet   :\n${snippet}`);
  }

  lines.push(`</page_inspect>`);

  return { ok: true, text: lines.join("\n") };
}

// ── Tool: start_dev_server ─────────────────────────────────────────────────

async function startDevServer({ project_dir, command = "npm run dev", port = 5173 }, context) {
  const projectDir = project_dir ?? context?.rootDir ?? process.cwd();
  const base = apiBase();

  // Verify the project has a package.json with a dev script
  try {
    const pkgRaw = await fs.readFile(path.join(projectDir, "package.json"), "utf8");
    const pkg    = JSON.parse(pkgRaw);
    const scriptKey = command.replace(/^npm\s+run\s+/, "").split(" ")[0];
    if (!pkg?.scripts?.[scriptKey]) {
      return {
        ok:   false,
        text: `[start_dev_server] package.json has no "${scriptKey}" script in ${projectDir}.\n` +
              `Available scripts: ${Object.keys(pkg?.scripts ?? {}).join(", ") || "(none)"}`,
      };
    }
  } catch (err) {
    return {
      ok:   false,
      text: `[start_dev_server] Could not read package.json in ${projectDir}: ${err.message}`,
    };
  }

  let data;
  try {
    const resp = await fetch(`${base}/api/devserver`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ projectDir, command, port }),
      signal:  AbortSignal.timeout(DEVSERVER_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, text: `[start_dev_server] Bridge returned HTTP ${resp.status}: ${body.slice(0, 300)}` };
    }
    data = await resp.json();
  } catch (err) {
    return {
      ok:   false,
      text: `[start_dev_server] Bridge unreachable or timed out: ${err.message?.slice(0, 120)}\n` +
            `Ensure the browser-ai-bridge service is running.`,
    };
  }

  const { pid, url, ready } = data;
  if (!url) {
    return { ok: false, text: `[start_dev_server] Bridge response missing URL: ${JSON.stringify(data).slice(0, 200)}` };
  }

  return {
    ok:   true,
    text: [
      `Dev server started ✅`,
      `  URL : ${url}`,
      `  PID : ${pid}`,
      `  Ready: ${ready ? "yes" : "waiting"}`,
      ``,
      `Next steps:`,
      `  screenshot_url("${url}")   — see what the app looks like`,
      `  inspect_page("${url}")     — check React mount status and console errors`,
      `  stop_dev_server(${pid})    — clean up when done`,
    ].join("\n"),
  };
}

// ── Tool: stop_dev_server ──────────────────────────────────────────────────

async function stopDevServer({ pid }) {
  const base = apiBase();
  try {
    await fetch(`${base}/api/devserver/${pid}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort — bridge auto-cleans on exit
  }
  return { ok: true, text: `Dev server (pid ${pid}) stopped.` };
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

export async function executeBrowserTool(name, input, context) {
  switch (name) {
    case "screenshot_url":    return screenshotUrl(input);
    case "inspect_page":      return inspectPage(input);
    case "start_dev_server":  return startDevServer(input, context);
    case "stop_dev_server":   return stopDevServer(input);
    default:
      return { ok: false, text: `[browser] Unknown tool: ${name}` };
  }
}
