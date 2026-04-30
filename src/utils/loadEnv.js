import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv({
  fromUrl = import.meta.url,
  relativePath = "../../.env",
  env = process.env,
  readFileSync = fs.readFileSync,
} = {}) {
  const __filename = fileURLToPath(fromUrl);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, relativePath);

  try {
    if (!fs.existsSync(envPath)) {
      console.warn(
        `\x1b[33m[loadEnv] Warning: .env file not found at ${envPath}\x1b[0m`,
      );
      return null;
    }

    const content = readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (!match) continue;

      const key = match[1].trim();
      let value = match[2].trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!(key in env)) {
        env[key] = value;
      }
    }
    return envPath;
  } catch (err) {
    console.error(
      `\x1b[31m[loadEnv] Error reading .env: ${err.message}\x1b[0m`,
    );
    return null;
  }
}
