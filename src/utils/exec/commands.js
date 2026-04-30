import { exec, spawn } from "node:child_process";
import { withHarness } from "./harness.js";

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

export async function execAsync(cmd, options = {}) {
  return withHarness((signal, done) => {
    const child = exec(
      cmd,
      {
        ...options,
        maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
        signal,
      },
      (error, stdout, stderr) => {
        done({
          status: error
            ? error.name === "AbortError"
              ? 124
              : error.code || 1
            : 0,
          stdout,
          stderr:
            error?.name === "AbortError" ? "Process aborted/timed out" : stderr,
        });
      },
    );
    if (options.onData) {
      child.stdout?.on("data", options.onData);
      child.stderr?.on("data", options.onData);
    }
  }, options);
}

export async function spawnAsync(cmd, args, options = {}) {
  return withHarness((signal, done) => {
    const child = spawn(cmd, args, {
      ...options,
      shell: false,
      signal,
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (options.onData) options.onData(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (options.onData) options.onData(chunk);
    });

    child.on("close", (code) => {
      done({
        status: code !== null ? code : 1,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      if (err.name === "AbortError") {
        done({
          status: 124,
          stdout,
          stderr: signal.reason?.message || "Process aborted",
        });
        return;
      }
      done({ status: 1, stdout, stderr: err.message });
    });
  }, options);
}
