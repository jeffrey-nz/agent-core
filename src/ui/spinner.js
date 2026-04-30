import process from "node:process";
import { dashboardState } from "#app/ui/dashboard.js";
import { logToFileOnly } from "#app/ui/fileLogger.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { formatDurationSec } from "#utils/format.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Strip ANSI escape sequences before sending text to the browser UI.
// The terminal (process.stdout) interprets them correctly, but the web UI renders them as literal "[2m" etc.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function formatDuration(startTime) {
  if (!startTime) return "";
  const ms = Date.now() - startTime;
  if (ms < 100) return "";
  return colors.dim(` (${formatDurationSec(ms)})`);
}

function formatSuccess(message, durationStr) {
  return `${colors.green("✔️")} ${colors.bold(message)}${durationStr}`;
}

function formatFail(message, durationStr) {
  return `${colors.red("❌")} ${colors.red(colors.bold(message))}${durationStr}`;
}

function formatInfo(message, durationStr) {
  return `${colors.blue("ℹ️")} ${colors.bold(message)}${durationStr}`;
}

function renderSpinner(currentFrameIndex, message, durationStr) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(
    `\r\x1b[K${colors.cyan(SPINNER_FRAMES[currentFrameIndex])} ${message}${durationStr}`,
  );
}

function clearSpinner() {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\r\x1b[K");
}

export function createSpinner(initialText = "") {
  let current = 0;
  let timer = null;
  let message = initialText;
  let isSpinning = false;
  let startTime = 0;

  const getDur = () => formatDuration(startTime);
  const render = () => renderSpinner(current, message, getDur());

  const handleFinalize = (formattedOut) => {
    logToFileOnly(formattedOut);
    process.stdout.write(formattedOut + "\n");
  };

  return {
    start(newText) {
      if (newText) message = newText;
      if (isSpinning) return this;
      isSpinning = true;
      startTime = Date.now();

      dashboardState.aiStatus = stripAnsi(message);
      eventBus.emit("spinner_update", { status: stripAnsi(message) });

      if (!process.stdout.isTTY) {
        process.stdout.write(`${message}...\n`);
        return this;
      }

      render();
      timer = setInterval(() => {
        current = (current + 1) % SPINNER_FRAMES.length;
        render();
      }, 80);

      if (timer.unref) timer.unref();
      return this;
    },
    update(newText) {
      message = newText;
      dashboardState.aiStatus = stripAnsi(message);
      eventBus.emit("spinner_update", { status: stripAnsi(message) });
      if (isSpinning) render();
      return this;
    },
    succeed(newText) {
      this.stop();
      if (newText) message = newText;
      handleFinalize(formatSuccess(message, getDur()));
      return this;
    },
    fail(newText) {
      this.stop();
      if (newText) message = newText;
      handleFinalize(formatFail(message, getDur()));
      return this;
    },
    info(newText) {
      this.stop();
      if (newText) message = newText;
      handleFinalize(formatInfo(message, getDur()));
      return this;
    },
    stop() {
      if (!isSpinning) return this;
      isSpinning = false;
      clearInterval(timer);
      clearSpinner();
      dashboardState.aiStatus = "";
      eventBus.emit("spinner_update", { status: "" });
      return this;
    },
  };
}
