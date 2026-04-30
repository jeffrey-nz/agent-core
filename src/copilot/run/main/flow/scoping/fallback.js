import { executeAiTurn } from "./aiTurn.js";

export async function forceScopeGeneration(
  provider,
  projectDir,
  initialPrompt,
) {
  const { scopeDoc } = await executeAiTurn(
    provider,
    projectDir,
    "You have reached the question limit. Now produce the <scope_doc> based on what you know.",
    "Scoping — Force Finalize",
  );

  return scopeDoc || initialPrompt;
}
