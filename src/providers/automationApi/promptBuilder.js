import { getToolDescriptions } from "../../agent/tools/sdkRegistry.js";

export async function buildApiPrompt(payload) {
  let messages = payload;
  if (typeof payload === "string") {
    messages = [{ role: "user", content: payload }];
  }

  const toolsStr = await getToolDescriptions();

  return messages
    .map((m) => {
      let content = m.content;
      if (m.role === "system") {
        content +=
          "\n\nAVAILABLE TOOLS:\n" +
          toolsStr +
          '\n\nTo use a tool, YOU MUST output a JSON array of objects inside a code block. Example:\n[\n  {"tool": "read_file", "parameters": {"path": "/foo"}}\n]';
      }
      return `[${m.role.toUpperCase()}]\n${content}`;
    })
    .join("\n\n---\n\n");
}
