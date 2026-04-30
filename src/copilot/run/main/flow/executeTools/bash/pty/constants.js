import process from "node:process";

export const SAFE_ENV = {
  ...process.env,
  COMPOSER_MEMORY_LIMIT: "-1",
  GIT_PAGER: "cat",
  PAGER: "cat",
  DEBIAN_FRONTEND: "noninteractive",
};

export const INTERACTIVE_PROMPT_PATTERNS = [
  /enter passphrase/i,
  /enter password/i,
  /password for/i,
  /username for/i,
  /authentication required/i,
  /already exists\. overwrite\?/i,
  /do you want to continue/i,
  /press enter to continue/i,
  /\(yes\/no\)/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
];
