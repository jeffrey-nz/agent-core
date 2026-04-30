import { parseToolCalls } from "../../parsers/toolCalls.js";

export function parseAgentStep(responseText) {
  const { toolCalls: jsonToolCalls, parseError } = parseToolCalls(responseText);

  const hasActivity = jsonToolCalls.length > 0;

  return {
    fileRequests: [],
    fileWrites: [],
    invalidWrites: [],
    jsonToolCalls,
    hasActivity,
    parseError: hasActivity ? null : parseError,
  };
}
