import { makeRl, closeRl } from "#app/ui/readline/index.js";
import { colors } from "#app/ui/colors.js";
import { askProjectDetails } from "./createProject/questions.js";
import { scaffoldProject } from "./createProject/scaffold.js";
import { handleError } from "#utils/errorWithSuggestion.js";

async function main() {
  console.log(`\n${colors.cyan("=== Copilot Helper: Project Scaffolder ===")}`);

  const rl = makeRl();

  try {
    const details = await askProjectDetails(rl);
    await scaffoldProject(details);
  } catch (err) {
    handleError(err);
  } finally {
    closeRl(rl);
  }
}

main();
