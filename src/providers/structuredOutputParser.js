import { jsonrepair } from "jsonrepair";

// Strip <think>...</think> and <tool-plan>...</tool-plan> blocks before parsing.
// These reasoning blocks are for the model's internal use and don't contain tool calls.
function stripReasoningBlocks(text) {
  if (!text) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<tool-plan>[\s\S]*?<\/tool-plan>/gi, "");
}

function normalizeToolCall(tc) {
  const toolName =
    tc.tool ||
    tc.name ||
    (typeof tc.action === "string" ? tc.action : null);
  if (!toolName) return null;
  return { ...tc, tool: toolName };
}

function tryParseArray(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findMatchingClose(text, startIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractCodeBlockArrays(text) {
  const results = [];
  let pos = 0;
  while (pos < text.length) {
    const fenceStart = text.indexOf("```", pos);
    if (fenceStart === -1) break;
    const afterFence = fenceStart + 3;
    const lineEnd = text.indexOf("\n", afterFence);
    const contentStart = lineEnd === -1 ? afterFence : lineEnd + 1;
    const fenceEnd = text.indexOf("```", contentStart);
    if (fenceEnd === -1) break;
    const blockContent = text.substring(contentStart, fenceEnd).trim();
    let parsed = tryParseArray(blockContent);
    if (!parsed) {
      try { parsed = tryParseArray(jsonrepair(blockContent)); } catch {}
    }
    if (parsed) results.push(...parsed);
    pos = fenceEnd + 3;
  }
  return results;
}

// Strategy 5 helper: find code blocks whose content is a single JSON object (not an array).
// Wraps in [...] and parses so a model that outputs one tool call object still works.
function extractCodeBlockObjects(text) {
  const results = [];
  let pos = 0;
  while (pos < text.length) {
    const fenceStart = text.indexOf("```", pos);
    if (fenceStart === -1) break;
    const afterFence = fenceStart + 3;
    const lineEnd = text.indexOf("\n", afterFence);
    const contentStart = lineEnd === -1 ? afterFence : lineEnd + 1;
    const fenceEnd = text.indexOf("```", contentStart);
    if (fenceEnd === -1) break;
    const blockContent = text.substring(contentStart, fenceEnd).trim();
    // Only attempt object-wrap if the block starts with { (not an array — strategy 2 handles those)
    if (blockContent.startsWith("{")) {
      const parsed = tryParseArray(`[${blockContent}]`);
      if (parsed) results.push(...parsed);
    }
    pos = fenceEnd + 3;
  }
  return results;
}

export class StructuredOutputParser {
  parse(rawText) {
    const toolCalls = [];
    if (!rawText) return { success: false, actions: [], error: "No text to parse" };

    // Strip reasoning blocks before parsing — <think>, <thinking>, <tool-plan>
    // are for the model's internal reasoning and don't contain tool calls.
    const text = stripReasoningBlocks(rawText);

    // Strategy 0: TASK_DONE / [] — explicit completion signals.
    // TASK_DONE is the new preferred signal. [] is kept for backwards compatibility.
    // Only apply when no JSON tool-call object is present AND no <<<FILE:>>> blocks
    // (Copilot uses <<<FILE:>>> instead of JSON tool calls — Strategy 7 handles those).
    const hasToolCallObject = /"tool"\s*:/.test(text) || /"name"\s*:/.test(text);
    const hasCopilotFileBlocks = text.includes("<<<FILE:");
    if (!hasToolCallObject && !hasCopilotFileBlocks && (/\bTASK_DONE\b/.test(text) || /\[\s*\]/.test(text))) {
      return { success: true, actions: [], error: null };
    }

    // Strategy 1: first "[{" to last "]"
    let startIdx = -1;
    let closingBracket = -1;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const bracketIdx = text.indexOf("[", searchFrom);
      if (bracketIdx === -1) break;
      const rest = text.slice(bracketIdx + 1).trimStart();
      if (rest.startsWith("{") || rest.startsWith("]")) {
        startIdx = bracketIdx;
        break;
      }
      searchFrom = bracketIdx + 1;
    }

    if (startIdx !== -1) {
      // Use bracket-depth walk to find the correct closing ] rather than lastIndexOf,
      // which would stop at a ] inside a content string (e.g. TypeScript array literals).
      closingBracket = findMatchingClose(text, startIdx);
      const endIdx = closingBracket !== -1 ? closingBracket : text.lastIndexOf("]");
      if (endIdx > startIdx) {
        const candidate = text.substring(startIdx, endIdx + 1);
        let parsed = tryParseArray(candidate);
        if (!parsed) {
          try { parsed = tryParseArray(jsonrepair(candidate)); } catch {}
        }
        if (parsed) {
          for (const tc of parsed) {
            const norm = normalizeToolCall(tc);
            if (norm) toolCalls.push(norm);
          }
          if (toolCalls.length > 0) {
            return { success: true, actions: toolCalls, error: null };
          }
        }
      }
    }

    // Strategy 2: scan all ``` code blocks
    const codeBlockCalls = extractCodeBlockArrays(text);
    if (codeBlockCalls.length > 0) {
      for (const tc of codeBlockCalls) {
        const norm = normalizeToolCall(tc);
        if (norm) toolCalls.push(norm);
      }
      if (toolCalls.length > 0) {
        return { success: true, actions: toolCalls, error: null };
      }
    }

    // Strategy 3: bracket-depth walk to isolate first valid array
    let depthStart = -1;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "[") {
        if (depth === 0) depthStart = i;
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0 && depthStart !== -1) {
          const candidate = text.substring(depthStart, i + 1);
          const parsed = tryParseArray(candidate);
          if (parsed) {
            for (const tc of parsed) {
              const norm = normalizeToolCall(tc);
              if (norm) toolCalls.push(norm);
            }
            if (toolCalls.length > 0) {
              return { success: true, actions: toolCalls, error: null };
            }
          }
          depthStart = -1;
        }
      }
    }

    // Strategy 4: single JSON object — find the first { ... } and wrap in an array.
    // Handles automation API responses that output one tool call as a bare object
    // instead of a one-element array.
    const firstBrace = text.indexOf("{");
    if (firstBrace !== -1) {
      const closeBraceIdx = findMatchingClose(text, firstBrace);
      if (closeBraceIdx !== -1) {
        const candidate = text.substring(firstBrace, closeBraceIdx + 1);
        const parsed = tryParseArray(`[${candidate}]`);
        if (parsed) {
          for (const tc of parsed) {
            const norm = normalizeToolCall(tc);
            if (norm) toolCalls.push(norm);
          }
          if (toolCalls.length > 0) {
            return { success: true, actions: toolCalls, error: null };
          }
        }
      }
    }

    // Strategy 5: code-block object — scan ``` blocks whose content is a single object.
    const codeBlockObjects = extractCodeBlockObjects(text);
    if (codeBlockObjects.length > 0) {
      for (const tc of codeBlockObjects) {
        const norm = normalizeToolCall(tc);
        if (norm) toolCalls.push(norm);
      }
      if (toolCalls.length > 0) {
        return { success: true, actions: toolCalls, error: null };
      }
    }

    // Strategy 6: jsonrepair — fix malformed JSON (unescaped quotes, trailing commas, etc.)
    // Most parse-error recovery loops are caused by unescaped " inside code content strings.
    // jsonrepair uses structural look-ahead to fix these without mangling the content.
    // Only attempt on the first [...] candidate or the whole text if no bracket was found.
    const repairTarget = startIdx !== -1 ? text.substring(startIdx, (closingBracket !== -1 ? closingBracket : text.lastIndexOf("]")) + 1) : text;
    if (repairTarget) {
      try {
        const repaired = jsonrepair(repairTarget);
        const parsed = tryParseArray(repaired);
        if (parsed) {
          for (const tc of parsed) {
            const norm = normalizeToolCall(tc);
            if (norm) toolCalls.push(norm);
          }
          if (toolCalls.length > 0) {
            return { success: true, actions: toolCalls, error: null };
          }
        }
      } catch {
        // jsonrepair can't fix everything — fall through to final error.
      }
    }

    // Strategy 7: <<<FILE: path>>> ... <<<END FILE>>> blocks — Copilot-native format.
    // Copilot may omit <<<END FILE>>> or put the content on the same line as >>>.
    // Three passes to maximise compatibility:
    //   7a. strict: <<<END FILE>>> terminator present
    //   7b. relaxed: terminated by next <<<FILE:, TASK_DONE, or end-of-string
    //   7c: content on the same line as the >>> (no newline)
    if (text.includes("<<<FILE:")) {
      const fileBlocks = [];
      // Reject paths that are clearly placeholders: "...", relative, or non-absolute.
      const isPlaceholderPath = (fp) =>
        !fp || !fp.startsWith("/") || /^\.*$/.test(fp) || fp.trim() === "...";

      // Strip a leading and/or trailing markdown code fence wrapping the file body.
      // The chat-UI-friendly prompt asks the AI to wrap content in ```...``` so the
      // markdown renderer keeps indentation intact. The fences themselves must not
      // end up on disk — strip exactly one outer pair if present.
      const stripFences = (s) => {
        if (typeof s !== "string") return s;
        let out = s;
        // Leading ```optional-language\n
        out = out.replace(/^[ \t]*```[a-zA-Z0-9_+-]*\r?\n/, "");
        // Trailing \n?```
        out = out.replace(/\r?\n[ \t]*```[ \t]*\r?\n?$/, "\n");
        return out;
      };

      // 7a: strict — <<<END FILE>>> present
      {
        const re = /<<<FILE:\s*([^\n>]+?)[ \t]*>>>\r?\n([\s\S]*?)<<<END FILE>>>/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const fp = m[1].trim();
          if (fp && !isPlaceholderPath(fp)) fileBlocks.push({ tool: "write_file", path: fp, content: stripFences(m[2]) });
        }
      }

      // 7b: relaxed — no <<<END FILE>>>, terminated by next block or TASK_DONE
      if (fileBlocks.length === 0) {
        const re = /<<<FILE:\s*([^\n>]+?)[ \t]*>>>\r?\n([\s\S]*?)(?=<<<FILE:|TASK_DONE\b|$)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const fp = m[1].trim();
          const content = stripFences(m[2].replace(/\n?<<<END FILE>>>\s*$/, "").replace(/\n?TASK_DONE\s*$/, ""));
          if (fp && content && !isPlaceholderPath(fp)) fileBlocks.push({ tool: "write_file", path: fp, content });
        }
      }

      // 7c: content on same line as >>> (Copilot sometimes skips the newline)
      if (fileBlocks.length === 0) {
        const re = /<<<FILE:\s*([^\n>]+?)[ \t]*>>>[ \t]+([^\n].+?)(?:<<<END FILE>>>|TASK_DONE\b|$)/gs;
        let m;
        while ((m = re.exec(text)) !== null) {
          const fp = m[1].trim();
          if (fp && !isPlaceholderPath(fp)) fileBlocks.push({ tool: "write_file", path: fp, content: stripFences(m[2]) });
        }
      }

      if (fileBlocks.length > 0) {
        return { success: true, actions: fileBlocks, error: null };
      }
    }

    return { success: false, actions: [], error: "No valid tool call array found" };
  }
}
