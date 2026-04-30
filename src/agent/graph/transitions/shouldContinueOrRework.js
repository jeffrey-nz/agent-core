import { END } from "@langchain/langgraph";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export function shouldContinueOrRework(state) {
  if (state.verificationFeedback === "APPROVED") {
    log(colors.green("  [Graph] -> Code Approved!"));
    return END;
  }

  log(colors.yellow("  [Graph] -> Verification failed. Reworking..."));
  return "coder";
}
