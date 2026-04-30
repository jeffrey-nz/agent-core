import { eventBus } from "../eventBus.js";

// Default time to wait for a human response before auto-continuing.
// Set to 0 to disable (wait forever — only suitable for setup wizards).
export const HUMAN_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function waitForResponse(requestId, timeoutMs = HUMAN_RESPONSE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const onResponse = (msg) => {
      cleanup();
      resolve(msg);
    };

    // When the user clicks Stop while the pipeline is awaiting a UI prompt
    // (e.g. human-feedback after the agent finishes), abort_requested fires
    // but waitForResponse has no way to unblock otherwise — the pipeline gets
    // stuck forever and the next start_task has no listener. Resolve with a
    // cancel payload so handleResponse returns "BACK" and the caller can then
    // check throwIfAborted(signal) to exit cleanly.
    const onAbort = () => {
      cleanup();
      resolve({ action: "cancel" });
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      eventBus.off(`ws_response_${requestId}`, onResponse);
      eventBus.off("abort_requested", onAbort);
    };

    // Resolve (not reject) on timeout so callers can auto-continue without
    // crashing the pipeline. Use action "timeout" so callers can distinguish
    // it from a real user response or a cancel.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            cleanup();
            resolve({ action: "timeout" });
          }, timeoutMs)
        : null;

    eventBus.on(`ws_response_${requestId}`, onResponse);
    eventBus.on("abort_requested", onAbort);
  });
}
