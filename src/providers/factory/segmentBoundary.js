import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { closeAutomationApi } from "./automationApiTurn.js";
import { injectRotationHandoff } from "./rotation.js";

export async function handleSegmentBoundary({
  providerName,
  automationState,
  getProgressSummary,
  payload,
}) {
  const ROTATION_THRESHOLD = providerName === "copilot365" ? 15 : 32;

  if (
    providerName !== "copilot365" ||
    !automationState.remoteSessionId ||
    automationState.messageCount < ROTATION_THRESHOLD
  ) {
    return payload;
  }

  const previousMessageCount = automationState.messageCount;
  automationState.segmentIndex += 1;
  const segmentIndex = automationState.segmentIndex;

  log(
    colors.yellow(
      `  [Segment] Copilot 365 session ${segmentIndex - 1} had ${previousMessageCount} messages — starting segment ${segmentIndex} in fresh browser session.`,
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

  eventBus.emit("copilot365_segment_boundary", {
    segmentIndex,
    previousMessageCount,
    gitDiffStat: progressSummary,
    timestamp: new Date().toISOString(),
  });

  await closeAutomationApi(automationState);
  automationState.messageCount = 0;

  const newPayload = injectRotationHandoff(
    payload,
    automationState.lastResponseText,
    { segmentIndex, progressSummary },
  );
  automationState.lastResponseText = "";

  return newPayload;
}
