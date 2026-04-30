import process from "node:process";
import { logToFileOnly } from "./fileLogger/writers.js";
import { colors } from "./colors.js";
import { formatTimeHMS, formatDurationSec } from "#utils/format.js";

let lastLogTime = Date.now();
const ansiRegex =
  /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(str) {
  return String(str || "").replace(ansiRegex, "");
}

// Optional event sink — set by the host (e.g. copilot-helper injects its eventBus)
let _eventSink = null;
export function setLogEventSink(fn) { _eventSink = fn; }

export function logRaw(message) {
  logToFileOnly(message);
  _eventSink?.({ text: stripAnsi(String(message)), level: "info" });
  process.stdout.write(String(message) + "\n");
}

export function log(message, ...rest) {
  const now = Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;

  const ts = colors.dim(`[${formatTimeHMS()}]`);
  const dur = diff > 50 ? colors.dim(` (+${formatDurationSec(diff)})`) : "";

  const allArgs = [message, ...rest];
  const str = allArgs.map(a =>
    typeof a === "string" ? a :
    a instanceof Error ? (a.stack || a.message) :
    JSON.stringify(a, null, 2)
  ).join(" ");

  let prefixMatch = "";
  let bodyStr = str;
  const leadingNewlines = str.match(/^(\n+)/);
  if (leadingNewlines) {
    prefixMatch = leadingNewlines[1];
    bodyStr = str.substring(prefixMatch.length);
  }

  const out = `${prefixMatch}${ts} ${bodyStr}${dur}`;
  logToFileOnly(out);
  _eventSink?.({ text: stripAnsi(out), level: "info" });
  process.stdout.write(out + "\n");
}

export function logStep(step, message) {
  log(`\x1b[36mStep ${step}:\x1b[0m ${message}`);
}

export function logStructured({ requestId, persona, actor, phase, message, data, durationMs, success, error }) {
  const personaId = persona || actor;
  const entry = {
    timestamp: new Date().toISOString(),
    requestId, persona: personaId, actor: actor || personaId,
    phase, message, data, durationMs, success, error,
  };
  Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);
  logToFileOnly(JSON.stringify(entry));
  _eventSink?.({ type: "structured_log", ...entry });
}

function formatArgs(args) {
  return args.map(a =>
    typeof a === "string" ? a :
    a instanceof Error ? (a.stack || a.message) :
    JSON.stringify(a, null, 2)
  ).join(" ");
}

console.log = (...args) => logRaw(formatArgs(args));
console.error = (...args) => logRaw(colors.red(formatArgs(args)));
console.warn = (...args) => logRaw(colors.yellow(formatArgs(args)));
console.info = (...args) => logRaw(colors.blue(formatArgs(args)));
