import { colors } from "#app/ui/colors.js";
import { truncateCommandOutput } from "#utils/format.js";

const UNITY_NOISE_PREFIXES = [
  "[Licensing::",
  "[Package Manager]",
  "[Physics::",
  "[Subsystems]",
  "[usbmuxd]",
  "[ScriptCompilation]",
  "Player connection [",
  "info: Microsoft.",
  "warn: Unity.ILPP.",
  "info: Unity.ILPP.",
  "info: Microsoft.AspNetCore.",
  "warn: Microsoft.AspNetCore.",
  '    "memorysetup-',
  "Launching external process:",
  "Launched and connected shader compiler",
  "Refreshing native plugins compatible",
  "Preloading 0 native plugins",
  "Native extension for ",
  "Register platform support module:",
  "Registered in ",
  "- Loaded All Assemblies",
  "- Finished resetting",
  "Mono: successfully reloaded",
  "Domain Reload Profiling:",
  "Begin MonoManager ReloadAssembly",
  "Registering precompiled unity",
  "[MODES] ",
  "Unloading ",
  "Memory consumption ",
  "Total: ",
  "GfxDevice:",
  "NullGfxDevice:",
  "    Version:  NULL",
  "    Renderer:",
  "    Vendor:",
  "Using monoOptions",
  "Using cacheserver",
  "Mono config path",
  "Mono path[",
  "Initialize mono",
  "Initialize engine version:",
  "Forcing GfxDevice:",
  "ImportWorker Server",
  "AcceleratorClientConnectionCallback",
  "[usbmuxd]",
  "Input System",
  "Shader Hidden/",
  "debugger-agent:",
  "Cleanup mono",
  "Batchmode quit",
  "Exiting batchmode",
  "[Package Manager] Server process",
  "Scanning for USB",
  "Initializing Unity extensions",
  "Start importing Packages/",
  " -> (artifact id:",
  "Artifact Garbage Collection",
  "COMMAND LINE ARGUMENTS:",
  "WorkingDir:",
];

function isUnityNoiseLine(line) {
  const trimmed = line.trimStart();
  return UNITY_NOISE_PREFIXES.some((p) => trimmed.startsWith(p));
}

function filterUnityOutput(output, cmd) {
  if (!cmd.includes("Unity.app/Contents/MacOS/Unity")) return output;

  const lines = output.split("\n");
  const kept = lines.filter((line) => {
    if (!line.trim()) return false;
    if (isUnityNoiseLine(line)) return false;
    return true;
  });

  const filtered = kept.join("\n");
  if (kept.length < lines.length) {
    const removed = lines.length - kept.length;
    return `[Unity startup noise filtered: ${removed} lines removed]\n${filtered}`;
  }
  return filtered;
}

// Search/read tools that use exit code 1 to mean "no results" — not an error.
// grep, rg (ripgrep), ag (silver searcher), find, diff, wc all use this convention.
const SEARCH_TOOL_RE = /^\s*(?:grep|rg|ag|egrep|fgrep|git\s+grep|find\s|diff\s|wc\s)/i;

/**
 * Returns true if this command uses exit code 1 to mean "no results found"
 * rather than "something went wrong". Prevents false-positive failure detection.
 */
function isSearchNoMatch(cmd, exitCode) {
  if (exitCode !== 1) return false;
  return SEARCH_TOOL_RE.test(String(cmd || "").trim());
}

export function formatBashResult(res, cmd, cwd, displayCmd, spinner) {
  const safeCmd = String(cmd || "").replace(/"/g, "&quot;");
  const safeCwd = String(cwd || "").replace(/"/g, "&quot;");
  const output = filterUnityOutput(res.output, cmd);

  if (res.status === 0) {
    spinner.succeed(colors.dim(`  - Executed: ${displayCmd}`));
    return `<bash_result cmd="${safeCmd}" cwd="${safeCwd}">\n[STDOUT]\n${truncateCommandOutput(output, cmd) || "(empty)"}\n</bash_result>\n\n`;
  }

  // Search tools exit with 1 for "no matches" — this is not a failure.
  // Format it as a successful execution with an informative note so the AI
  // doesn't waste retries on a grep that simply found nothing.
  if (isSearchNoMatch(cmd, res.status)) {
    spinner.succeed(colors.dim(`  - Executed: ${displayCmd} (no matches)`));
    return `<bash_result cmd="${safeCmd}" cwd="${safeCwd}">\n[STDOUT]\n${truncateCommandOutput(output, cmd) || "(no matches found)"}\n[NOTE: exit code 1 for this search command means no matches — not an error]\n</bash_result>\n\n`;
  }

  spinner.fail(colors.red(`  - Failed (Exit ${res.status}): ${displayCmd}`));
  return `<bash_result cmd="${safeCmd}" cwd="${safeCwd}">\n[EXIT CODE: ${res.status}]\n[STDOUT/STDERR]\n${truncateCommandOutput(output, cmd)}\n</bash_result>\n\n`;
}
