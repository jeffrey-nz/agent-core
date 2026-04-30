import process from "node:process";
import pty from "node-pty";
import { colors } from "#app/ui/colors.js";
import { streamToFileOnly } from "#app/ui/fileLogger.js";
import { SAFE_ENV, INTERACTIVE_PROMPT_PATTERNS } from "./pty/constants.js";
import { runFallbackCommand } from "./pty/fallbackRunner.js";
import { STALL_TIMEOUT_MS, HARD_TIMEOUT_MS } from "#config/pipeline.js";

export async function runPtyCommand(cmd, cwd, spinner) {
  return await new Promise((resolve) => {
    let ptyProcess;
    try {
      const shell =
        process.platform === "win32"
          ? "powershell.exe"
          : process.env.SHELL || "/bin/sh";

      const args = process.platform === "win32" ? ["-c", cmd] : ["-lc", cmd];

      ptyProcess = pty.spawn(shell, args, {
        name: "xterm-color",
        cols: 120,
        rows: 30,
        cwd,
        env: SAFE_ENV,
      });
    } catch (err) {
      return runFallbackCommand(cmd, cwd, resolve);
    }

    let output = "";
    let stallTimer = null;
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(hardTimer);
      resolve(result);
    };

    const hardTimer = setTimeout(() => {
      try {
        ptyProcess.kill();
      } catch (e) {}
      finish({
        status: 124,
        output: output + `\n[ERROR: KILLED — hard timeout (${HARD_TIMEOUT_MS / 1000}s) reached.]`,
      });
    }, HARD_TIMEOUT_MS);

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        try {
          ptyProcess.kill();
        } catch (e) {}
        finish({
          status: 124,
          output: output + `\n[ERROR: KILLED DUE TO INACTIVITY (${STALL_TIMEOUT_MS / 1000}s).]`,
        });
      }, STALL_TIMEOUT_MS);
    };

    ptyProcess.onData((data) => {
      output += data;
      streamToFileOnly(data);
      const stripped = data
        .replace(
          /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
          "",
        )
        .trim();

      if (INTERACTIVE_PROMPT_PATTERNS.some((re) => re.test(stripped))) {
        setTimeout(() => {
          try {
            ptyProcess.kill();
          } catch (e) {}
          finish({
            status: 124,
            output: output + "\n[ERROR: KILLED - Interactive prompt detected.]",
          });
        }, 2000);
        return;
      }
      resetStallTimer();
      if (stripped)
        spinner.update(colors.dim(`  - [bash] ${stripped.slice(0, 50)}`));
    });

    ptyProcess.onExit(({ exitCode }) => {
      finish({ status: exitCode, output });
    });
    resetStallTimer();
  });
}
