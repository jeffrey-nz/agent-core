import process from "node:process";
import { logToFileOnly } from "#app/ui/fileLogger.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { withRl } from "./interface.js";

export function askLine(rl, prompt) {
  return new Promise((resolve, reject) => {
    if (!rl) return reject(new Error("readline interface not available"));

    process.stdin.resume();

    const onCloseOrEnd = () => {
      cleanup();
      reject(new Error("Input stream closed prematurely."));
    };

    const cleanup = () => {
      rl.off("close", onCloseOrEnd);
      process.stdin.off("end", onCloseOrEnd);
    };

    rl.on("close", onCloseOrEnd);
    process.stdin.on("end", onCloseOrEnd);

    logToFileOnly(prompt);
    rl.question(prompt, (answer) => {
      logToFileOnly(`> ${answer}`);
      cleanup();
      resolve(answer);
    });
  });
}

export function askMultiLine(rl, promptText) {
  return new Promise((resolve, reject) => {
    if (!rl) return reject(new Error("readline interface not available"));

    const p1 = promptText + "\n";
    const p2 =
      "\x1b[2m(Type your prompt. Press Enter on an empty line twice to submit)\x1b[0m\n> ";

    logToFileOnly(p1 + p2);
    process.stdout.write(p1);
    process.stdout.write(p2);

    process.stdin.resume();
    const lines = [];

    const onLine = (line) => {
      logToFileOnly(`> ${line}`);
      if (
        line.trim() === "" &&
        lines.length > 0 &&
        lines[lines.length - 1].trim() === ""
      ) {
        cleanup();
        lines.pop();
        resolve(lines.join("\n").trim());
      } else {
        lines.push(line);
        process.stdout.write("> ");
      }
    };

    const onCloseOrEnd = () => {
      cleanup();
      reject(new Error("Input stream closed prematurely."));
    };

    const cleanup = () => {
      rl.off("line", onLine);
      rl.off("close", onCloseOrEnd);
      process.stdin.off("end", onCloseOrEnd);
    };

    rl.on("line", onLine);
    rl.on("close", onCloseOrEnd);
    process.stdin.on("end", onCloseOrEnd);
  });
}

export function askLineWithTimeout(rl, prompt, timeoutMs, defaultValue = "") {
  return new Promise((resolve) => {
    if (!rl) return resolve(defaultValue);

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ticker);
      resolve(value);
    };

    const totalSecs = Math.ceil(timeoutMs / 1000);
    let secsLeft = totalSecs;

    log(
      colors.dim(
        `  (auto-continues in ${totalSecs}s - press Enter to respond now)`,
      ),
    );

    const ticker = setInterval(() => {
      secsLeft--;
      if (secsLeft <= 0) clearInterval(ticker);
    }, 1000);

    const timer = setTimeout(() => {
      log(
        colors.dim(`\n[Input timed out after ${totalSecs}s - auto-continuing]`),
      );
      finish(defaultValue);
    }, timeoutMs);

    process.stdin.resume();
    rl.question(prompt, (answer) => finish(answer));
  });
}

export async function askValidatedLine(rl, prompt, validator, defaultValue = '') {
  while (true) {
    const displayPrompt = defaultValue
      ? `${prompt} (default: ${defaultValue}) `
      : prompt;
    const answer = await askLine(rl, displayPrompt);
    const value = answer.trim() || defaultValue;
    const error = validator(value);
    if (!error) return value;
    console.error(colors.red(`❌ ${error}`));
  }
}

export async function waitForEnter(rl, message = "") {
  await withRl(rl, async (activeRl) => {
    const prompt = message
      ? `${message}\n(Press Enter to continue) `
      : "(Press Enter to continue) ";
    await askLine(activeRl, prompt);
  });
}
