import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getExpectedProjectRoot() {
  return process.env.COPILOT_HELPER_PROJECT_ROOT
    ? path.resolve(process.env.COPILOT_HELPER_PROJECT_ROOT)
    : path.resolve(__dirname, "../..");
}

export function assertProjectRoot({
  cwd = process.cwd(),
  exit = process.exit,
  error = console.error,
} = {}) {
  const expectedRoot = getExpectedProjectRoot();
  const actual = path.resolve(cwd);

  if (actual !== expectedRoot) {
    error(
      `\n🚫 Safety abort: Expected project root ${expectedRoot}, but CWD is ${actual}.\n`,
    );
    exit(1);
  }
}
