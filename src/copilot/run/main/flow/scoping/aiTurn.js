import process from "node:process";

const SCOPE_DOC_RE = /<scope_doc>([\s\S]*?)<\/scope_doc>/i;

// Detect scope docs that are just the template echoed back with unfilled placeholders.
// Matches lines containing only a bracketed placeholder like "[To be determined...]".
const PLACEHOLDER_LINE_RE = /^\s*\[(?:To be determined|One-sentence summary|Concrete,?\s*numbered|What NOT to|How we (?:know|verify)|Numbered,?\s*concrete)[^\]]*\]\s*$/im;

function isTemplateScopeDoc(content) {
  return PLACEHOLDER_LINE_RE.test(content);
}

export async function executeAiTurn(provider, projectDir, promptText, label) {
  const messages = [
    {
      role: "system",
      content: `[SCOPING ASSISTANT — REQUIREMENTS GATHERING]
You are NOT in execution mode.
DO NOT output JSON tool calls.
DO NOT write files.

Your job is to analyze, ask questions, or output a scope document.

Project directory: ${projectDir || process.cwd()}`,
    },
    {
      role: "user",
      content: promptText,
    },
  ];

  const res = await provider.sendTurn(messages, label, {
    rootDir: projectDir || process.cwd(),
    interactionMode: "scoping",
    requireWriteFile: false,
  });

  if (!res?.ok) {
    const err = new Error(
      `Scoping turn failed: ${res?.reason || "unknown error"}`,
    );
    err.isRateLimit = res?.isRateLimit === true;
    err.needsRotation = res?.needsRotation === true;
    err.reason = res?.reason;
    throw err;
  }

  const text = res.text || "";

  // Empty response means the provider stalled (e.g. contradictory injected
  // instructions confused Copilot). Treat like a rotation so the caller
  // starts a fresh chat and retries.
  if (!text.trim()) {
    const err = new Error("Scoping turn produced empty response — restarting chat");
    err.needsRotation = true;
    throw err;
  }

  const scopeMatch = text.match(SCOPE_DOC_RE);
  const rawScope = scopeMatch ? scopeMatch[1].trim() : null;
  const scopeDoc = rawScope && !isTemplateScopeDoc(rawScope) ? rawScope : null;

  return { text, scopeDoc };
}
