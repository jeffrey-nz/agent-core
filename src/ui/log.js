import process from "node:process";
import { clearStatus, getStatus, setStatus } from "#app/ui/status.js";
import { colors } from "#app/ui/colors.js";
import { formatTimeHMS, formatDurationSec } from "#utils/format.js";
import { logToFileOnly } from "#app/ui/fileLogger.js";
import { eventBus } from "#web/eventBus.js";

let lastLogTime = Date.now();
const ansiRegex =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(str) {
  return String(str || "").replace(ansiRegex, "");
}

export function logRaw(message) {
  logToFileOnly(message);
  eventBus.emit("log", { text: stripAnsi(String(message)), level: "info" });

  const statusActive = getStatus();
  if (statusActive) clearStatus();
  process.stdout.write(String(message) + "\n");
  if (statusActive) setStatus(statusActive);
}

export function log(message) {
  const now = Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;

  const ts = colors.dim(`[${formatTimeHMS()}]`);
  const dur = diff > 50 ? colors.dim(` (+${formatDurationSec(diff)})`) : "";

  const str = String(message);
  let prefixMatch = "";
  let bodyStr = str;
  const leadingNewlines = str.match(/^(\n+)/);

  if (leadingNewlines) {
    prefixMatch = leadingNewlines[1];
    bodyStr = str.substring(prefixMatch.length);
  }

  const out = `${prefixMatch}${ts} ${bodyStr}${dur}`;

  logToFileOnly(out);
  eventBus.emit("log", { text: stripAnsi(out), level: "info" });

  const statusActive = getStatus();
  if (statusActive) clearStatus();
  process.stdout.write(out + "\n");
  if (statusActive) setStatus(statusActive);
}

export function logStep(step, message) {
  log(`\x1b[36mStep ${step}:\x1b[0m ${message}`);
}

function formatArgs(args) {
  return args
    .map((a) =>
      typeof a === "string"
        ? a
        : a instanceof Error
          ? a.stack || a.message
          : JSON.stringify(a, null, 2),
    )
    .join(" ");
}

/**
 * Write a structured log entry as JSON line to the log file.
 * Does not write to console (preserves existing console output).
 * @param {Object} params
 * @param {string} params.requestId - Correlation ID for the session
 * @param {string} [params.persona] - Persona id/name (preferred)
 * @param {string} [params.actor] - Legacy actor id/name (still accepted)
 * @param {string} [params.phase] - Current phase (scoping, research, planning, coding, verification)
 * @param {string} params.message - Log message
 * @param {any} [params.data] - Additional structured data
 * @param {number} [params.durationMs] - Duration in milliseconds
 * @param {boolean} [params.success] - Whether the operation succeeded
 * @param {string} [params.error] - Error message if any
 */
export function logStructured({ requestId, persona, actor, phase, message, data, durationMs, success, error }) {
 // Prefer persona terminology, but accept legacy actor input.
 const personaId = persona || actor;

 const entry = {
 timestamp: new Date().toISOString(),
 requestId,
 persona: personaId,
 actor: actor || personaId,
    phase,
    message,
    data,
    durationMs,
    success,
    error
  };
  // Remove undefined fields to keep log clean
  Object.keys(entry).forEach(key => entry[key] === undefined && delete entry[key]);
  logToFileOnly(JSON.stringify(entry));
  // Also emit to eventBus for potential UI consumption
  eventBus.emit('structured_log', entry);
}

console.log = (...args) => logRaw(formatArgs(args));
console.error = (...args) => logRaw(colors.red(formatArgs(args)));
console.warn = (...args) => logRaw(colors.yellow(formatArgs(args)));
console.info = (...args) => logRaw(colors.blue(formatArgs(args)));
