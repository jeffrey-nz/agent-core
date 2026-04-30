import readline from "node:readline";
import process from "node:process";
import { traceWarn } from "#app/ui/trace.js";
import { eventBus } from "#web/eventBus.js";

let lastSigintTime = 0;

export function makeRl() {
  try {
    process.stdin.resume();
  } catch (err) {
    traceWarn("RL", "Failed to resume stdin", { error: err.message });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("SIGINT", () => {
    const now = Date.now();

    if (now - lastSigintTime <= 600) {
      process.stdout.write("\n\x1b[91mForce quitting immediately...\x1b[0m\n");
      process.exit(130);
    } else {
      lastSigintTime = now;
      process.stdout.write(
        "\n\x1b[93mGraceful abort requested. Press Ctrl+C again to force quit.\x1b[0m\n",
      );
      eventBus.emit("abort_requested");
    }
  });

  return rl;
}

export function closeRl(rl) {
  try {
    rl?.close?.();
  } catch {}
}

export async function withRl(maybeRl, fn) {
  const isValidRl = maybeRl && typeof maybeRl.question === "function";
  const rl = isValidRl ? maybeRl : makeRl();
  const shouldClose = !isValidRl;

  try {
    return await fn(rl);
  } finally {
    if (shouldClose) closeRl(rl);
  }
}
