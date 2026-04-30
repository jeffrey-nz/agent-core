import { z } from "zod";

export const githubTools = {
  github_create_issue: {
    description:
      "Create a GitHub issue in the project repository. Automatically checks for a duplicate with the same title first — returns the existing issue if found. New issues are added to the project board in Backlog automatically. Use to log bugs, track future work, or document blockers.",
    parameters: z.object({
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Issue body (markdown supported)"),
      labels: z.array(z.string()).optional().describe("Label names to apply, e.g. ['bug', 'automated']"),
    }),
  },

  github_update_issue: {
    description: "Add a comment to an existing GitHub issue, or close it.",
    parameters: z.object({
      issue_number: z.number().int().describe("The issue number"),
      comment: z.string().optional().describe("Comment text to add"),
      close: z.boolean().optional().describe("Set true to close the issue"),
    }),
  },

  github_get_issues: {
    description:
      "List open GitHub issues for the project. Use to check what work is outstanding before starting a task.",
    parameters: z.object({
      label: z.string().optional().describe("Filter by label, e.g. 'bug' or 'copilot-task'"),
      limit: z.number().int().optional().default(20).describe("Max issues to return"),
    }),
  },

  docs_write_page: {
    description:
      "Write or update a local markdown documentation page for this project. Use for research findings, architecture notes, or decision logs. Pages live in docs/ in the project folder. Supports nested pages like 'Research/caching'.",
    parameters: z.object({
      page: z.string().describe("Page name, e.g. 'Architecture' or 'Research/caching-strategy'"),
      content: z.string().describe("Full markdown content for the page"),
    }),
  },

  github_move_card: {
    description:
      "Move an issue's Kanban card to a different column on the project board.",
    parameters: z.object({
      issue_number: z.number().int().describe("The issue number to move"),
      column: z
        .enum(["Backlog", "In Progress", "Review", "Done"])
        .describe("Target column"),
    }),
  },

  github_trigger_workflow: {
    description:
      "Trigger a GitHub Actions workflow by its filename (e.g. 'deploy.yml'). Use to run CI, build, or deployment pipelines.",
    parameters: z.object({
      workflow: z.string().describe("Workflow file name, e.g. 'deploy.yml'"),
      ref: z.string().optional().default("main").describe("Branch or tag to run on"),
      inputs: z.record(z.string()).optional().describe("workflow_dispatch inputs"),
    }),
  },
};
