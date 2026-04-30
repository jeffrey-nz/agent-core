import { streamText } from "ai";
import { getMcpBoundTools } from "../agent/tools/sdkRegistry.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";

async function executeStream(model, messages, options) {
  const { textStream, toolCalls } = streamText({
    model,
    messages,
    tools: await getMcpBoundTools(options),
    maxSteps: 5,
  });

  let fullText = "";
  for await (const textPart of textStream) {
    fullText += textPart;
    eventBus.emit("message_chunk", { chunk: textPart });
    if (options.onChunk && typeof options.onChunk === 'function') {
      options.onChunk(textPart);
    }
  }

  const resolvedTools = await toolCalls;
  return { fullText, resolvedTools };
}

export async function executeVercelTurn(
  model,
  providerName,
  payload,
  label,
  options = {},
) {
  try {
    if (!model) {
      log(colors.red(`[Vercel SDK Error] No model returned for provider '${providerName}' — check API key env var`));
      return { ok: false, reason: `No model for provider '${providerName}' (API key missing?)` };
    }

    log(
      colors.cyan(`\n[Vercel SDK] Streaming turn '${label}' → ${providerName}`),
    );

    let messages = payload;
    if (typeof payload === "string") {
      messages = [{ role: "user", content: payload }];
    }

    const result = await executeStream(model, messages, options);

    return { ok: true, text: result.fullText, toolCalls: result.resolvedTools };
  } catch (error) {
    log(colors.red(`[Vercel SDK Error] ${error.message}`));
    return { ok: false, reason: error.message };
  }
}
