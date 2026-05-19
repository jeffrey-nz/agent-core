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
  if (/screenshot|inspect_page|click_element|wait_for_selector|evaluate_js/.test(n))
    return String(args.url || "").replace(/^https?:\/\/localhost:\d+/, "localhost").slice(0, 60);
  if (/start_dev_server/.test(n))
    return args.project_dir ? relativizePath(String(args.project_dir), rootDir) : "dev server";
  if (/stop_dev_server/.test(n))
    return args.pid ? `pid ${args.pid}` : "dev server";
  if (/get_dev_server_logs/.test(n))
    return args.pid ? `logs pid ${args.pid}` : "dev server logs";
  if (/git_commit/.test(n))
    return String(args.message || "commit").slice(0, 60);
  if (/git_push/.test(n))
    return args.branch ? `→ ${args.branch}` : `→ ${args.remote || "origin"}`;
  if (/git_branch/.test(n))
    return String(args.name || "branch");
  if (/git_diff/.test(n))
    return args.path ? relativizePath(String(args.path), rootDir) : "working tree";
  if (/git_inspect/.test(n))
    return "status + diff";
  if (/git_/.test(n))
    return String(args.branch || args.name || args.message || "").slice(0, 40);
  if (/http_request/.test(n))
    return String(args.url || args.path || "").replace(/^https?:\/\/localhost:\d+/, "localhost").slice(0, 60);
  if (/memory_/.test(n))
    return String(args.key || args.name || "").slice(0, 40);
  if (/github_create_issue/.test(n))
    return String(args.title || "issue").slice(0, 50);
  if (/github_update_issue/.test(n))
    return args.issue_number ? `#${args.issue_number}${args.close ? " (close)" : ""}` : "issue";
  if (/github_get_issues/.test(n))
    return args.label ? `label:${args.label}` : "open issues";
  if (/docs_write_page/.test(n))
    return String(args.page || "page").slice(0, 40);
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
            errorSummary: err.message?.slice(0, 120) ?? "",
            elapsed: Date.now() - startTs,
          });
          throw err;
        }

        const resultText =
          typeof result === "string"
            ? result
            : (result?.text ?? String(result));
        const isError = resultText.startsWith("[ERROR]") || result?.ok === false;
        eventBus.emit("tool_call_end", {
          callId,
          tool: name,
          isError,
          result: resultText.slice(0, 300),
          ...(isError && result?.errorSummary ? { errorSummary: result.errorSummary } : {}),
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
