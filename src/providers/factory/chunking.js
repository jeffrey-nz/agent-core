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

  // Split into chunks of chunkSize.
  const chunks = [];
  for (let i = 0; i < promptText.length; i += chunkSize) {
    chunks.push(promptText.slice(i, i + chunkSize));
  }

  // The final message prepends a "ACK PHASE COMPLETE" prefix to the last chunk.
  // If prefix + lastChunk > chunkSize, Copilot rejects it with "We are experiencing
  // an issue". Pre-trim the last chunk so the full final message fits in chunkSize.
  const finalPrefix =
    `[ACK PHASE COMPLETE — DO NOT reply with ACK]\nAll ${chunks.length - 1} context chunks have been acknowledged. Previous "Reply only: ACK N" instructions are now fully superseded — do NOT reply with ACK and do NOT ask for confirmation to proceed. Output your full response to the task below immediately:\n\n`;
  const maxLastChunkLen = chunkSize - finalPrefix.length;
  if (maxLastChunkLen > 0 && chunks[chunks.length - 1].length > maxLastChunkLen) {
    // Keep the TAIL of the last chunk (preserves copilotFinalReminder at end of prompt).
    chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(-maxLastChunkLen);
  }

  log(
    colors.cyan(
      `\n  [Automation API] Sending '${label}' in ${chunks.length} chunks...`,
    ),
  );

  // Collect <<<FILE:>>> blocks from intermediate chunk responses.
  // Copilot sometimes writes files in response to context chunks even when
  // told not to. We save those blocks and prepend them to the final response
  // so that Strategy 7 in StructuredOutputParser can extract them.
  const earlyFileBlocks = [];

  for (let i = 0; i < chunks.length - 1; i++) {
    const chunkMsg =
      `[CTX ${i + 1}/${chunks.length} — DO NOT WRITE FILES. Reply only: ACK ${i + 1}]\n\n${chunks[i]}`;

    const chunkResponse = await send(
      remoteSessionId,
      chunkMsg,
      `${label} [${i + 1}/${chunks.length}]`,
    );

    // If the provider returned a service error on an intermediate chunk, the
    // conversation history is already corrupted — abort immediately.
    if (
      typeof chunkResponse === "string" &&
      (/we are experiencing an issue/i.test(chunkResponse) ||
        /please try submitting a new message/i.test(chunkResponse))
    ) {
      log(colors.yellow(
        `  [Chunking] ${label} [${i + 1}/${chunks.length}]: service error on intermediate chunk — aborting`,
      ));
      return chunkResponse;
    }

    // If Copilot ignored the ACK instruction and wrote files, save them —
    // but discard early blocks where file content is obviously a placeholder
    // (e.g. "...full content...", "...existing code..."). These happen when
    // Copilot hits its context limit mid-chunk and writes a stub instead of
    // real content. Carrying forward a stub would overwrite the real file.
    if (typeof chunkResponse === "string" && chunkResponse.includes("<<<FILE:")) {
      const fileRe = /<<<FILE:\s*[^\n>]+?[ \t]*>>>\r?\n([\s\S]*?)(?:<<<END FILE>>>|<<<FILE:|TASK_DONE\b|$)/g;
      let hasPlaceholder = false;
      let fm;
      while ((fm = fileRe.exec(chunkResponse)) !== null) {
        const content = fm[1].trim();
        // Short content or "...text..." surrounded by triple-dots = placeholder
        if (
          content.length < 80 ||
          /^\.\.\.[^<]{0,100}\.\.\.$/s.test(content) ||
          /^\.\.\.\s*$/.test(content)
        ) {
          hasPlaceholder = true;
          break;
        }
      }
      if (hasPlaceholder) {
        log(colors.yellow(
          `  [Chunking] ${label} [${i + 1}/${chunks.length}]: Copilot wrote placeholder file content — discarding (will re-request in final chunk).`,
        ));
      } else {
        earlyFileBlocks.push(chunkResponse);
        log(colors.yellow(
          `  [Chunking] ${label} [${i + 1}/${chunks.length}]: Copilot wrote files in context chunk — will carry forward.`,
        ));
      }
    }
  }

  const finalMsg = `[ACK PHASE COMPLETE — DO NOT reply with ACK]\nAll ${chunks.length - 1} context chunks have been acknowledged. Previous "Reply only: ACK N" instructions are now fully superseded — do NOT reply with ACK and do NOT ask for confirmation to proceed. Output your full response to the task below immediately:\n\n${
    chunks[chunks.length - 1]
  }`;

  const finalResponse = await send(remoteSessionId, finalMsg, `${label} [final]`);

  // If intermediate chunks had file blocks, prepend them to the final response
  // so the agent loop can parse them alongside any files from the final response.
  if (earlyFileBlocks.length > 0) {
    const combined = earlyFileBlocks.join("\n") + "\n" + (finalResponse || "");
    log(colors.yellow(
      `  [Chunking] ${label}: prepending ${earlyFileBlocks.length} early chunk response(s) with file blocks to final.`,
    ));
    return combined;
  }

  return finalResponse;
}
