/**
 * captureWebScreenshot — asks automation-api to screenshot a URL and saves the
 * result as a PNG file in the copilot-helper logs directory.
 *
 * Returns { screenshotBase64, savedPath } on success, or null if the endpoint
 * is unavailable (automation-api not running, browser not ready, etc.).
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getBaseUrl } from "#providers/api/config.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");

async function ensureScreenshotsDir() {
  try {
    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  } catch {
    // already exists or unwritable — proceed anyway
  }
}

/**
 * @param {string} url  Fully-qualified URL to screenshot
 * @returns {Promise<{ screenshotBase64: string, savedPath: string } | null>}
 */
export async function captureWebScreenshot(url) {
  const apiBase = getBaseUrl();
  if (!apiBase) return null;

  const endpoint = `${apiBase}/api/screenshot?url=${encodeURIComponent(url)}`;

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(endpoint, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      log(colors.dim(`  [HTTP Smoke] Screenshot endpoint returned ${resp.status} — skipping screenshot`));
      return null;
    }

    data = await resp.json();
  } catch (err) {
    // automation-api not running or browser not ready — not fatal
    log(colors.dim(`  [HTTP Smoke] Screenshot unavailable: ${err.message?.slice(0, 80)}`));
    return null;
  }

  if (!data?.data?.screenshotBase64) return null;

  const { screenshotBase64 } = data.data;

  // Save to ./screenshots/<timestamp>-smoke.png
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}-smoke.png`;
  const savedPath = path.join(SCREENSHOTS_DIR, filename);

  try {
    await ensureScreenshotsDir();
    const buf = Buffer.from(screenshotBase64, "base64");
    await fs.writeFile(savedPath, buf);
  } catch (err) {
    log(colors.dim(`  [HTTP Smoke] Could not save screenshot: ${err.message}`));
    // Still return the base64 so the event can be emitted
    return { screenshotBase64, savedPath: null };
  }

  return { screenshotBase64, savedPath };
}
