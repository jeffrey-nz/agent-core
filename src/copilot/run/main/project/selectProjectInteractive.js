import { askChoice } from "#app/ui/readline/index.js";

export async function selectProjectInteractive(projects, rl) {
  const project = await existingProjectSelector(projects, rl);

  const bootstrap = await askChoice(
    rl,
    "How should this project be initialized?",
    [
      {
        label: "Crawl project files dynamically (default)",
        value: "crawl",
      },
      {
        label:
          "Upload entire project as context first (recommended for audits/refactors)",
        value: "upload",
      },
    ],
    { defaultValue: "crawl" },
  );

  return {
    ...project,
    bootstrapMode: bootstrap,
  };
}
