import { randomUUID } from "node:crypto";
import { eventBus } from "./eventBus.js";
import { waitForResponse, HUMAN_RESPONSE_TIMEOUT_MS } from "./ws/prompts.js";

function handleResponse(res) {
  if (
    res === "CANCELLED_BY_SYSTEM" ||
    res?.value === "CANCELLED_BY_SYSTEM" ||
    res?.action === "cancel"
  ) {
    return "BACK";
  }
  // Timed out waiting for human — treat as empty/done (same as pressing Enter).
  if (res?.action === "timeout") {
    return "";
  }
  return res?.value ?? res;
}

export async function createRequest(type, data, timeout = HUMAN_RESPONSE_TIMEOUT_MS) {
  const requestId = randomUUID();
  eventBus.emit(type, { requestId, ...data });
  const response = await waitForResponse(requestId, timeout);
  return handleResponse(response);
}

// Setup wizard prompts — no timeout (human must choose before proceeding).
export const webPromptProjects = (projects) =>
  createRequest("prompt_projects", { projects }, 0);
export const webPromptProvider = (options) =>
  createRequest("prompt_provider", { options }, 0);
export const webPromptSessions = (projectId, sessions) =>
  createRequest("prompt_sessions", { projectId, sessions }, 0);
export const webPromptTabs = (
  matchedPages,
  allPagesData,
  providerName,
  fallbackUrl,
) =>
  createRequest(
    "prompt_tabs",
    { matchedPages, allPagesData, providerName, fallbackUrl },
    0,
  );

// In-session prompts — auto-continue after 5 min if no human response.
export const webPromptFeedback = (message) =>
  createRequest("prompt_feedback", { message }, HUMAN_RESPONSE_TIMEOUT_MS);
export const webPromptText = (question, extra = {}) =>
  createRequest("prompt_text", { question, ...extra }, HUMAN_RESPONSE_TIMEOUT_MS);
export const webPromptChoice = (question, options) =>
  createRequest("prompt_choice", { question, options }, HUMAN_RESPONSE_TIMEOUT_MS);
export const webScopingMessage = (message, turn) =>
  createRequest("prompt_scoping_message", { message, turn }, HUMAN_RESPONSE_TIMEOUT_MS);
export const webScopingApproval = (scopeDoc) =>
  createRequest("scoping_complete", { scopeDoc }, HUMAN_RESPONSE_TIMEOUT_MS);
