import { eventBus } from "#web/eventBus.js";
import { getReasoningMode as getGlobalReasoningMode, setReasoningMode as setGlobalReasoningMode } from "./reasoningConfig.js";

let currentProvider = null;
let currentMode = null;

export function setProviderConfig(provider, mode) {
  if (provider !== currentProvider || mode !== currentMode) {
    currentProvider = provider;
    currentMode = mode;
    eventBus.emit("provider_config_changed", { provider, mode });
    console.log(`[ProviderConfig] Updated: provider=${provider}, mode=${mode}`);
  }
}

export function getProviderConfig() {
  return { provider: currentProvider, mode: currentMode };
}

// Delegate reasoning mode methods to reasoningConfig.js for backward compatibility
export function getReasoningMode() {
  return getGlobalReasoningMode();
}

export function setReasoningMode(mode) {
  return setGlobalReasoningMode(mode);
}
