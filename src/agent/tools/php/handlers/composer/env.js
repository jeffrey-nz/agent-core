import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function buildEnvironment(cwd) {
  const env = {
    ...process.env,
    COMPOSER_PROCESS_TIMEOUT: "1800",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
  };
  try {
    const envContent = await fs.readFile(path.join(cwd, ".env"), "utf8");
    const authMatch = envContent.match(/^COMPOSER_AUTH=(.*)$/m);
    if (authMatch)
      env.COMPOSER_AUTH = authMatch[1].replace(/^['"]|['"]$/g, "").trim();
  } catch (e) {}
  return env;
}
