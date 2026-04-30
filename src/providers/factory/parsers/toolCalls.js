import { StructuredOutputParser } from "../../structuredOutputParser.js";

const parser = new StructuredOutputParser();

export function parseToolCalls(text) {
  const result = parser.parse(text);
  return {
    toolCalls: result.success ? result.actions : [],
    parseError: result.error ? result.error : null
  };
}
