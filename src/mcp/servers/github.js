import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import process from "node:process";

import { githubTools } from "../../agent/tools/definitions/github.js";
import { executeGithubTool } from "../../agent/tools/github/executor.js";

const server = new Server(
  { name: "mcp-server-github", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = Object.entries(githubTools).map(([name, toolDef]) => ({
    name,
    description: toolDef.description,
    inputSchema: zodToJsonSchema(toolDef.parameters),
  }));
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const context = {
    rootDir: args.__context_rootDir || process.cwd(),
    ignore: args.__context_ignore || [],
  };

  delete args.__context_rootDir;
  delete args.__context_ignore;

  try {
    const result = await executeGithubTool(name, args, context);
    if (result === undefined)
      throw new Error(`Tool ${name} not found in GitHub executor.`);
    return { content: [{ type: "text", text: String(result) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `[ERROR] ${error.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
