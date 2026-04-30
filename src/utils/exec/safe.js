import { execAsync } from "./commands.js";

function hasDangerousPatterns(command) {
  // Reject command injection patterns: backticks, command substitution, process substitution, etc.
  const dangerous = /[`$]\s*\(|\$\{[^}]*\}|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i;
  if (dangerous.test(command)) {
    console.warn(`[SECURITY] Command rejected due to dangerous pattern: ${command}`);
    return true;
  }
  // Also reject unescaped semicolons that could chain commands (except when part of && or ||)
  // Simple heuristic: if there's a ';' that's not part of '&&' or '||', reject.
  const semicolonPattern = /(?<![&|]);/;
  if (semicolonPattern.test(command)) {
    console.warn(`[SECURITY] Command rejected due to unescaped semicolon: ${command}`);
    return true;
  }
  return false;
}

function getErrorAdvice(output) {
  const low = output.toLowerCase();
  if (low.includes("permission denied") || low.includes("eacces"))
    return "Try running with sudo or check file ownership.";
  if (low.includes("not found") || low.includes("enoent"))
    return "Verify the command is installed in the environment path.";
  if (low.includes("memory limit"))
    return "Set COMPOSER_MEMORY_LIMIT=-1 or increase PHP memory_limit.";
  if (
    low.includes("host key verification failed") ||
    low.includes("could not read from remote repository")
  )
    return "Git SSH authentication failed. Verify SSH keys, use BatchMode, or switch to HTTPS URLs with embedded tokens.";
  if (
    low.includes("authentication failed") ||
    low.includes("invalid credentials") ||
    low.includes("403 forbidden")
  )
    return "Git/Composer HTTP authentication failed. Check auth.json, credentials, or use a Personal Access Token (PAT).";
  return "Analyze the error output above and correct your command parameters.";
}

export async function safeExec(command, options = {}) {
  if (hasDangerousPatterns(command)) {
    const errorResult = {
      status: 1,
      success: false,
      stdout: "",
      stderr: `Command rejected: contains dangerous injection patterns. Command: ${command}`,
      advice: "The command contains characters that could lead to shell injection. Please review the command and avoid using backticks, $(...), ${...}, or unescaped semicolons. Use && or || for chaining.",
    };
    return errorResult;
  }
  const result = await execAsync(command, options);

  if (!result.success) {
    result.advice = getErrorAdvice(result.stderr + "\n" + result.stdout);
  }

  return result;
}
