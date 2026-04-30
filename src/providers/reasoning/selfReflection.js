import { StructuredOutputParser } from "../structuredOutputParser.js";
import { validateAction } from "../actionValidator.js";
import { log } from "#app/ui/log.js";

const parser = new StructuredOutputParser();

export async function withReflection(provider, originalPayload, options = {}, maxRetries = 3) {
  let lastError = null;
  let currentPayload = originalPayload;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`[SelfReflection] Attempt ${attempt}/${maxRetries}`);

    const result = await provider.sendTurn(currentPayload, "reflection-attempt", options);

    if (!result.ok) {
      lastError = result.reason || "Provider returned error";
      if (attempt === maxRetries) {
        throw new Error(`Invalid AI response after ${maxRetries} retries: ${lastError}`);
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    const parsed = parser.parse(result.text);
    if (!parsed.success) {
      lastError = parsed.error;
      log(`[SelfReflection] Parse failed (attempt ${attempt}): ${parsed.error}`);
      if (attempt === maxRetries) {
        throw new Error(`Invalid AI response after ${maxRetries} retries: ${lastError}`);
      }
      currentPayload = `The previous response was invalid because: ${parsed.error}. Please provide a corrected action. Original task: ${originalPayload}`;
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }

    let allValid = true;
    for (const action of parsed.actions) {
      const validation = validateAction(action);
      if (!validation.valid) {
        allValid = false;
        lastError = validation.errors?.message || "Action validation failed";
        log(`[SelfReflection] Validation failed (attempt ${attempt}): ${lastError}`);
        break;
      }
    }

    if (allValid) {
      log(`[SelfReflection] Success on attempt ${attempt}`);
      return result;
    }

    if (attempt === maxRetries) {
      throw new Error(`Invalid AI response after ${maxRetries} retries: ${lastError}`);
    }

    currentPayload = `The previous response had invalid actions: ${lastError}. Please provide corrected browser actions. Original task: ${originalPayload}`;
    const delayMs = 1000 * Math.pow(2, attempt - 1);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error(`Invalid AI response after ${maxRetries} retries: ${lastError}`);
}
