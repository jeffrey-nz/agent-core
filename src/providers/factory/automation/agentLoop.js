import { runAutomationAgentLoop as runInternal } from "./agentLoop/run.js";

export async function runAutomationAgentLoop(params) {
  return runInternal(params);
}
