import process from "node:process";

let currentStatus = "";
let stickyHeader = "";

export function clearStatus() {
  if (!currentStatus && !stickyHeader) return;
  if (!process.stdout.isTTY) return;

  const stickyLines = stickyHeader ? stickyHeader.split("\n").length : 0;
  const statusLines = currentStatus ? currentStatus.split("\n").length : 0;
  const totalLines =
    stickyLines + (stickyLines > 0 && statusLines > 0 ? 1 : 0) + statusLines;

  for (let i = 0; i < totalLines - 1; i++) {
    process.stdout.write("\r\x1b[2K\x1b[1A");
  }
  process.stdout.write("\r\x1b[2K");
}

export function setStickyHeader(text) {
  const activeStatus = currentStatus;
  if (activeStatus || stickyHeader) clearStatus();

  stickyHeader = text ? String(text) : "";

  if (activeStatus || stickyHeader) _render();
}

export function setStatus(text) {
  if (!process.stdout.isTTY) return;
  if (currentStatus || stickyHeader) clearStatus();

  currentStatus = text ? String(text).replace(/\n/g, " ") : "";

  if (currentStatus || stickyHeader) _render();
}

function _render() {
  if (!process.stdout.isTTY) return;
  let out = "";
  if (stickyHeader) out += `${stickyHeader}`;
  if (stickyHeader && currentStatus) out += "\n";
  if (currentStatus) out += `\r${currentStatus}`;
  process.stdout.write(out);
}

export function getStatus() {
  return currentStatus;
}

export function setProgressBar(current, total, label = "") {
  const width = 30;
  const pct = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(width * pct);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "▒".repeat(empty);
  const pctStr = Math.round(pct * 100)
    .toString()
    .padStart(3, " ");

  setStatus(`\x1b[36m[${bar}]\x1b[0m ${pctStr}% | ${label}`);
}

export function finishProgress() {
  clearStatus();
  currentStatus = "";
  stickyHeader = "";
}
