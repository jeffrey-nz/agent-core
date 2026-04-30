import { spawnSync } from "node:child_process";

export function requireTool(cmd, args = ["--version"]) {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  if (res.status !== 0) {
    throw new Error(`Required tool not available: ${cmd}`);
  }
}
