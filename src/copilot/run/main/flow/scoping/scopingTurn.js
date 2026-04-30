import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { executeAiTurn } from "./aiTurn.js";
import { rateLimitCooldown } from "../rateLimitCooldown.js";

const MAX_ROTATIONS = 3;

export async function runScopingTurn({
  provider,
  targetRepoDir,
  prompt,
  label,
}) {
  let rotations = 0;

  while (true) {
    try {
      return await executeAiTurn(provider, targetRepoDir, prompt, label);
    } catch (err) {
      if (err.isRateLimit) {
        await rateLimitCooldown(err.reason);
        continue;
      }

      if (err.needsRotation) {
        rotations++;
        if (rotations >= MAX_ROTATIONS) {
          throw new Error(
            `Scoping turn failed after ${MAX_ROTATIONS} retries: ${err.message}`,
          );
        }
        log(
          colors.yellow(
            `\n⚠️ Provider produced incompatible output — restarting chat (attempt ${rotations}/${MAX_ROTATIONS})...`,
          ),
        );
        await provider.startNewChat();
        continue;
      }

      throw err;
    }
  }
}
