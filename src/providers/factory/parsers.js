export function parseToolCalls(text) {
  const toolCalls = [];
  if (!text) return toolCalls;

  let searchStartIndex = 0;

  while (true) {
    const blockStart = text.indexOf("```", searchStartIndex);
    if (blockStart === -1) break;

    let contentStart = text.indexOf("\n", blockStart);
    if (contentStart === -1) {
      contentStart = blockStart + 3;
    }

    const blockEnd = text.indexOf("```", contentStart);
    if (blockEnd === -1) break;

    const blockContent = text.substring(contentStart, blockEnd).trim();

    const firstBracket = blockContent.indexOf("[");
    const lastBracket = blockContent.lastIndexOf("]");

    if (
      firstBracket !== -1 &&
      lastBracket !== -1 &&
      lastBracket > firstBracket
    ) {
      const jsonStr = blockContent.substring(firstBracket, lastBracket + 1);

      try {
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          toolCalls.push(...parsed);
        }
      } catch (err) {}
    }

    searchStartIndex = blockEnd + 3;
  }

  return toolCalls;
}
