import { spawn } from "node:child_process";

let cachedCapabilities = null;

async function canRun(cmd, args = ["--version"]) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function detectCapabilities() {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }
  cachedCapabilities = {
    dotnet: await canRun("dotnet"),
    dotnetFormat: await canRun("dotnet", ["format", "--version"]),
    unity:
      (await canRun("Unity", ["-batchmode", "-version"])) ||
      (await canRun("/Applications/Unity/Hub/Editor", [])),
    xmlParsing: true,
    shell: true,
  };
  return cachedCapabilities;
}

export function clearCapabilitiesCache() {
  cachedCapabilities = null;
}
