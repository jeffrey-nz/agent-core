import { generateText } from "ai";
import { detectProjectContext } from "#utils/detectProjectContext.js";
import { buildTddDirective, buildPlannerVerificationDirective } from "#utils/projectDirectives.js";
import { setDashboardState } from "#app/ui/dashboard.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { eventBus } from "#web/eventBus.js";

export async function plannerNode(state) {
  log(colors.magenta("  [Graph] -> Running Planner Agent (Sub-Task Mode)..."));
  eventBus.emit("phase_change", { phase: "PLANNING", label: "Planning..." });

  // Use constraints already computed by the researcher node if available;
  // otherwise detect fresh (avoids a second filesystem scan).
  const projectConstraints =
    state.projectConstraints ||
    detectProjectContext(state.projectDir).constraints;
  const tddSection = buildTddDirective(state.projectType);

  const systemPrompt = `You are a Lead Engineering Planner.
${tddSection}

${projectConstraints}

You must take the original user request and the Research Report, and break the work down into atomic, discrete subtasks.

OUTPUT FORMAT:
You MUST output a JSON object containing a "plan" string and a "subtasks" array.
Each subtask MUST include these fields:
- "id": sequential integer
- "task": specific description of what to implement, including exact file path(s)
- "files": array of exact file paths (relative to project root) that will be created or modified
- "constraints": any subtask-specific constraints (e.g. "must extend MonoBehaviour", "USS only - no C# needed")

Example:
\`\`\`json
{
  "plan": "Overall summary of what we will do.",
  "subtasks": [
    {
      "id": 1,
      "task": "Create Assets/Scripts/UI/InventoryPanel.cs implementing the InventoryPanel MonoBehaviour",
      "files": ["Assets/Scripts/UI/InventoryPanel.cs"],
      "constraints": "Must extend MonoBehaviour, use namespace Game.UI, requires using UnityEngine.UIElements"
    },
    {
      "id": 2,
      "task": "Create Assets/UI Toolkit/InventoryPanel.uxml with the panel layout",
      "files": ["Assets/UI Toolkit/InventoryPanel.uxml"],
      "constraints": "UXML only - no C# compilation needed. Must start with <ui:UXML xmlns:ui=\\"UnityEngine.UIElements\\">"
    }
  ]
}
\`\`\`

CRITICAL RULES FOR SUBTASKS:
- Every subtask MUST specify the exact file(s) to create or modify in both "task" and "files".
- Subtasks must result in concrete file changes - do NOT create subtasks that only research, analyse, or document.
- Do NOT include subtasks whose sole output is a markdown or documentation file.
- Read-only investigation steps must be folded into the implementation subtask that acts on the findings.
- Keep subtasks small and isolated so they can be executed and verified one by one.
- Each subtask description must be specific enough that the coder can act on it without further research.

VERIFICATION SUBTASK RULE (CRITICAL):
If the original task involves FIXING an error, exception, crash, or failing command, the LAST subtask MUST be a standalone verification subtask. That verification subtask MUST explicitly reference the "Definition of done" from the Scope Document (if available) and map each verification step to a specific check. This subtask:
- Must have "files": [] (no file writes - only command execution)
- Must name the exact command(s) to run
- Must be marked with constraints: "VERIFICATION ONLY - run the command and report the real, unabridged output. PASS only if the command exits without errors."
- The Research Report's 'Verification command:' finding should be used if present.

${buildPlannerVerificationDirective(state.projectType)}
Examples:
- "fix the phpunit failure" → last subtask: "Run phpunit and confirm all tests pass"
- "fix the composer dependency error" → last subtask: "Run composer install and confirm it resolves without conflicts"`;

  /** @type {import('ai').ModelMessage[]} */
  const planningMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `ORIGINAL TASK:\n${state.messages[0].content}` },
    { role: "user", content: `RESEARCH REPORT:\n${state.researchContext}` },
  ];

  let planText = "";

  if (state.model) {
    const { text } = await generateText({
      model: state.model,
      messages: planningMessages,
    });
    planText = text;
  } else {
    const result = await state.provider.sendTurn(planningMessages, "planner", {
      rootDir: state.projectDir,
      interactionMode: "scoping",
    });
    planText = result.text ?? "";
    if (planText) {
      eventBus.emit("message_complete", { text: planText });
    }
  }

  let subtasks = [];
  let executionPlan = planText;

  try {
    const firstBrace = planText.indexOf("{");
    const lastBrace = planText.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonStr = planText.substring(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(jsonStr);
      subtasks = parsed.subtasks || [];
      executionPlan = parsed.plan || planText;
    } else {
      throw new Error("Could not locate JSON brackets in output.");
    }
  } catch (e) {
    log(
      colors.yellow(
        "  [Graph] -> Warning: Planner did not output clean JSON. Operating as single task.",
      ),
    );
    subtasks = [{ id: 1, task: "Complete the entire plan", files: [], constraints: "" }];
  }

  // Normalize all subtasks to the enriched schema with defaults for missing fields.
  subtasks = subtasks.map((s) => ({
    id: s.id,
    task: s.task,
    files: Array.isArray(s.files) ? s.files : [],
    constraints: typeof s.constraints === "string" ? s.constraints : "",
  }));

  const planSteps = subtasks.map((s) => ({
    id: s.id,
    label: s.task,
    state: "pending",
  }));
  setDashboardState({
    plan: { steps: planSteps },
    activeTaskId: null,
    completedCount: 0,
    totalCount: planSteps.length,
  });

  log(
    colors.green(
      `  [Graph] -> Plan Generated with ${subtasks.length} subtask(s).`,
    ),
  );

  return {
    executionPlan,
    subtasks,
    currentSubtaskIndex: 0,
  };
}
