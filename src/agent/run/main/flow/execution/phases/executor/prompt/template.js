export function getWorkerTemplate(
  stepTitle,
  mustReadSection,
  doneSection,
  truncatedTask,
) {
  return `[MICRO-WORKER]
TASK: "${stepTitle}"
${mustReadSection}

## 💾 AGENT MEMORY SYSTEM (INTERNAL)
- Project files are kept clean. Your progress logs (.ai-status.md) and plans (.ai-plan.json) are handled by the HOST system.
- DO NOT search for or attempt to read ".ai-status.md" or ".ai-plan.json" manually. 
- All relevant context from previous turns has already been injected into your [OVERALL CONTEXT] below.

## YOUR FIRST RESPONSE MUST BE A JSON TOOL ARRAY
... (rest of existing template) ...
`;
}
