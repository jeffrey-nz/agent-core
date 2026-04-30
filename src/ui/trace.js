import process from "node:process";
import { clearStatus, getStatus, setStatus } from "#app/ui/status.js";
import { formatTimeHMSMs } from "#utils/format.js";
import { logToFileOnly } from "./fileLogger.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function levelValue(name) {
  const k = String(name || "").toLowerCase();
  return LEVELS[k] ?? LEVELS.debug;
}

const CURRENT_LEVEL = levelValue(
  process.env.COPILOT_HELPER_LOG_LEVEL || "info",
);

function fmtScope(scope) {
  const s = String(scope || "LOG").toUpperCase();
  return s.length >= 6 ? s.slice(0, 6) : s.padEnd(6, " ");
}

function safeMeta(meta) {
  if (!meta) return "";
  try {
    const parts = Object.entries(meta).map(([k, v]) => `${k}=${v}`);
    if (parts.length === 0) return "";
    const str = parts.join(", ");
    return str.length <= 220 ? ` [${str}]` : ` [${str.slice(0, 220)}…]`;
  } catch {
    return "";
  }
}

function out(line, isErr = false) {
  const statusActive = getStatus();
  if (statusActive) clearStatus();

  logToFileOnly(line);

  if (isErr) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");

  if (statusActive) setStatus(statusActive);
}

export function traceDebug(scope, message, meta = null) {
  if (CURRENT_LEVEL > LEVELS.debug) return;
  out(
    `\x1b[90m${formatTimeHMSMs()}\x1b[0m ${fmtScope(scope)} ${message}${safeMeta(meta)}`,
  );
}

export function traceInfo(scope, message, meta = null) {
  if (CURRENT_LEVEL > LEVELS.info) return;
  out(
    `\x1b[90m${formatTimeHMSMs()}\x1b[0m \x1b[32m${fmtScope(scope)}\x1b[0m ${message}${safeMeta(meta)}`,
  );
}

export function traceWarn(scope, message, meta = null) {
  if (CURRENT_LEVEL > LEVELS.warn) return;
  out(
    `\x1b[90m${formatTimeHMSMs()}\x1b[0m \x1b[33m${fmtScope(scope)}\x1b[0m ${message}${safeMeta(meta)}`,
    true,
  );
}

export function traceError(scope, message, meta = null) {
  if (CURRENT_LEVEL > LEVELS.error) return;
  out(
    `\x1b[90m${formatTimeHMSMs()}\x1b[0m \x1b[31m${fmtScope(scope)}\x1b[0m ${message}${safeMeta(meta)}`,
    true,
  );
}

export function traceStep(scope, stepLabel, message, meta = null) {
  if (CURRENT_LEVEL > LEVELS.info) return;
  out(
    `\x1b[90m${formatTimeHMSMs()}\x1b[0m \x1b[34m${fmtScope(scope)}\x1b[0m ${stepLabel}: ${message}${safeMeta(meta)}`,
  );
}
