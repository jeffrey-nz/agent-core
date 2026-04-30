import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loggerState } from "./state.js";
import { restoreTerminal } from "./utils.js";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = "agent-core.log";

export function initFileLogger({ logDir = LOG_DIR, logFile = LOG_FILE } = {}) {
  fs.mkdirSync(logDir, { recursive: true });

  const logFilePath = path.join(logDir, logFile);
  const previousPath = path.join(logDir, logFile + ".previous");

  try {
    const prevStats = fs.statSync(previousPath);
    if (prevStats.mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(previousPath);
    }
  } catch {}

  try { fs.renameSync(logFilePath, previousPath); } catch {}

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
}
