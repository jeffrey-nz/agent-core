import { tool, jsonSchema } from "ai";
import { eventBus } from "#web/eventBus.js";
import { getAllToolJsonSchemas } from "./toolSchemas.js";
import { dispatchTool } from "./localDispatcher.js";

let _cachedSchemas = null;

async function getSchemas() {
  if (!_cachedSchemas) {
    _cachedSchemas = await getAllToolJsonSchemas();
  }
  return _cachedSchemas;
}

function relativizePath(p, rootDir) {
  if (!p || !rootDir) return p;
  const prefix = rootDir.endsWith("/") ? rootDir : rootDir + "/";
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function makeParamsSummary(name, args, rootDir) {
  if (!args) return "";
  const n = (name || "").toLowerCase();
  if (/write|patch|read|delete|move/.test(n))
    return relativizePath(
      String(args.path || args.file_path || args.source || ""),
      rootDir,
    );
  if (/bash|command|execute/.test(n))
    return String(args.command || "").slice(0, 80);
  if (/grep|search|find/.test(n))
    return relativizePath(
      String(args.pattern || args.query || args.path || ""),
      rootDir,
    );
  if (/list|dir/.test(n))
    return relativizePath(String(args.path || ""), rootDir);
  return "";
}

export async function getMcpBoundTools(context = {}) {
  const defs = await getSchemas();
  const boundTools = {};

  for (const [name, def] of Object.entries(defs)) {
    boundTools[name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.parameters),
      execute: async (args) => {
        const callId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const startTs = Date.now();
        eventBus.emit("tool_call_start", {
          callId,
          tool: name,
          paramsSummary: makeParamsSummary(name, args, context.rootDir),
        });

        let result;
        try {
          result = await dispatchTool(name, args, context);
        } catch (err) {
          const errText = `[ERROR] ${err.message}`;
          eventBus.emit("tool_call_end", {
            callId,
            tool: name,
            isError: true,
            result: errText,
            elapsed: Date.now() - startTs,
          });
          throw err;
        }

        const resultText =
          typeof result === "string"
            ? result
            : (result?.text ?? String(result));
        eventBus.emit("tool_call_end", {
          callId,
          tool: name,
          isError: resultText.startsWith("[ERROR]"),
          result: resultText.slice(0, 300),
          elapsed: Date.now() - startTs,
        });

        // If the tool attached an image (e.g. screenshot_url), return a multi-part
        // content array so the model can see the image directly.
        if (result?._image) {
          return [
            { type: "text",  text: result.text ?? "Result" },
            { type: "image", image: result._image.base64, mediaType: result._image.mimeType },
          ];
        }

        return result;
      },
    });
  }

  return boundTools;
}

export async function getToolDescriptions() {
  const defs = await getSchemas();
  return Object.entries(defs)
    .map(([name, def]) => `- ${name}: ${def.description}`)
    .join("\n");
}
