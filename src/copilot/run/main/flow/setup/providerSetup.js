import { configureWorkspace } from "./workspace.js";
import { createProvider } from "#providers/factory.js";
import { getReasoningMode } from "#config/reasoningConfig.js";

export async function setupProviderAndSession(options, gitDir) {
  await configureWorkspace(options, gitDir);
  const reasoningMode = options.reasoningMode || getReasoningMode() || "none";
  const provider = await createProvider(options.providerName, { mode: options.providerMode, reasoningMode });
  if (options.providerMode) await provider.setMode(options.providerMode);

  if (options.sessionInfo.isNew && options.sessionInfo.status !== "scoping") {
    await provider.startNewChat();
  }

  const session = {
    provider,
    gitDir,
    close: async () => {
      if (provider.close) {
        await provider.close();
      }
    },
  };

  return { provider, session };
}
