import { PROVIDER_LIMITS } from "../registry.js";
import { eventBus } from "#web/eventBus.js";
import { resolveModel } from "./models.js";
import { closeAutomationApi } from "./automationApiTurn.js";
import { createTurnExecutor } from "./turnExecutor.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function createProvider(providerName, opts = {}) {
  const { model, useAutomationApi } = await resolveModel(providerName);
  const { getProgressSummary, reasoningMode = "none" } = opts;

  const automationState = {
    remoteSessionId: null,
    maxPromptChars: useAutomationApi ? 118000 : 120000,
    messageCount: 0,
    lastResponseText: "",
    segmentIndex: 0,
    eventBus,
  };

  let pendingMode = opts.mode || null;

  // Create provider object first (without sendTurn)
  const provider = {
    providerName,
    model,
    reasoningMode,
    limits: PROVIDER_LIMITS[providerName] ?? { soft: 18, hard: 26 },
    get maxPromptChars() {
      return automationState.maxPromptChars;
    },

    async startNewChat() {
      if (useAutomationApi) {
        await closeAutomationApi(automationState);
        automationState.messageCount = 0;
        automationState.lastResponseText = "";
      }
      return true;
    },

    async setMode(mode) {
      if (useAutomationApi && mode) {
        pendingMode = mode;
      }
      return true;
    },

    // Placeholder, will be replaced after createTurnExecutor
    async sendTurn(messages, label, contextOpts = {}) {
      throw new Error("sendTurn not initialized");
    },

    async heal() {
      return { changesMade: 0 };
    },

    async close() {
      if (useAutomationApi) {
        await closeAutomationApi(automationState);
      }
    },
  };

  // Create the turn executor, passing the provider reference
  const sendTurn = createTurnExecutor({
    providerName,
    model,
    useAutomationApi,
    automationState,
    getProgressSummary,
    getPendingMode: () => pendingMode,
    reasoningMode,
    provider,
  });

  // Assign the actual sendTurn implementation
  provider.sendTurn = async (messages, label, contextOpts = {}) => {
    try {
      return await sendTurn(messages, label, contextOpts);
    } catch (err) {
      if (
        !useAutomationApi &&
        (err.message.includes("429") || err.message.includes("503"))
      ) {
        log(
          colors.yellow(
            `  [Provider Factory] ${providerName} failed. Falling back to safe defaults...`,
          ),
        );

        throw err;
      }
      throw err;
    }
  };

  return provider;
}
