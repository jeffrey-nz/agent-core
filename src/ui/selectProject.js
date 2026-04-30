import process from "node:process";
import { makeRl, closeRl, askLine } from "#app/ui/readline/index.js";
import { colors } from "#app/ui/colors.js";

export async function selectProjectInteractive(projectsInput, rlMaybe) {
  const projects = normalizeProjectsInput(projectsInput);

  if (!projects || projects.length === 0) {
    throw new Error(
      "No projects found under projects/. A project is detected when the folder contains one of: meta.json, config.json, or project.js",
    );
  }

  const rl = rlMaybe || makeRl();
  const shouldClose = !rlMaybe;

  try {
    if (projects.length === 1) {
      const only = projects[0];
      process.stdout.write(
        `\nProject: ${colors.cyan(only.parent)} / ${colors.cyan(only.name)} ${colors.dim("(only project found)")}\n\n`,
      );
      return only;
    }

    const groups = groupByParent(projects);
    const indexToProject = displayProjectList(groups);

    return await promptForProject(rl, indexToProject);
  } finally {
    if (shouldClose) closeRl(rl);
  }
}

function normalizeProjectsInput(projects) {
  if (Array.isArray(projects)) return projects;
  if (
    projects &&
    typeof projects === "object" &&
    Array.isArray(projects.projects)
  ) {
    return projects.projects;
  }
  return null;
}

function groupByParent(projects) {
  const map = new Map();
  for (const p of projects) {
    const key = p.parent || "(unknown)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return map;
}

function displayProjectList(groups) {
  const indexToProject = new Map();
  let idx = 1;

  process.stdout.write(
    `\n${colors.bgBlue(colors.white(" 📦 SELECT A PROJECT "))}\n\n`,
  );

  for (const [parent, items] of groups.entries()) {
    const groupName = parent.charAt(0).toUpperCase() + parent.slice(1);
    process.stdout.write(`${colors.magenta(colors.bold(`▶ ${groupName}`))}\n`);

    for (const item of items) {
      indexToProject.set(idx, item);

      const displayName = item.project?.title
        ? item.project.title.split("/").pop().trim()
        : item.name;

      const numStr = String(idx).padStart(2, " ");
      const isDef = idx === 1;
      const formattedName = isDef ? colors.bold(displayName) : displayName;

      process.stdout.write(
        `  ${colors.cyan(`${numStr}.`)} ${formattedName}${isDef ? colors.dim(" (Default)") : ""}\n`,
      );
      idx++;
    }
    process.stdout.write("\n");
  }

  return indexToProject;
}

async function promptForProject(rl, indexToProject) {
  try {
    process.stdin.resume();
  } catch {}

  while (true) {
    const answer = await askLine(
      rl,
      `Project number (Press Enter for default 1): `,
    );
    const t = String(answer ?? "").trim();

    if (!t) {
      const first = indexToProject.get(1);
      process.stdout.write(
        `\nSelected: ${colors.green(`${first.parent} / ${first.name}`)}\n\n`,
      );
      return first;
    }

    const n = Number(t);
    if (Number.isInteger(n) && indexToProject.has(n)) {
      const chosen = indexToProject.get(n);
      process.stdout.write(
        `\nSelected: ${colors.green(`${chosen.parent} / ${chosen.name}`)}\n\n`,
      );
      return chosen;
    }

    process.stdout.write(
      `${colors.red("Invalid selection.")} Please enter a listed number.\n`,
    );
  }
}
