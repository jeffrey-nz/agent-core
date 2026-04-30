import process from "node:process";
import { spawn } from "node:child_process";
import { streamToFileOnly } from "#app/ui/fileLogger.js";
import { SAFE_ENV } from "./constants.js";
import { HARD_TIMEOUT_MS } from "#config/pipeline.js";

export function runFallbackCommand(cmd, cwd, resolve) {
  const shell =
    process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/sh";

  const args = process.platform === "win32" ? ["/c", cmd] : ["-lc", cmd];
  let output = "";
  let resolved = false;

  let child;
  try {
    child = spawn(shell, args, {
      cwd,
      env: SAFE_ENV,
    });
  } catch (err) {
    return resolve({
      status: 1,
      output: `Shell spawn failed: ${err.message}\n`,
    });
  }

  const finish = (result) => {
    if (resolved) return;
    resolved = true;
    clearTimeout(hardTimer);
    resolve(result);
  };

  const hardTimer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch (e) {}
    finish({
      status: 124,
      output: output + `\n[ERROR: KILLED — hard timeout (${HARD_TIMEOUT_MS / 1000}s) reached.]`,
    });
  }, HARD_TIMEOUT_MS);

  child.stdout.on("data", (d) => {
    output += d;
    streamToFileOnly(d);
  });
  child.stderr.on("data", (d) => {
    output += d;
    streamToFileOnly(d);
  });
  child.on("close", (code) => finish({ status: code ?? 1, output }));
  child.on("error", (err) =>
    finish({ status: 1, output: output + `\n${err.message}` }),
  );
}
