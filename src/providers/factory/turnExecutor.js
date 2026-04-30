import { executeVercelTurn } from "../vercelSdk.js";
import { runAutomationApiTurn } from "./automationApiTurn.js";
import { handleSegmentBoundary } from "./segmentBoundary.js";

const MAX_TURNS_HARD = 200;

export function createTurnExecutor({
  providerName,
  model,
  useAutomationApi,
  automationState,
  getProgressSummary,
  getPendingMode,
}) {
  let turnLock = Promise.resolve();
  let turnCount = 0;

  async function execute(payload, label, options) {
    turnCount++;

    if (turnCount > MAX_TURNS_HARD) {
      throw new Error("Hard turn limit reached without terminal state");
    }

    if (useAutomationApi) {
      const finalPayload = await handleSegmentBoundary({
        providerName,
        automationState,
        getProgressSummary,
        payload,
      });

      const result = await runAutomationApiTurn({
        providerName,
        pendingMode: getPendingMode(),
        state: automationState,
        payload: finalPayload,
        label,
        options,
      });

      automationState.lastResponseText = result.text ?? "";
      return result;
    }

    return executeVercelTurn(model, providerName, payload, label, options);
  }

  return async function sendTurn(payload, label, options = {}) {
    const resultPromise = turnLock.then(
      () => execute(payload, label, options),
      () => execute(payload, label, options),
    );
    turnLock = resultPromise.catch(() => {});
    return resultPromise;
  };
}
