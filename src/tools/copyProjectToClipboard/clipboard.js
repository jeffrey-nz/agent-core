import process from "node:process";
import { spawnSync } from "node:child_process";

export function forceCopyToClipboard(text) {
  const isWSL =
    process.platform === "linux" &&
    (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
  const isMac = process.platform === "darwin";

  if (isMac) {
    const res = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
    if (res.error || res.status !== 0) throw new Error("pbcopy failed");
    return;
  }

  if (process.platform === "win32" || isWSL) {
    const res = spawnSync("clip.exe", [], {
      input: text,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) {
      throw new Error(
        res.error
          ? res.error.message
          : `clip.exe failed with status ${res.status}`,
      );
    }
    return;
  }

  const xclip = spawnSync("xclip", ["-selection", "clipboard"], {
    input: text,
    encoding: "utf8",
  });
  if (xclip.error || xclip.status !== 0) {
    throw new Error("Linux clipboard copy failed: 'xclip' must be installed.");
  }
}
