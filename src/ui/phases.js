import { logRaw } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

const PHASE_ICONS = {
  "PHASE 0": "🚀",
  "PHASE 1": "🧠",
  "PHASE 2": "⚙️",
  "PHASE 3": "👀",
  "PHASE 7": "🏁",
};

export function logPhase(stepInfo, title, description = "") {
  const width = 70;
  const pad = "═".repeat(width - 2);
  const icon = PHASE_ICONS[stepInfo] || "⚙️";

  logRaw(`\n${colors.cyan(`╔${pad}╗`)}`);

  const titleLine = `${stepInfo} | ${title}`;
  const padding = Math.max(0, width - 6 - titleLine.length);

  logRaw(
    `${colors.cyan("║")} ${icon} ${colors.bold(colors.magenta(`${stepInfo} | `))}${colors.bold(title)}${" ".repeat(padding)} ${colors.cyan("║")}`,
  );

  if (description) {
    const descPadding = Math.max(0, width - 4 - description.length);
    logRaw(
      `${colors.cyan("║")} ${colors.dim(description)}${" ".repeat(descPadding)} ${colors.cyan("║")}`,
    );
  }

  logRaw(`${colors.cyan(`╚${pad}╝`)}\n`);
}

export function logSubPhase(title) {
  logRaw(`\n${colors.blue("▶")} ${colors.bold(title)}`);
}
