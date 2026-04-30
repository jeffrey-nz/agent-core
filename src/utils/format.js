import { BUILD_COMMAND_RE } from "./projectDirectives.js";

export function getSafeId(id) {
  return String(id || "default").replace(/[^a-zA-Z0-9-_]/g, "_");
}

export function padZero(n, width = 2) {
  return String(n).padStart(width, "0");
}

export function formatTimeHMS(date = new Date()) {
  return `${padZero(date.getHours())}:${padZero(date.getMinutes())}:${padZero(date.getSeconds())}`;
}

export function formatTimeHMSMs(date = new Date()) {
  return `${formatTimeHMS(date)}.${padZero(date.getMilliseconds(), 3)}`;
}

export function formatDurationSec(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDurationMs(ms) {
  if (!ms && ms !== 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatDateDMY(date = new Date()) {
  return `${padZero(date.getDate())}/${padZero(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Smart truncation for SilverStripe dev/build / db:build output.
 *
 * These commands dump hundreds of "* TableName (N records)" lines that are
 * pure noise for the AI — they carry no error signal and bloat the chat
 * context enough to trigger Copilot365 context-overflow SESSION_BUSY events.
 *
 * Strategy:
 *  1. Strip all "  * TableName (N records)" lines (table listing section).
 *  2. Strip the long PHP stack-trace body, keeping only the first 3 frames
 *     and a count of how many were omitted (stack traces from SAML/auth
 *     middleware are always non-fatal in CLI and add ~2000 chars of noise).
 *  3. Apply a hard cap of 3000 chars on the remaining output.
 */
function stripBuildNoise(str) {
  const lines = str.split("\n");
  const filtered = [];
  let inStackTrace = false;
  let stackFrameCount = 0;
  let stackFramesShown = 0;
  const MAX_STACK_FRAMES = 3;

  for (const line of lines) {
    // Suppress "  * TableName (N records)" and "  + Field change" lines
    if (/^\s+[*+]\s+\S/.test(line)) continue;

    // Detect start of PHP stack trace: "#0 /path/to/file.php"
    if (/^\s*#\d+\s+\S/.test(line)) {
      if (!inStackTrace) {
        inStackTrace = true;
        stackFrameCount = 0;
        stackFramesShown = 0;
      }
      stackFrameCount++;
      if (stackFramesShown < MAX_STACK_FRAMES) {
        filtered.push(line);
        stackFramesShown++;
      }
      continue;
    }

    // First non-stack-trace line after a trace: emit omitted-frames summary
    if (inStackTrace) {
      const omitted = stackFrameCount - stackFramesShown;
      if (omitted > 0) {
        filtered.push(`  ...[${omitted} more stack frames omitted]`);
      }
      inStackTrace = false;
    }

    filtered.push(line);
  }

  if (inStackTrace && stackFrameCount - stackFramesShown > 0) {
    filtered.push(`  ...[${stackFrameCount - stackFramesShown} more stack frames omitted]`);
  }

  return filtered.join("\n");
}

/**
 * Returns true if the command string looks like a framework build/flush command.
 * The patterns come from projectDirectives so this stays framework-agnostic.
 */
function isBuildCommand(str) {
  return BUILD_COMMAND_RE.test(str);
}

export function truncateText(str, maxLength = 7500, preserveEnd = 6000) {
  if (!str) return "";
  if (str.length <= maxLength) return str;
  return (
    str.slice(0, 1500) +
    "\n...[MIDDLE TRUNCATED — showing tail where errors appear]...\n" +
    str.slice(-preserveEnd)
  );
}

/**
 * Truncation variant for command tool output that contains a command string.
 * Applies build-noise stripping for sake/dev/build commands, then falls back
 * to standard truncation.
 */
export function truncateCommandOutput(str, cmd = "") {
  if (!str) return "";

  // For build commands, strip table listings and long stack traces first
  const processed = isBuildCommand(cmd) ? stripBuildNoise(str) : str;

  // Hard cap at 3000 chars for build commands (they're voluminous but rarely
  // contain useful information beyond the exit code and error lines)
  const cap = isBuildCommand(cmd) ? 3000 : 7500;
  const tail = isBuildCommand(cmd) ? 2500 : 6000;

  if (processed.length <= cap) return processed;
  return (
    processed.slice(0, 500) +
    "\n...[MIDDLE TRUNCATED — showing tail where errors appear]...\n" +
    processed.slice(-tail)
  );
}
