export function applyCoT(userPrompt, context = {}) {
  const reasoningPrefix = `Let me think step by step. First, I need to understand the task: ${userPrompt}\n\nReasoning: Based on the task, I need to determine the appropriate browser action (click, type, or navigate). I will analyze the required selector, value, and any wait conditions.\n\nTherefore, my action will be:\n`;
  return reasoningPrefix + userPrompt;
}
