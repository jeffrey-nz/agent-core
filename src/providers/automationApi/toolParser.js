export function parseApiResponseTools(responseText) {
  const toolCalls = [];
  if (!responseText) return toolCalls;

  const firstBracket = responseText.indexOf("[");
  const lastBracket = responseText.lastIndexOf("]");

  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try {
      const jsonStr = responseText.substring(firstBracket, lastBracket + 1);
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        toolCalls.push(...parsed);
      }
    } catch (err) {}
  }

  for (const tc of toolCalls) {
    if (tc.action && !tc.tool && !tc.name) {
      tc.tool = tc.action;
    }
  }

  return toolCalls;
}
