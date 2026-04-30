import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export function logPrompt(promptText) {
  const head = promptText.slice(0, 1500);
  const tail = promptText.slice(-500);
  const mid =
    promptText.length > 2000
      ? `\n  ...[${promptText.length - 2000} chars omitted]...\n`
      : "";
  log(
    colors.dim(
      `  [→ PROMPT (${promptText.length} chars)]\n${head}${mid}${tail}`,
    ),
  );
}

export function logResponse(label, responseText) {
  log(
    colors.dim(
      `  [← RESPONSE '${label}' (${responseText.length} chars)]\n${responseText}`,
    ),
  );
}
