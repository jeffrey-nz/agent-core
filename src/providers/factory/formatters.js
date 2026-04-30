const PER_TOOL_OUTPUT_LIMIT = 4000;
const TOTAL_PAYLOAD_LIMIT = 24000;

export function formatToolResults(results) {
  const parts = results.map(
    ({ tool, parameters, result }) =>
      `TOOL: ${tool}\nINPUT: ${JSON.stringify(
        parameters,
        null,
        2,
      )}\nOUTPUT:\n${String(result).slice(0, PER_TOOL_OUTPUT_LIMIT)}`,
  );

  const body = parts.join("\n\n---\n\n");
  const truncatedBody =
    body.length > TOTAL_PAYLOAD_LIMIT
      ? body.slice(0, TOTAL_PAYLOAD_LIMIT) +
        `\n\n[...${body.length - TOTAL_PAYLOAD_LIMIT} chars truncated to keep context window small]`
      : body;

  return `[TOOL RESULTS]
The following tools were executed:

${truncatedBody}

Continue with the task. Call more tools if needed, or summarize what was done if complete.`;
}
