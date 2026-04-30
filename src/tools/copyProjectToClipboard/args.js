import path from "node:path";
import process from "node:process";

export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const args = argv.slice(2);
  const getArg = (name, fallback = null) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : (args[i + 1] ?? fallback);
  };

  const root = path.resolve(getArg("--root", cwd));
  const maxBytes = Number(getArg("--max-bytes", "1500000")) || 1_500_000;

  const only = getArg("--only");
  const targetDir = only ? path.resolve(root, only) : root;

  return {
    root,
    targetDir,
    maxBytes,
  };
}
