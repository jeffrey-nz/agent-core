import { z } from "zod";
import yaml from "js-yaml";
import fs from "fs/promises";
import path from "path";
import os from "os";

const ConfigSchema = z.object({
  provider: z.enum([
    "openai-api",
    "anthropic",
    "ollama",
    "gemini",
    "copilot",
    "chatgpt",
    "deepseek",
    "grok",
  ]).default("openai-api"),
  model: z.string().optional(),
  streaming: z.boolean().default(false),
  prompts_dir: z.string().default("./prompts"),
  openai_api_key: z.string().optional(),
  anthropic_api_key: z.string().optional(),
  ollama_host: z.string().default("http://localhost:11434"),
  validation_command: z.string().optional(),
  source_checksum: z.string().length(64).optional(), // SHA-256 hex of source tree
  github_token: z.string().optional(),
  github_webhook_secret: z.string().optional(),
});

export async function loadConfig(configPath = ".copilot-helper/config.yaml") {
  // Determine search paths
  const cwdPath = path.join(process.cwd(), configPath);
  const homePath = path.join(os.homedir(), configPath);
  const envPath = process.env.COPILOT_CONFIG;

  let resolvedPath = null;
  if (envPath && (await fileExists(envPath))) {
    resolvedPath = envPath;
  } else if (await fileExists(cwdPath)) {
    resolvedPath = cwdPath;
  } else if (await fileExists(homePath)) {
    resolvedPath = homePath;
  }

  if (!resolvedPath) {
    // No config file found; return default config
    return ConfigSchema.parse({});
  }

  let fileContent;
  try {
    fileContent = await fs.readFile(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read config file ${resolvedPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = yaml.load(fileContent);
  } catch (err) {
    throw new Error(`Failed to parse YAML config file ${resolvedPath}: ${err.message}`);
  }

  // If parsed is null or undefined, treat as empty object
  if (parsed == null) parsed = {};

  try {
    return ConfigSchema.parse(parsed);
  } catch (err) {
    throw new Error(`Invalid config schema in ${resolvedPath}: ${err.errors ? err.errors.map(e => e.message).join(", ") : err.message}`);
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
