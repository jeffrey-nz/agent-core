import { spawn } from "node:child_process";

export function run(cmd, cmdArgs, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start command: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Command '${cmd} ${cmdArgs.join(" ")}' exited with code ${code}`,
          ),
        );
      }
    });
  });
}
