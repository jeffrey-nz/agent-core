import { eventBus } from "#web/eventBus.js";
import { SLOW_WARN_THRESHOLD_MS, SLOW_WARN_INTERVAL_MS } from "./constants.js";

export function createTelemetryTracker(sessionId, label) {
  const startedAt = Date.now();
  let slowWarnTimer = null;
  let slowWarnCount = 0;

  const start = () => {
    slowWarnTimer = setTimeout(function tick() {
      const elapsed = Date.now() - startedAt;
      slowWarnCount++;
      eventBus.emit("session_slow", {
        elapsedMs: elapsed,
        label,
        remoteSessionId: sessionId,
      });
      slowWarnTimer = setTimeout(tick, SLOW_WARN_INTERVAL_MS);
    }, SLOW_WARN_THRESHOLD_MS);
  };

  const stop = () => {
    if (slowWarnTimer) {
      clearTimeout(slowWarnTimer);
      slowWarnTimer = null;
    }
    if (slowWarnCount > 0) {
      eventBus.emit("session_slow_done", {});
    }
  };

  return { start, stop };
}
