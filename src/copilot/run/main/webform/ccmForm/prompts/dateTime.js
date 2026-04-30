import { promptChoice } from "#app/ui/readline/index.js";
import { formatDateDMY } from "#utils/format.js";

export async function promptDateTimeDown(existingRl = null) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const options = [];
  for (let offset = 0; offset <= 6; offset++) {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);

    const dayLabel =
      offset === 0 ? "Today" : offset === 1 ? "Tomorrow" : `In ${offset} days`;
    const daysFromNowLabel =
      offset === 0
        ? "0 days from now"
        : offset === 1
          ? "1 day from now"
          : `${offset} days from now`;

    options.push({
      label: `${dayLabel} (${formatDateDMY(d)}) — ${daysFromNowLabel}`,
      value: `${formatDateDMY(d)} 06:00am`,
    });
  }

  options.push({
    label: "Custom (enter full date/time string)",
    value: null,
  });

  return promptChoice(existingRl, "Date/Time Down (choose one):", options, {
    customPrompt: "Enter date/time (e.g. 22/11/2017 06:00am): ",
  });
}
