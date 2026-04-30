import { exec } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const execAsync = promisify(exec);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function killPortOccupant(port) {
  try {
    const { stdout } = await execAsync(`lsof -ti tcp:${port} 2>/dev/null`);
    const pids = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const pid of pids) {
      try {
        const { stdout: commStdout } = await execAsync(`ps -p ${pid} -o comm=`);
        const comm = commStdout.trim();
        if (comm.toLowerCase().includes("node")) {
          process.kill(Number(pid), "SIGKILL");
        }
      } catch (err) {
        // Ignore errors from ps or kill; process may have already exited
      }
    }

    if (pids.length > 0) {
      await sleep(500);
    }
  } catch (err) {
    // No process found on port or lsof failed; ignore
  }
}
