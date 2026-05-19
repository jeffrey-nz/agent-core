/**
 * stackTraceParser.js
 *
 * Parses error output from common runtimes into structured location data.
 * Used by debuggerNode to identify the exact source files and lines to investigate.
 *
 * Supported formats:
 *   PHP       — Fatal error: ... in /path/file.php on line 123
 *              PHP Fatal error: Uncaught ...: msg in /path/file.php:123
 *   Node.js   — Error: msg\n    at fn (/path/file.js:123:45)
 *   Python    — File "/path/file.py", line 123, in fn
 *   .NET/C#   — at Namespace.Class.Method() in /path/file.cs:line 123
 *   Ruby      — /path/file.rb:123:in `method_name'
 *   Go        — panic: msg / goroutine N ... \t/path/file.go:123
 *   Java      — at com.example.Class.method(File.java:123)
 *   Bash      — line 123: command: message
 */

/**
 * @typedef {Object} StackFrame
 * @property {string} file    - Relative or absolute file path
 * @property {number|null} line  - Line number (1-based), or null if not found
 * @property {string|null} fn    - Function/method name, or null
 */

/**
 * @typedef {Object} ParsedError
 * @property {string} type          - Exception type / error category (e.g. "TypeError", "Fatal error")
 * @property {string} message       - Error message text
 * @property {StackFrame[]} frames  - Stack frames, most relevant first
 * @property {StackFrame|null} root - The frame most likely to be the bug source
 *                                   (first non-vendor, non-framework frame)
 */

// Vendor/framework path segments to skip when picking the "root" frame.
const VENDOR_PATTERNS = [
  /\/vendor\//i,
  /\/node_modules\//i,
  /\/framework\//i,
  /thirdparty/i,
  /silverstripe\/framework/i,
  /silverstripe\/cms/i,
  /psr\//i,
  /symfony\//i,
  /monolog\//i,
  /\bReflection\b/,
  /at node:internal\//,
  /at async Promise/,
];

function isVendorFrame(file) {
  return VENDOR_PATTERNS.some((p) => p.test(file));
}

/**
 * Picks the most useful frame from a list — prefers the first non-vendor frame.
 */
function pickRootFrame(frames) {
  if (!frames.length) return null;
  const appFrame = frames.find((f) => f.file && !isVendorFrame(f.file));
  return appFrame || frames[0];
}

// ── PHP ──────────────────────────────────────────────────────────────────────

function parsePhp(output) {
  const frames = [];
  let type = "PHP Error";
  let message = "";

  // Match "Fatal error: Uncaught ExceptionType: msg in /path:line" or "in /path on line N"
  const fatalRe = /(?:PHP\s+)?(?:Fatal|Parse|Warning|Notice|Deprecated) error:\s*(.*?)(?:\s+in\s+(\/[^\s:]+)(?::(\d+)|\s+on\s+line\s+(\d+)))?$/im;
  const fatalMatch = output.match(fatalRe);
  if (fatalMatch) {
    message = fatalMatch[1]?.trim() || "";
    const file = fatalMatch[2] || null;
    const line = parseInt(fatalMatch[3] || fatalMatch[4]) || null;
    if (file) frames.push({ file, line, fn: null });
    type = fatalMatch[0].match(/Fatal|Parse|Warning|Notice|Deprecated/i)?.[0] + " error" || type;
  }

  // PHP Uncaught exception in /path:N — first line of a multiline fatal
  const uncaughtRe = /Uncaught\s+([\w\\]+):\s*(.*?)\s+in\s+(\/[^\s:]+):(\d+)/gm;
  for (const m of output.matchAll(uncaughtRe)) {
    type = m[1];
    message = message || m[2];
    frames.push({ file: m[3], line: parseInt(m[4]), fn: null });
  }

  // Stack trace lines: "#N /path/file.php(N): ClassName->method()"
  const traceRe = /^#\d+\s+(\/[^\s(]+)\((\d+)\):\s*(.*)/gm;
  for (const m of output.matchAll(traceRe)) {
    frames.push({ file: m[1], line: parseInt(m[2]), fn: m[3] });
  }

  return frames.length ? { type, message, frames, root: pickRootFrame(frames) } : null;
}

// ── Node.js / JavaScript ──────────────────────────────────────────────────────

function parseNode(output) {
  const frames = [];
  let type = "Error";
  let message = "";

  // First line: "TypeError: Cannot read property 'x' of undefined"
  const firstLineRe = /^(\w*Error|\w*Exception):\s*(.+)/m;
  const firstMatch = output.match(firstLineRe);
  if (firstMatch) {
    type = firstMatch[1];
    message = firstMatch[2];
  }

  // at functionName (/path/file.js:123:45)
  // at /path/file.js:123:45  (anonymous)
  const atRe = /^\s+at\s+(?:([\w.<>$\[\] ]+?)\s+\((.+?):(\d+):\d+\)|(\/[^:)]+):(\d+):\d+)/gm;
  for (const m of output.matchAll(atRe)) {
    if (m[2]) {
      frames.push({ file: m[2], line: parseInt(m[3]), fn: m[1] || null });
    } else if (m[4]) {
      frames.push({ file: m[4], line: parseInt(m[5]), fn: null });
    }
  }

  return frames.length ? { type, message, frames, root: pickRootFrame(frames) } : null;
}

// ── Python ────────────────────────────────────────────────────────────────────

function parsePython(output) {
  const frames = [];
  let type = "Exception";
  let message = "";

  // File "/path/file.py", line 123, in fn_name
  const fileRe = /File "(.*?)", line (\d+)(?:, in (.+))?/gm;
  for (const m of output.matchAll(fileRe)) {
    frames.push({ file: m[1], line: parseInt(m[2]), fn: m[3] || null });
  }

  // Last line: ExceptionType: message
  const excRe = /^(\w+(?:Error|Exception|Warning)):\s*(.+)/m;
  const excMatch = output.match(excRe);
  if (excMatch) {
    type = excMatch[1];
    message = excMatch[2];
  }

  return frames.length ? { type, message, frames, root: pickRootFrame(frames.slice().reverse()) } : null;
}

// ── .NET / C# ─────────────────────────────────────────────────────────────────

function parseDotNet(output) {
  const frames = [];
  let type = "Exception";
  let message = "";

  // "System.NullReferenceException: Object reference not set..."
  const excRe = /^(\S+(?:Exception|Error)):\s*(.+)/m;
  const excMatch = output.match(excRe);
  if (excMatch) {
    type = excMatch[1];
    message = excMatch[2];
  }

  // at Namespace.Class.Method() in /path/File.cs:line 123
  const atRe = /^\s+at\s+([\w.<>]+\(.*?\))\s+in\s+(.+?):line\s+(\d+)/gm;
  for (const m of output.matchAll(atRe)) {
    frames.push({ file: m[2], line: parseInt(m[3]), fn: m[1] });
  }

  // at Namespace.Class.Method() — without file info
  if (!frames.length) {
    const atBasicRe = /^\s+at\s+([\w.<>]+\(.*?\))/gm;
    for (const m of output.matchAll(atBasicRe)) {
      frames.push({ file: null, line: null, fn: m[1] });
    }
  }

  return frames.length ? { type, message, frames, root: pickRootFrame(frames) } : null;
}

// ── Ruby ─────────────────────────────────────────────────────────────────────

function parseRuby(output) {
  const frames = [];
  let type = "RuntimeError";
  let message = "";

  // /path/file.rb:123:in `method_name': error message (ExceptionClass)
  const mainRe = /^(\/[^:]+):(\d+):in\s+`([^']+)':\s*(.*?)\s+\((\w+)\)/m;
  const mainMatch = output.match(mainRe);
  if (mainMatch) {
    frames.push({ file: mainMatch[1], line: parseInt(mainMatch[2]), fn: mainMatch[3] });
    message = mainMatch[4];
    type = mainMatch[5];
  }

  // from /path/file.rb:123:in `method'
  const fromRe = /from (\/[^:]+):(\d+):in\s+`([^']+)'/gm;
  for (const m of output.matchAll(fromRe)) {
    frames.push({ file: m[1], line: parseInt(m[2]), fn: m[3] });
  }

  return frames.length ? { type, message, frames, root: pickRootFrame(frames) } : null;
}

// ── Go ────────────────────────────────────────────────────────────────────────

function parseGo(output) {
  const frames = [];
  let type = "panic";
  let message = "";

  // "panic: <message>" or "goroutine N [running]:"
  const panicRe = /^panic:\s*(.+)/m;
  const panicMatch = output.match(panicRe);
  if (panicMatch) {
    type = "panic";
    message = panicMatch[1].trim();
  }

  // Go test failures: "--- FAIL: TestName" with "/path/file_test.go:42"
  const testFailRe = /^\s+(\S+_test\.go):(\d+):/gm;
  for (const m of output.matchAll(testFailRe)) {
    frames.push({ file: m[1], line: parseInt(m[2]), fn: null });
  }

  // Go panic stack frames: "\t/path/file.go:42 +0x..." or "main.FuncName(...)"
  //   goroutine N [running]:
  //   package.FuncName(...)
  //           /path/to/file.go:42 +0x1c4
  const goFrameRe = /\t(\/[^:]+\.go):(\d+)/gm;
  for (const m of output.matchAll(goFrameRe)) {
    frames.push({ file: m[1], line: parseInt(m[2]), fn: null });
  }

  if (!frames.length && !panicMatch) return null;
  return { type, message, frames, root: pickRootFrame(frames) };
}

// ── Master parser ─────────────────────────────────────────────────────────────

/**
 * Parses a raw error/output string and returns structured location data.
 * Returns null if no recognisable stack trace is found.
 *
 * @param {string} output  - Raw stdout/stderr from a command or tool result
 * @returns {ParsedError|null}
 */
export function parseStackTrace(output) {
  if (!output || typeof output !== "string") return null;

  // Try each parser in priority order — first non-null result wins.
  const result =
    parsePhp(output) ||
    parseNode(output) ||
    parsePython(output) ||
    parseDotNet(output) ||
    parseRuby(output) ||
    parseGo(output);

  return result || null;
}

/**
 * Formats a ParsedError into a compact human-readable summary for AI prompts.
 * Keeps it terse — this goes inside a larger system prompt.
 *
 * @param {ParsedError} parsed
 * @param {number} [maxFrames=5]
 * @returns {string}
 */
export function formatParsedError(parsed, maxFrames = 5) {
  if (!parsed) return "";

  const lines = [`${parsed.type}: ${parsed.message}`];

  if (parsed.root) {
    const { file, line, fn } = parsed.root;
    const loc = line ? `${file}:${line}` : file;
    const fnStr = fn ? ` in ${fn}` : "";
    lines.push(`→ Likely source: ${loc}${fnStr}`);
  }

  const shown = parsed.frames.slice(0, maxFrames);
  if (shown.length > 0) {
    lines.push("Stack (most recent first):");
    for (const { file, line, fn } of shown) {
      const loc = file ? (line ? `${file}:${line}` : file) : "(unknown)";
      const fnStr = fn ? ` — ${fn}` : "";
      lines.push(`  ${loc}${fnStr}`);
    }
    if (parsed.frames.length > maxFrames) {
      lines.push(`  … ${parsed.frames.length - maxFrames} more frames`);
    }
  }

  return lines.join("\n");
}

/**
 * Extracts all unique file paths mentioned in a parsed stack trace.
 * Filters out vendor/framework files unless no app files exist.
 *
 * @param {ParsedError} parsed
 * @returns {string[]}  Unique file paths, app files first
 */
export function extractFilesFromTrace(parsed) {
  if (!parsed) return [];

  const all = parsed.frames
    .map((f) => f.file)
    .filter(Boolean);

  const unique = [...new Set(all)];
  const app = unique.filter((f) => !isVendorFrame(f));

  return app.length > 0 ? app : unique;
}
