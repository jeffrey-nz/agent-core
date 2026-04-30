import { shouldKeepComment } from "./lib/commentRules.js";
import { isRegexStart, getPrevNonWsChar } from "./lib/scannerUtils.js";

export function stripCommentsPreservingSome(
  input,
  { keepDirectives = false } = {},
) {
  const src = String(input ?? "");
  if (!src) return src;

  let out = "";
  let i = 0;
  const len = src.length;

  let state = {
    inSingle: false,
    inDouble: false,
    inTemplate: false,
    interpolationDepth: 0,
    inRegex: false,
    inLineComment: false,
    inBlockComment: false,
  };

  let blockBuf = "";
  let lineBuf = "";

  const peek = (n = 0) => (i + n < len ? src[i + n] : "");

  const flushLineComment = () => {
    if (!state.inLineComment) return;
    if (keepDirectives && shouldKeepComment(lineBuf)) out += "//" + lineBuf;
    lineBuf = "";
    state.inLineComment = false;
  };

  const flushBlockComment = () => {
    if (!state.inBlockComment) return;
    if (keepDirectives && shouldKeepComment(blockBuf)) {
      out += "/*" + blockBuf + "*/";
    } else {
      const newlines = blockBuf.match(/\n/g);
      if (newlines) out += "\n".repeat(newlines.length);
    }
    blockBuf = "";
    state.inBlockComment = false;
  };

  while (i < len) {
    const c = src[i];
    const n = peek(1);

    if (state.inLineComment) {
      if (c === "\n") {
        flushLineComment();
        out += "\n";
      } else {
        lineBuf += c;
      }
      i++;
      continue;
    }

    if (state.inBlockComment) {
      if (c === "*" && n === "/") {
        i += 2;
        flushBlockComment();
      } else {
        blockBuf += c;
      }
      i++;
      continue;
    }

    if (state.inSingle || state.inDouble || state.inTemplate || state.inRegex) {
      if (c === "\\" && i + 1 < len) {
        out += c + src[i + 1];
        i += 2;
        continue;
      }
    }

    if (state.inSingle) {
      out += c;
      if (c === "'") state.inSingle = false;
      i++;
      continue;
    }
    if (state.inDouble) {
      out += c;
      if (c === '"') state.inDouble = false;
      i++;
      continue;
    }
    if (state.inTemplate) {
      out += c;
      if (c === "$" && n === "{") {
        state.interpolationDepth++;
        out += "{";
        i += 2;
        continue;
      }
      if (c === "}" && state.interpolationDepth > 0) {
        state.interpolationDepth--;
        i++;
        continue;
      }
      if (c === "`" && state.interpolationDepth === 0) state.inTemplate = false;
      i++;
      continue;
    }

    if (state.inRegex) {
      out += c;
      if (c === "/") state.inRegex = false;
      i++;
      continue;
    }

    if (c === "/" && n === "/") {
      state.inLineComment = true;
      lineBuf = "";
      i += 2;
      continue;
    }
    if (c === "/" && n === "*") {
      state.inBlockComment = true;
      blockBuf = "";
      i += 2;
      continue;
    }
    if (c === "'") {
      state.inSingle = true;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      state.inDouble = true;
      out += c;
      i++;
      continue;
    }
    if (c === "`") {
      state.inTemplate = true;
      out += c;
      i++;
      continue;
    }

    if (c === "/") {
      if (isRegexStart(getPrevNonWsChar(out))) {
        state.inRegex = true;
        out += c;
        i++;
        continue;
      }
    }

    out += c;
    i++;
  }

  if (state.inLineComment) flushLineComment();
  if (state.inBlockComment) flushBlockComment();

  let result = out.replace(/\n\s*\n\s*\n/g, "\n\n");

  return result.trimStart();
}
