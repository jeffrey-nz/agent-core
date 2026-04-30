import { spawn } from "node:child_process";

export function runDotnetFormat({ workspacePath, mode, include }) {
  return new Promise((resolve) => {
    const args = ["format", mode, workspacePath];

    if (include?.length) {
      args.push("--include", include.join(","));
    }

    args.push("--severity", "info", "--verbosity", "minimal");

    const proc = spawn("dotnet", args, { stdio: "inherit" });

    proc.on("close", (code) => {
      resolve({ success: code === 0, exitCode: code });
    });
  });
}
