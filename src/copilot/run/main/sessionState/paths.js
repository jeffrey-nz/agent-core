import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { getSafeId } from "#utils/format.js";

const SESSION_DIR = ".copilot-sessions";

export async function getSessionDir(projectId) {
  const dir = path.join(process.cwd(), SESSION_DIR, getSafeId(projectId));
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  return dir;
}

export function generateSessionId() {
  return crypto.randomBytes(3).toString("hex") + "-" + Date.now().toString(36);
}
