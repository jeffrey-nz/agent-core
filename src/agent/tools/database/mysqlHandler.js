import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execAsync } from "#utils/exec.js";

function parseEnvFile(content) {
  const vars = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function escapeXml(unsafeStr) {
  return String(unsafeStr || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function handleMysqlQuery(input, { rootDir }) {
  const { query, env_file, database: dbOverride } = input;
  const safeQuery = escapeXml(query);

  const allowed = ["select", "show", "describe", "explain", "desc"];
  if (!allowed.some((p) => query.trim().toLowerCase().startsWith(p))) {
    return `<database_result query="${safeQuery}">\n[DATABASE ERROR] Only read-only queries are permitted.\n</database_result>`;
  }

  const envPath = env_file || path.join(rootDir, ".env");
  let envVars;
  try {
    const envContent = await fs.readFile(envPath, "utf8");
    envVars = parseEnvFile(envContent);
  } catch (err) {
    return `<database_result query="${safeQuery}">\n[DATABASE ERROR] Could not read .env at "${envPath}".\n</database_result>`;
  }

  const host = envVars.DB_HOST || envVars.SS_DATABASE_SERVER || "127.0.0.1";
  const port = envVars.DB_PORT || envVars.SS_DATABASE_PORT || "3306";
  const user =
    envVars.DB_USERNAME ||
    envVars.DB_USER ||
    envVars.SS_DATABASE_USERNAME ||
    "";
  const password =
    envVars.DB_PASSWORD ||
    envVars.DB_PASS ||
    envVars.SS_DATABASE_PASSWORD ||
    "";
  const database =
    dbOverride ||
    envVars.DB_DATABASE ||
    envVars.DB_NAME ||
    envVars.SS_DATABASE_NAME ||
    "";

  if (!user || !database) {
    return `<database_result query="${safeQuery}">\n[DATABASE ERROR] Missing credentials in .env.\n</database_result>`;
  }

  const escapedQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const cmd = `mysql -h${host} -P${port} -u${user} ${database} --batch --silent -e '${escapedQuery}'`;

  try {
    const { status, stdout, stderr } = await execAsync(cmd, {
      timeout: 30000,
      env: { ...process.env, MYSQL_PWD: password },
    });

    if (status !== 0) {
      return `<database_result query="${safeQuery}">\n[DATABASE ERROR] Query failed:\n${stderr}\n</database_result>`;
    }

    return `<database_result query="${safeQuery}">\n${stdout || "[DATABASE] Query returned no rows."}\n</database_result>`;
  } catch (err) {
    return `<database_result query="${safeQuery}">\n[DATABASE ERROR] ${err.message}\n</database_result>`;
  }
}
