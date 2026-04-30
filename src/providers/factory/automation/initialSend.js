export async function sendInitialAutomationPrompt({
  remoteSessionId,
  promptText,
  label,
  chunkSize,
  sendWithChunking,
  send,
}) {
  return await sendWithChunking({
    remoteSessionId,
    promptText,
    label,
    chunkSize,
    send,
  });
}
