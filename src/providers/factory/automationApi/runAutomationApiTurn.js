import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

import {
  ensureAutomationSession,
  closeAutomationSession,
} from "../automation/session.js";
import { normalizePayloadToMessages } from "../automation/messages.js";

import { buildAutomationPrompt } from "./buildPrompt.js";
import { sendAutomationTurn } from "./sendTurn.js";
import { runAutomationAgent } from "./runAgent.js";
import { isScopingTurn } from "./types.js";

export async function runAutomationApiTurn({
  providerName,
  pendingMode,
  state,
  payload,
  label,
  options = {},
}) {
  const {
    rootDir,
    ignore = [],
    interactionMode = null,
    requireWriteFile = true,
    requireTools = false,
    readOnly = false,
    allowedDirs = [],
    signal = null,
  } = options;

  const toolContext = { rootDir, ignore, allowedDirs, readOnly };
  const scoping = isScopingTurn({ interactionMode, requireWriteFile });

  await ensureAutomationSession({ state, providerName, pendingMode });

  const messages = normalizePayloadToMessages(payload);

  const promptText = await buildAutomationPrompt({
    messages,
    rootDir,
    toolContext,
    scoping,
    interactionMode,
    providerName,
  });

  let initialResponse;
  let sessionRecoveryAttempted = false;

  while (true) {
    try {
      initialResponse = await sendAutomationTurn({ state, promptText, label, signal });
      break;
    } catch (err) {
      if (err.selfHealEscape) throw err;

      if (
        err.message.startsWith("SESSION_EXPIRED") &&
        !sessionRecoveryAttempted
      ) {
        sessionRecoveryAttempted = true;
        state.remoteSessionId = null;
        await ensureAutomationSession({ state, providerName, pendingMode });
        continue;
      }

      // Network failures, timeouts, and stall auto-skips — return gracefully
      // so the calling node (e.g. coderNode) can do cleanup and retry rather
      // than hanging on a blocking UI prompt with no human present.
      log(
        colors.red(
          `  [Automation API] Turn "${label}" failed — returning failure for caller to handle: ${err.message}`,
        ),
      );
      return { ok: false, reason: err.message };
    }
  }

  if (scoping) {
    state.session?.end("scoping_complete");
    return { ok: true, text: initialResponse, toolCalls: [] };
  }

  try {
    const loopRes = await runAutomationAgent({
      state: { ...state, providerName },
      rootDir,
      toolContext,
      label,
      initialResponseText: initialResponse,
      requireWriteFile,
      requireTools,
      signal,
    });

    if (loopRes.needsRotation) {
      // Chat context overflowed mid-subtask.  Force the messageCount past the
      // rotation threshold so handleSegmentBoundary fires on the very next
      // outer turn, opening a fresh browser session.  Return SESSION_BUSY so
      // coderNode knows to set coderFailed=true and retry the subtask.
      log(
        colors.yellow(
          "  [Automation API] Chat overflow detected — forcing rotation on next turn.",
        ),
      );
      state.messageCount = 9999;
      state.session?.end("rotation_needed");
      return { ok: false, reason: "SESSION_BUSY" };
    }

    state.session?.end("completed");
    return {
      ok: true,
      text: loopRes.responseText,
      toolCalls: loopRes.toolCalls,
      modifiedFiles: loopRes.modifiedFiles,
      executionErrors: loopRes.executionErrors,
    };
  } catch (error) {
    if (error.selfHealEscape) {
      state.session?.end("self_heal_escape");
      throw error;
    }

    state.session?.end("protocol_failure");
    return { ok: false, reason: error.message };
  }
}

export async function closeAutomationApi(state) {
  await closeAutomationSession(state);
}
