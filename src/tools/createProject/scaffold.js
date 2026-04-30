import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { colors } from "#app/ui/colors.js";
import { createSpinner } from "#app/ui/spinner.js";
import { generateConfigJson, generateProjectJs } from "./templates.js";

export async function scaffoldProject(details) {
  const { parentName, projectName } = details;

  const projectRoot = path.join(
    process.cwd(),
    "projects",
    parentName,
    projectName,
  );

  const spinner = createSpinner("Scaffolding project...").start();

  await fs.mkdir(projectRoot, { recursive: true });

  const configData = generateConfigJson(projectName, parentName);
  await fs.writeFile(path.join(projectRoot, "config.json"), configData, "utf8");

  const projectJsContent = generateProjectJs(details);
  await fs.writeFile(
    path.join(projectRoot, "project.js"),
    projectJsContent,
    "utf8",
  );

  spinner.succeed(`Project scaffolded in ${projectRoot}`);

  console.log(
    `You can now run ${colors.bold("npm start")} and select ${colors.cyan(projectName)}.`,
  );
}
