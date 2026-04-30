import { trimTail, smartExtractErrors } from "../../utils.js";

export function formatComposerResult(result, cmd, cwd) {
  const out = trimTail(result.stdout || "");
  const err = smartExtractErrors(result.stderr || "");
  if (result.success)
    return `<composer_result cmd="${cmd}" cwd="${cwd}">\n[EXIT CODE: 0]\n[OUTPUT]\n${[out, err].filter(Boolean).join("\n").trim() || "(empty)"}\n</composer_result>`;

  let aiAdvice = "";
  const fullError = (result.stderr || "") + "\n" + (result.stdout || "");

  if (fullError.includes("Your requirements could not be resolved"))
    aiAdvice = `\n[SYSTEM ADVICE: COMPOSER CONFLICT DETECTED]\nTo fix this, analyze the conflicting dependencies. Use run_composer to remove blocking modules, or update constraints. Do NOT manually edit composer.json.\n`;
  else if (fullError.includes("allow-plugins"))
    aiAdvice = `\n[SYSTEM ADVICE: PLUGINS BLOCKED]\nRun \`run_composer\` with \`command: "config --no-plugins allow-plugins.vendor/plugin-name true"\` to allow it.\n`;
  else if (fullError.includes("memory limit"))
    aiAdvice = `\n[SYSTEM ADVICE: MEMORY LIMIT]\nRetry your command with \`COMPOSER_MEMORY_LIMIT=-1\` prepended.\n`;

  return `<composer_result cmd="${cmd}" cwd="${cwd}">\n[EXIT CODE: ${result.status}]\n[STDERR]\n${err}\n[STDOUT]\n${out}\n${aiAdvice}</composer_result>`;
}
