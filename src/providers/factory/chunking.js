import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function sendWithChunking({
  remoteSessionId,
  promptText,
  label,
  chunkSize,
  send,
}) {
  if (promptText.length <= chunkSize) {
    return send(remoteSessionId, promptText, label);
  }

  const chunks = [];
  for (let i = 0; i < promptText.length; i += chunkSize) {
    chunks.push(promptText.slice(i, i + chunkSize));
  }

  log(
    colors.cyan(
      `\n  [Automation API] Sending '${label}' in ${chunks.length} chunks...`,
    ),
  );

  for (let i = 0; i < chunks.length - 1; i++) {
    const chunkMsg = `[PART ${i + 1}/${chunks.length}] Context delivery — part ${
      i + 1
    } of ${chunks.length}. Reply only with "ACK PART ${i + 1}":\n\n${chunks[i]}`;

    await send(
      remoteSessionId,
      chunkMsg,
      `${label} [${i + 1}/${chunks.length}]`,
    );
  }

  const finalMsg = `[PART ${chunks.length}/${chunks.length} — FINAL] All context delivered. Now proceed:\n\n${
    chunks[chunks.length - 1]
  }`;

  return send(remoteSessionId, finalMsg, `${label} [final]`);
}
