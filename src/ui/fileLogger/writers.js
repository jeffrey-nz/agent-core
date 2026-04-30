import { loggerState } from "./state.js";
import { stripAnsi, countLines } from "./utils.js";

export function logToFileOnly(text) {
  if (!loggerState.logStream) return;
  let clean = stripAnsi(text);

  if (clean.startsWith("\r") && !clean.includes("\n")) {
    return;
  }

  clean = clean.replace(/\r/g, "");
  const out = clean + "\n";
  loggerState.logStream.write(out, "utf8");
  loggerState.currentLineCount += countLines(out);
}

export function streamToFileOnly(text) {
  if (!loggerState.logStream) return;
  const clean = stripAnsi(text).replace(/\r/g, "");
  loggerState.logStream.write(clean, "utf8");
  loggerState.currentLineCount += countLines(clean);
}

