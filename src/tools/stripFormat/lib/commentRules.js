const KEEP_STARTS = [
  "eslint-",
  "@ts-",
  "tslint:",
  "prettier-",
  "istanbul",
  "vite-",
];

export function shouldKeepComment(commentText) {
  const t = String(commentText ?? "")
    .trim()
    .toLowerCase();

  if (KEEP_STARTS.some((k) => t.startsWith(k))) return true;

  if (t.startsWith("!") || t.includes("copyright")) return true;

  return false;
}
