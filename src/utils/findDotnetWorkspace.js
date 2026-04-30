import fs from "node:fs";
import path from "node:path";

export function findDotnetWorkspace(rootDir) {
  const entries = fs.readdirSync(rootDir);

  const sln = entries.find((e) => e.toLowerCase().endsWith(".sln"));
  if (sln) {
    return { type: "solution", path: path.join(rootDir, sln) };
  }

  const csproj = entries.find((e) => e.toLowerCase().endsWith(".csproj"));
  if (csproj) {
    return { type: "project", path: path.join(rootDir, csproj) };
  }

  return null;
}
