/**
 * Persona registry - defines every persona in the pipeline.
 * Imported by nodes (to emit persona_change events) and by the frontend
 * (to build the persona roster UI).
 *
 * Canonical persona fields:
 * id - stable key used in state and events
 * name - short internal name (defaults to label)
 * title - display title shown in the UI (defaults to label)
 * role - role descriptor (defaults to description)
 * icon - single character shown in badges / roster pills
 * color - hex accent color for the persona
 * description - one-line role summary
 * ordering - stable numeric ordering for roster display
 *
 * Back-compat fields (kept for existing consumers):
 * label - legacy display name
 * phase - the PHASE string emitted with phase_change when this persona runs
 */
const RAW_PERSONAS = {
  orchestrator: {
    id: "orchestrator",
    label: "Orchestrator",
    icon: "⬡",
    color: "#f97316",
    description: "Classifies the task and selects the appropriate pipeline",
    phase: "ORCHESTRATING",
  },
  researcher: {
    id: "researcher",
    label: "Researcher",
    icon: "🔍",
    color: "#7c6af7",
    description: "Explores the codebase and compiles a research report",
    phase: "RESEARCHING",
  },
  scoper: {
    id: "scoper",
    label: "Scoper",
    icon: "⊕",
    color: "#2ea7e0",
    description: "Maps exact file locations, line numbers, and dependencies",
    phase: "SCOPING",
  },
  projectManager: {
    id: "projectManager",
    label: "Project Manager",
    icon: "◈",
    color: "#e6a817",
    description: "Plans the execution strategy and breaks work into subtasks",
    phase: "PLANNING",
  },
  coder: {
    id: "coder",
    label: "Coder",
    icon: "⌨",
    color: "#4caf8a",
    description: "Implements the current subtask",
    phase: "EXECUTION",
  },
  verifier: {
    id: "verifier",
    label: "Verifier",
    icon: "✓",
    color: "#9e9e9e",
    description: "Validates syntax and compilation",
    phase: "VERIFYING",
  },
  debugger: {
    id: "debugger",
    label: "Debugger",
    icon: "🔎",
    color: "#e6a817",
    description: "Investigates root cause after repeated coder failures",
    phase: "DEBUGGING",
  },
  stuckAnalyzer: {
    id: "stuckAnalyzer",
    label: "Stuck Analyzer",
    icon: "🧠",
    color: "#c77dff",
    description: "Deep failure-pattern analysis - revises strategy after all retries exhausted",
    phase: "RESEARCHING",
  },
  securityReviewer: {
    id: "securityReviewer",
    label: "Security Review",
    icon: "⚑",
    color: "#e05252",
    description: "Audits changes for security issues",
    phase: "REVIEWING",
  },
  requirementsReviewer: {
    id: "requirementsReviewer",
    label: "Requirements Review",
    icon: "✔",
    color: "#a0a0c8",
    description: "Checks completeness against the original task",
    phase: "REVIEWING",
  },
  directWriter: {
    id: "directWriter",
    label: "Writer",
    icon: "✍",
    color: "#22c55e",
    description: "Saves the document to disk",
    phase: "WRITING",
  },
  planReviewer: {
    id: "planReviewer",
    label: "Plan Reviewer",
    icon: "↻",
    color: "#e6a817",
    description: "Reviews and adapts remaining subtasks after each completed step",
    phase: "PLANNING",
  },
  intent: {
    id: "intent",
    label: "Intent Analyst",
    icon: "◎",
    color: "#f59e0b",
    description: "Analyses user intent to define goal, success criteria, and constraints",
    phase: "PLANNING",
  },
  refiner: {
    id: "refiner",
    label: "Research Refiner",
    icon: "◈",
    color: "#818cf8",
    description: "Condenses research into focused, implementation-ready key findings",
    phase: "RESEARCHING",
  },
  planValidator: {
    id: "planValidator",
    label: "Plan Validator",
    icon: "⊘",
    color: "#06b6d4",
    description: "Validates the execution plan against intent and scope before coding begins",
    phase: "PLANNING",
  },
  aiAutomationEngineer: {
    id: "aiAutomationEngineer",
    label: "AI-Augmented Automation Engineer",
    icon: "🤖",
    color: "#00a8ff",
    description: "Designs and runs AI-assisted browser automation tests",
    phase: "EXECUTION",
  },
  aiSuggestionReviewer: {
    id: "aiSuggestionReviewer",
    label: "Reviewer of AI Suggestions",
    icon: "👁",
    color: "#f39c12",
    description: "Validates AI-generated selectors and test scenarios",
    phase: "REVIEWING",
  },
  critic: {
    id: "critic",
    label: "Adversarial Critic",
    icon: "⚡",
    color: "#ef4444",
    description: "Red-teams the plan to surface hidden risks and failure points before coding",
    phase: "PLANNING",
  },
  contextRetriever: {
    id: "contextRetriever",
    label: "Memory Retriever",
    icon: "📖",
    color: "#8b5cf6",
    description: "Loads relevant knowledge from past sessions before research begins",
    phase: "RESEARCHING",
  },
  environment: {
    id: "environment",
    label: "Environment Inspector",
    icon: "🌐",
    color: "#0ea5e9",
    description: "Establishes HTTP baseline and environment health before implementation",
    phase: "VERIFYING",
  },
  patchReviewer: {
    id: "patchReviewer",
    label: "Patch Reviewer",
    icon: "🔬",
    color: "#f59e0b",
    description: "Deterministic diff checker: syntax, exports, duplicates, ID consistency",
    phase: "VERIFYING",
  },
};

/** Ordered list for roster display (pipeline order). */
export const PERSONA_ORDER = [
  "orchestrator",
  "intent",
  "contextRetriever",
  "researcher",
  "refiner",
  "directWriter",
  "scoper",
  "projectManager",
  "planValidator",
  "critic",
  "environment",
  "coder",
  "patchReviewer",
  "planReviewer",
  "verifier",
  "debugger",
  "stuckAnalyzer",
  "securityReviewer",
  "requirementsReviewer",
];

/** Convenience helper used by nodes. */
function normalizePersonas(raw, orderList) {
 const orderIndex = new Map(
 (Array.isArray(orderList) ? orderList : []).map((personaId, idx) => [personaId, idx + 1]),
 );

 const out = {};
 for (const [key, value] of Object.entries(raw || {})) {
 const p = value && typeof value === "object" ? { ...value } : {};
 const id = typeof p.id === "string" && p.id ? p.id : key;

 // Legacy display field
 const label =
 typeof p.label === "string" && p.label
 ? p.label
 : typeof p.title === "string" && p.title
 ? p.title
 : typeof p.name === "string" && p.name
 ? p.name
 : id;

 // Canonical fields
 const name = typeof p.name === "string" && p.name ? p.name : label;
 const title = typeof p.title === "string" && p.title ? p.title : label;
 const description = typeof p.description === "string" ? p.description : "";
 const role = typeof p.role === "string" && p.role ? p.role : description;

 const ordering =
 typeof p.ordering === "number" && Number.isFinite(p.ordering)
 ? p.ordering
 : orderIndex.get(id) || orderIndex.get(key) || 9999;

 out[key] = {
 ...p,
 id,
 name,
 title,
 role,
 description,
 ordering,
 // Back-compat
 label,
 phase: p.phase,
 };
 }

 return out;
}

// Preserve existing exports used by reconnect + roster.
export const PERSONAS = normalizePersonas(RAW_PERSONAS, PERSONA_ORDER);

export function personaMeta(id) {
 return (
 PERSONAS[id] ?? {
 id,
 // Canonical fields
 name: id,
 title: id,
 role: "",
 description: "",
 ordering: 9999,
 // Back-compat
 label: id,
 icon: "◉",
 color: "#888888",
 phase: "",
 }
 );
}
