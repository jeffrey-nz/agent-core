import process from "node:process";

export const ansiRegex =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(str) {
  return String(str || "").replace(ansiRegex, "");
}

export function countLines(str) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\n") count++;
  }
  return count;
}

export function restoreTerminal() {
  try {
    process.stdout.write("\x1b[?1049l\x1b[?25h");
  } catch (e) {}
}
