import process from "node:process";
import { logToFileOnly } from "#app/ui/fileLogger.js";
import { colors } from "#app/ui/colors.js";
import { withRl, makeRl } from "./interface.js";
import { askLine, askLineWithTimeout } from "./prompts.js";

export async function askYesNo(rl, message, { defaultYes = true } = {}) {
  return await withRl(rl, async (activeRl) => {
    const suffix = defaultYes ? "[Y/n]" : "[y/N]";
    const answer = await askLine(activeRl, `${message} ${suffix} `);

    const t = String(answer ?? "")
      .trim()
      .toLowerCase();

    if (!t) return defaultYes;
    if (t === "y" || t === "yes") return true;
    if (t === "n" || t === "no") return false;

    return defaultYes;
  });
}

export async function promptChoice(rlMaybe, questionText, options, opts = {}) {
  const {
    allowCustom = true,
    customPrompt = "Enter custom value: ",
    defaultOption = 1,
    timeoutMs = 0,
    timeoutValue = null,
  } = opts;

  return await withRl(rlMaybe, async (rl) => {
    while (true) {
      const outText =
        `\n${colors.bold(questionText)}\n` +
        options
          .map((o, i) => {
            const num = colors.cyan(String(i + 1).padStart(2, " ") + ".");
            const isDef = i + 1 === defaultOption;
            const label = isDef ? colors.bold(o.label) : o.label;
            const defTag = isDef ? colors.dim(" (Default)") : "";
            return `  ${num} ${label}${defTag}\n`;
          })
          .join("") +
        `\n`;

      logToFileOnly(outText);
      process.stdout.write(outText);

      const promptStr = `Select option [1-${options.length}] (Press Enter for default ${defaultOption}): `;

      let answer;
      if (timeoutMs > 0) {
        const timeoutIdx = options.findIndex((o) => o.value === timeoutValue);
        const timeoutStr =
          timeoutIdx !== -1 ? String(timeoutIdx + 1) : String(defaultOption);
        answer = await askLineWithTimeout(rl, promptStr, timeoutMs, timeoutStr);
      } else {
        answer = await askLine(rl, promptStr);
      }

      const t = String(answer ?? "").trim();
      const choice = t === "" ? defaultOption : Number(t);

      if (choice >= 1 && choice <= options.length) {
        const selected = options[choice - 1];

        if (selected.value !== null) {
          return selected.value;
        }

        if (allowCustom) {
          while (true) {
            const custom = await askLine(rl, customPrompt);
            const t2 = String(custom ?? "").trim();
            if (t2) return t2;
            process.stdout.write(
              colors.red("Custom input is required. Please try again.\n"),
            );
          }
        }
      } else {
        process.stdout.write(
          colors.red(
            `Invalid selection. Please enter a number between 1 and ${options.length}.\n`,
          ),
        );
      }
    }
  });
}
