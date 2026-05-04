import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";
import { closeAutomationApi } from "./automationApiTurn.js";
import { injectRotationHandoff } from "./rotation.js";

// Raised thresholds so coders have more room within a single session.
// A typical subtask uses 4-8 messages: initial prompt + reads + write batch + verify.
// Old: 15 (copilot365), 20 (deepseek). New: 22 / 30.
export const ROTATION_THRESHOLDS = {
  copilot365: 22,
  deepseek: 30,
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

  // Defer rotation when a subtask is actively in-flight (coderNode running).
  // Rotating mid-subtask loses all accumulated file context and forces the coder
  // to start the subtask from scratch in a new session. Only rotate at subtask
  // boundaries — allow up to 5 extra messages before forcing rotation anyway.
  if (
    automationState.subtaskActive &&
    automationState.messageCount < rotationThreshold + 5
  ) {
    log(
      colors.dim(
        `  [Segment] Deferring rotation — subtask is active (${automationState.messageCount}/${rotationThreshold + 5} messages).`,
      ),
    );
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

  const sessionCtx = automationState.sessionContext;
  const subtasks = sessionCtx?.subtasks;
  const currentIdx = sessionCtx?.currentSubtaskIndex ?? 0;

  // Emit for all providers so the UI can show a rich handoff card
  eventBus.emit("session_handoff", {
    segmentIndex,
    previousMessageCount,
    threshold: rotationThreshold,
    providerName,
    gitDiffStat: progressSummary,
    timestamp: new Date().toISOString(),
    projectGoal: sessionCtx?.projectGoal,
    subtasks: subtasks?.map((s) => ({ id: s.id, task: s.task, files: s.files })),
    currentSubtaskIndex: currentIdx,
    allModifiedFiles: sessionCtx?.allModifiedFiles,
  });

  // Keep legacy event for copilot365 for backwards compatibility
  if (providerName === "copilot365") {
    eventBus.emit("copilot365_segment_boundary", {
      segmentIndex,
      previousMessageCount,
      threshold: rotationThreshold,
      providerName,
      gitDiffStat: progressSummary,
      timestamp: new Date().toISOString(),
    });
  }

  await closeAutomationApi(automationState);
  automationState.messageCount = 0;

  const newPayload = injectRotationHandoff(
    payload,
    automationState.lastResponseText,
    { segmentIndex, progressSummary, providerName, sessionContext: sessionCtx },
  );
  automationState.lastResponseText = "";

  return newPayload;
}
