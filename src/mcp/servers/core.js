import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import process from "node:process";

import { searchTools } from "../../agent/tools/definitions/search.js";
import { databaseTools } from "../../agent/tools/definitions/database.js";
import { httpTools } from "../../agent/tools/definitions/http.js";

import { executeSearchTool } from "../../agent/tools/search.js";
import { executeDatabaseTool } from "../../agent/tools/database/executor.js";
import { executeHttpTool } from "../../agent/tools/http.js";

const server = new Server(
  { name: "mcp-server-core", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allDefinitions = { ...searchTools, ...databaseTools, ...httpTools };
  const tools = Object.entries(allDefinitions).map(([name, toolDef]) => ({
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
    let result;
    if (name in searchTools) {
      result = await executeSearchTool(name, args, context);
    } else if (name in databaseTools) {
      result = await executeDatabaseTool(name, args, context);
    } else if (name in httpTools) {
      result = await executeHttpTool(name, args, context);
    }

    if (result === undefined) {
      throw new Error(`Tool ${name} not handled by core server.`);
    }

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
