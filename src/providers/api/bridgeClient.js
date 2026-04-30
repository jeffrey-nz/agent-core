import os from "node:os";
import fs from "node:fs";
import { BrowserAIClient } from "browser-ai-bridge/client";

function resolveBaseUrl() {
  if (process.env.BROWSER_AI_URL) return process.env.BROWSER_AI_URL;
  if (process.env.AUTOMATION_API_URL) return process.env.AUTOMATION_API_URL;
  const candidates = [
    `${os.tmpdir()}/automation-api-config.json`,
    "/tmp/automation-api-config.json",
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (cfg.port) return `http://localhost:${cfg.port}`;
    } catch {}
  }
  return "http://localhost:3333";
}

let _client = null;

export function getBridgeClient() {
  if (!_client) {
    _client = new BrowserAIClient({ baseUrl: resolveBaseUrl(), timeout: 300_000 });
  }
  return _client;
}

export function getBridgeBaseUrl() {
  return getBridgeClient().baseUrl;
}
