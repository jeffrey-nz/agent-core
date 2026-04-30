/**
 * devServer.js — starts an npm dev server for React/Vite projects via the
 * browser-ai-bridge /api/devserver route, then returns the running URL so
 * the visual verifier can screenshot it.
 *
 * Returns { pid, url } on success, or null if the project isn't a React/Vite
 * project, prerequisites are missing, or the bridge is unavailable.
 * Never throws — all errors are logged and swallowed to avoid blocking the
 * validation pipeline.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { getBaseUrl } from "#providers/api/config.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function startDevServer(projectDir) {
  // 1. Must have package.json with a "dev" script
  const pkgPath = path.join(projectDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    return null;
  }

  if (!pkg?.scripts?.dev) return null;

  // 2. Must be a React or Vite project
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const isViteOrReact =
    !!deps["vite"] ||
    !!deps["react"] ||
    Object.keys(deps).some((k) => k.includes("@vitejs"));
  if (!isViteOrReact) return null;

  // 3. node_modules must exist (npm install has been run)
  try {
    await fs.access(path.join(projectDir, "node_modules"));
  } catch {
    log(colors.dim("  [DevServer] node_modules not found — skipping visual verify"));
    return null;
  }

  // 4. Bridge must be reachable
  const apiBase = getBaseUrl();
  if (!apiBase) return null;

  try {
    log(colors.dim(`  [DevServer] Starting dev server in ${projectDir}…`));
    const resp = await fetch(`${apiBase}/api/devserver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectDir, command: "npm run dev", port: 5173 }),
      signal: AbortSignal.timeout(70_000), // bridge waits up to 45s internally
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log(colors.dim(`  [DevServer] Bridge returned ${resp.status}: ${body.slice(0, 120)}`));
      return null;
    }

    const data = await resp.json();
    const { pid, url } = data.data;
    log(colors.green(`  [DevServer] Running at ${url} (pid ${pid})`));
    return { pid, url };
  } catch (err) {
    log(colors.dim(`  [DevServer] Could not start: ${err.message?.slice(0, 80)}`));
    return null;
  }
}

export async function killDevServer(pid) {
  const apiBase = getBaseUrl();
  if (!apiBase || !pid) return;
  try {
    await fetch(`${apiBase}/api/devserver/${pid}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort — bridge will clean up on its own exit */
  }
}
