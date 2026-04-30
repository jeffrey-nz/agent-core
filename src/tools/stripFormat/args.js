import path from "node:path";

export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const args = new Set(argv.slice(2));
  const getArgValue = (name, fallback = null) => {
    const idx = argv.indexOf(name);
    if (idx === -1) return fallback;
    return argv[idx + 1] ?? fallback;
  };

  const dryRun = args.has("--dry-run");
  const keepDirectives = args.has("--keep-directives");
  const root = path.resolve(getArgValue("--root", cwd));

  return { dryRun, keepDirectives, root };
}
