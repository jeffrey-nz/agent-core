import {
  applyWriteFiles,
  buildNeedFilesFollowUp,
  buildJsonToolsFollowUp,
} from "../actions.js";

export async function handleFileWrites({ fileWrites, toolContext, toolCalls }) {
  return applyWriteFiles({ fileWrites, toolContext, toolCalls });
}

export async function handleFileRequests({
  fileRequests,
  toolContext,
  send,
  remoteSessionId,
  label,
  step,
  onLogResponse,
}) {
  const followUp = await buildNeedFilesFollowUp({
    fileRequests,
    toolContext,
  });

  const response = await send(
    remoteSessionId,
    followUp,
    `${label} [files step ${step}]`,
  );

  onLogResponse(`${label} [files ${step}]`, response);
  return response;
}

export async function handleJsonTools({
  jsonToolCalls,
  toolContext,
  toolCalls,
  send,
  remoteSessionId,
  label,
  step,
  onLogResponse,
}) {
  const followUp = await buildJsonToolsFollowUp({
    jsonToolCalls,
    toolContext,
    toolCalls,
  });

  const response = await send(
    remoteSessionId,
    followUp,
    `${label} [tools step ${step}]`,
  );

  onLogResponse(`${label} [tools ${step}]`, response);
  return response;
}
