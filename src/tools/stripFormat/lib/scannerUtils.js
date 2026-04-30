export function isRegexStart(prevNonWhitespace) {
  if (!prevNonWhitespace) return true;

  const regexPrecursors = /[=([{:,!?\+\-\*%&|^~<>;]/;
  return regexPrecursors.test(prevNonWhitespace);
}

export function getPrevNonWsChar(text) {
  for (let j = text.length - 1; j >= 0; j--) {
    const c = text[j];
    if (c && !/\s/.test(c)) return c;
  }
  return "";
}
