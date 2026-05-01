import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { closeAutomationApi } from "./automationApiTurn.js";
import { injectRotationHandoff } from "./rotation.js";

const ROTATION_THRESHOLDS = {
  copilot365: 15,
  deepseek: 20,
};

const SUPPORTED_PROVIDERS = new Set(Object.keys(ROTATION_THRESHOLDS));

export async function handleSegmentBoundary({
  providerName,
  automationState,
  getProgressSummary,
  payload,
}) {
  const rotationThreshold = ROTATION_THRESHOLDS[providerName];

  if (
    !SUPPORTED_PROVIDERS.has(providerName) ||
    !automationState.remoteSessionId ||
    automationState.messageCount < rotationThreshold
  ) {
    return payload;
  }

  const previousMessageCount = automationState.messageCount;
  automationState.segmentIndex += 1;
  const segmentIndex = automationState.segmentIndex;

  log(
    colors.yellow(
      `  [Segment] ${providerName} session ${segmentIndex - 1} had ${previousMessageCount} messages — starting segment ${segmentIndex} in fresh browser session.`,
    ),
  );

  let progressSummary = "";
  if (getProgressSummary) {
    try {
      progressSummary = (await getProgressSummary()) || "";
    } catch {
      progressSummary = "";
    }
  }

  // Keep the copilot365-specific event for backward compatibility
  if (providerName === "copilot365") {
    eventBus.emit("copilot365_segment_boundary", {
      segmentIndex,
      previousMessageCount,
      gitDiffStat: progressSummary,
      timestamp: new Date().toISOString(),
    });
  }

  await closeAutomationApi(automationState);
  automationState.messageCount = 0;

  const newPayload = injectRotationHandoff(
    payload,
    automationState.lastResponseText,
    { segmentIndex, progressSummary, providerName },
  );
  automationState.lastResponseText = "";

  return newPayload;
}
