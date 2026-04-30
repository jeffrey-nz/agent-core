import process from "node:process";
import fs from "node:fs";

try {
  if (fs.existsSync(".env")) {
    process.loadEnvFile(".env");
  }
} catch (e) {}

export const WEB_ROOT = process.env.WEB_ROOT || "/var/www/";
export const DEFAULT_OP_DIR = `${WEB_ROOT.replace(/\/$/, "")}/op`;
