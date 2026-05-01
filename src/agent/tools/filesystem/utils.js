import path from "node:path";
import { minimatch } from "minimatch";

export const MAX_FILE_SIZE_BYTES = 50 * 1024;

const PROTECTED_DIRS = new Set(["vendor", "node_modules", ".git"]);

export function isProtectedPath(targetPath) {
  if (!targetPath) return false;
  const normalized = targetPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments.some((seg) => PROTECTED_DIRS.has(seg));
}

export function isSafePath(rootDir, targetPath, allowedDirs = []) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedRelative = path.resolve(rootDir, targetPath);
  const resolvedAbsolute = path.resolve(targetPath);

  const underRoot = (base, p) =>
    p === base || p.startsWith(base + path.sep);

  if (underRoot(resolvedRoot, resolvedRelative)) return true;
  if (underRoot(resolvedRoot, resolvedAbsolute)) return true;

  // Allow reads from /tmp — agent bash commands frequently write temp files there
  if (underRoot("/tmp", resolvedAbsolute)) return true;

  for (const dir of allowedDirs) {
    if (!dir) continue;
    const resolvedDir = path.resolve(dir);
    if (underRoot(resolvedDir, resolvedRelative)) return true;
    if (underRoot(resolvedDir, resolvedAbsolute)) return true;
  }

  return false;
}

export function isCompiledFile(targetPath) {
  if (!targetPath) return false;
  const lower = targetPath.replace(/\\/g, "/").toLowerCase();
  // Blanket .css block was wrong — React/Vue/Vite source CSS is hand-written.
  // Only block CSS that lives in build output dirs or is minified.
  const isBuildDirCss =
    /\.css$/.test(lower) &&
    /(^|\/)(dist|build|public|out|\.next|\.nuxt|coverage)\//.test(lower);
  return (
    isBuildDirCss ||
    lower.endsWith(".min.css") ||
    lower.endsWith(".min.js") ||
    lower.endsWith(".bundle.js")
  );
}

export function isIgnored(targetPath, ignorePatterns = []) {
  if (!targetPath) return false;
  if (isCompiledFile(targetPath)) return true;

  const normalizedPath = targetPath.replace(/\\/g, "/");
  if (ignorePatterns.length === 0) return false;

  return ignorePatterns.some((pattern) => {
    if (minimatch(normalizedPath, pattern, { dot: true, nocomment: true }))
      return true;
    if (normalizedPath.endsWith(pattern)) return true;
    if (normalizedPath.includes(pattern)) return true;
    return false;
  });
}

export function fuzzyReplace(content, oldBlock, newBlock) {
  const cleanOld = oldBlock?.trim();
  if (!cleanOld) return null;

  const firstIdx = content.indexOf(cleanOld);
  if (firstIdx !== -1) {
    const secondIdx = content.indexOf(cleanOld, firstIdx + cleanOld.length);
    if (secondIdx === -1) {
      return (
        content.slice(0, firstIdx) +
        newBlock +
        content.slice(firstIdx + cleanOld.length)
      );
    }
    return null;
  }

  const tokens = cleanOld.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const regexPattern = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");

  try {
    const regex = new RegExp(regexPattern, "g");
    const matches = content.match(regex);

    if (matches && matches.length === 1) {
      return content.replace(regex, () => newBlock);
    }
  } catch (err) {
    return null;
  }
  return null;
}
