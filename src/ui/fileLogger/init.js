import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loggerState } from "./state.js";
import { restoreTerminal } from "./utils.js";
import { markInProgressSessionsAsInterrupted } from "#copilot/run/main/sessionState/db.js";

const LOG_DIR = path.resolve(process.cwd(), "logs");

export function initFileLogger() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const logFilePath = path.join(LOG_DIR, "copilot-helper.log");
  const previousPath = path.join(LOG_DIR, "copilot-helper.log.previous");

  // Weekly rotation: drop the previous log if older than 7 days
  try {
    const prevStats = fs.statSync(previousPath);
    if (prevStats.mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(previousPath);
    }
  } catch {}

  // Rotate current → previous on startup
  try { fs.renameSync(logFilePath, previousPath); } catch {}

  // Size cap: if combined logs exceed 10 MB, drop the older file
  try {
    const curSize = fs.statSync(logFilePath).size;
    const prevSize = fs.statSync(previousPath).size;
    if (curSize + prevSize > 10 * 1024 * 1024) {
      const curMtime = fs.statSync(logFilePath).mtimeMs;
      const prevMtime = fs.statSync(previousPath).mtimeMs;
      fs.unlinkSync(curMtime < prevMtime ? logFilePath : previousPath);
    }
  } catch {}

  loggerState.logStream = fs.createWriteStream(logFilePath, { flags: "w" });
  loggerState.currentLineCount = 1;

  function shutdown() {
    restoreTerminal();
    if (loggerState.logStream) loggerState.logStream.end();
  }

  process.on("exit", shutdown);

  process.on("SIGINT", () => {
    markInProgressSessionsAsInterrupted();
    shutdown();
    process.exit(130);
  });

  process.on("SIGTERM", () => {
    markInProgressSessionsAsInterrupted();
    shutdown();
    process.exit(143);
  });
}
