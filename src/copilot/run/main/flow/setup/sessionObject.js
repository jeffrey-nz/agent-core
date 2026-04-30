export function createSessionObject(provider, gitDir) {
  return {
    copilot: {
      sendPromptAndWait: (text, label) => provider.sendTurn(text, label),
      providerName: provider.providerName,
    },
    gitDir,
    close: async () => {
      if (provider.close) {
        await provider.close();
      }
    },
  };
}
