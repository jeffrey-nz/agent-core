import process from "node:process";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { logToFileOnly } from "#app/ui/fileLogger.js";
import { eventBus } from "#web/eventBus.js";

const COOLDOWN_MS = 60 * 60 * 1000;
const TOTAL_SECS = 3600;
const BAR_WIDTH = 36;

function formatCountdown(secsLeft) {
  const h = Math.floor(secsLeft / 3600);
  const m = Math.floor((secsLeft % 3600) / 60);
  const s = secsLeft % 60;
  if (h > 0)
    return `${String(h).padStart(1, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderBar(secsLeft) {
  const elapsed = TOTAL_SECS - secsLeft;
  const filled = Math.round((elapsed / TOTAL_SECS) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return colors.cyan("█".repeat(filled)) + colors.dim("░".repeat(empty));
}

export async function rateLimitCooldown(reason, rl) {
  const border = colors.dim("━".repeat(68));

  log(
    [
      "",
      border,
      `⏳  ${colors.bold(colors.yellow("RATE LIMIT — AUTO COOLDOWN"))}`,
      border,
      `${colors.dim("Reason :")} ${reason || "Provider rate limit reached"}`,
      `${colors.dim("Waiting :")} 1 hour, then retrying automatically`,
      colors.dim("Press Enter at any time to skip the wait and retry now."),
      border,
      "",
    ].join("\n"),
  );

  logToFileOnly(
    `[RATE LIMIT COOLDOWN] Reason: ${reason}\nWaiting 60 minutes before retry...\n`,
  );

  // Notify the UI so the user sees the wait instead of a frozen spinner
  eventBus.emit("phase_change", { phase: "DEBUGGING", label: "Rate limit — waiting…" });
  eventBus.emit("rate_limit", { retryAfter: TOTAL_SECS });
  eventBus.emit("system_message", {
    text: `⏳ Rate limit reached — waiting 60 minutes before retry. Reason: ${reason || "provider limit"}`,
    type: "warning",
  });

  await new Promise((resolve) => {
    let secsLeft = TOTAL_SECS;
    let done = false;
    // Emit UI update every 5 minutes so the user sees the countdown
    const UI_INTERVAL_SECS = 300;
    let nextUiSecs = TOTAL_SECS - UI_INTERVAL_SECS;

    const finish = (skipped = false) => {
      if (done) return;
      done = true;
      clearInterval(interval);
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
      const msg = skipped
        ? colors.green("  ✔ Cooldown skipped — retrying now...")
        : colors.green("  ✔ Cooldown complete — retrying now...");
      log(msg);
      logToFileOnly(skipped ? "[COOLDOWN SKIPPED]" : "[COOLDOWN COMPLETE]");
      eventBus.emit("system_message", {
        text: skipped
          ? "✓ Rate limit cooldown skipped — resuming"
          : "✓ Rate limit cooldown complete — resuming",
        type: "info",
      });
      resolve();
    };

    const render = () => {
      if (!process.stdout.isTTY) return;
      const time = colors.bold(colors.cyan(formatCountdown(secsLeft)));
      const bar = renderBar(secsLeft);
      process.stdout.write(
        `\r\x1b[K  ⏳  ${time}  [${bar}]  ${colors.dim("(Enter to skip)")}`,
      );
    };

    render();

    const interval = setInterval(() => {
      secsLeft--;
      if (secsLeft <= 0) {
        finish(false);
        return;
      }
      render();
      // Periodic UI update for long waits
      if (secsLeft <= nextUiSecs) {
        nextUiSecs -= UI_INTERVAL_SECS;
        const minsLeft = Math.ceil(secsLeft / 60);
        eventBus.emit("system_message", {
          text: `⏳ Rate limit cooldown: ~${minsLeft} minute${minsLeft !== 1 ? "s" : ""} remaining`,
          type: "warning",
        });
      }
    }, 1000);

    if (interval.unref) interval.unref();

    if (rl && typeof rl.once === "function") {
      rl.once("line", () => finish(true));
    }
  });
}
