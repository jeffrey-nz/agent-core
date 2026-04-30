import { eventBus } from "#web/eventBus.js";
import { log } from "#app/ui/log.js";

let currentReasoningMode = "none";

const VALID_MODES = ["none", "cot", "reflective"];

export function setReasoningMode(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid reasoning mode: ${mode}. Must be one of: ${VALID_MODES.join(", ")}`);
  }
  if (mode !== currentReasoningMode) {
    currentReasoningMode = mode;
    eventBus.emit("reasoning_mode_changed", { mode });
    log(`[ReasoningConfig] Reasoning mode updated: ${mode}`);
  }
}

export function getReasoningMode() {
  return currentReasoningMode;
}
