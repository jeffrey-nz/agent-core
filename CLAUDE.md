# agent-core — Claude Code guide

The **LangGraph pipeline** at the heart of the three-repo system. If the
agent is producing bad output, the fix almost always lives here (or in
`browser-ai-bridge` extraction). See
[dev-agent/ARCHITECTURE.md](https://github.com/jeffrey-nz/dev-agent/blob/master/ARCHITECTURE.md)
for the bigger picture.

## Project rule

**Fix the pipeline, not target projects.** When the agent produces bad
output in some user's workspace, the fix goes into the prompts, nodes,
or extraction code here — never into the user's workspace files.

## Top of the call stack

There are two entry functions and most external callers use `runCopilotFlow`:

- `runCopilotFlow(options)` — [src/copilot/run/main/runCopilotFlow.js](./src/copilot/run/main/runCopilotFlow.js)
  Used by dev-agent. Handles scoping, smoke tests, finalisation, GitHub sync.
- `runAgent(params)` — [src/agent/index.js](./src/agent/index.js)
  Just builds and invokes the LangGraph workflow. Called by `runCopilotFlow`.

`runAgent` → `buildAgentWorkflow()` → invokes nodes per the edges in
[src/agent/graph/workflow.js](./src/agent/graph/workflow.js).

## The LangGraph workflow

Nodes live in [src/agent/graph/nodes/](./src/agent/graph/nodes/):

| Node | What it does | Where to look for prompt issues |
|---|---|---|
| `intentNode` | Classifies the task | `personas.js` (intent persona) |
| `contextRetrieverNode` | Reads project context | Graph state, not prompt-heavy |
| `orchestratorNode` | Decides which subtask to run next | Transition logic |
| `projectManagerNode` | Generates the execution plan | `personas.js` (PM persona) |
| `coderNode` | Writes/edits files for one subtask | `personas.js` (coder), `utils/projectDirectives.js` |
| `criticNode` | Reviews coder output | `personas.js` (critic) |
| `debuggerNode` | Investigates verifier failures | `personas.js` (debugger) |
| `directWriterNode` | Plain prose tasks (no scope/plan loop) | `personas.js` |
| `environmentNode` | Probes the build/test environment | Tool definitions in `agent/tools/` |
| `githubSyncNode` | Mirrors issues/PRs to GitHub | `src/github/` |
| `memoryUpdateNode` | Persists learned constraints | `src/agent/graph/state.js` |

Transitions are in `src/agent/graph/transitions/`. State shape is in
`src/agent/graph/state.js`.

## Where prompts come from

1. **Personas** — `src/agent/graph/personas.js` defines the system prompt
   for each node. This is the first place to look when the LLM
   misbehaves at a particular phase.
2. **Project directives** — `src/utils/projectDirectives.js` adds quality
   standards to coder prompts (e.g. "no React without scaffold", "no
   prose in JSON tool outputs").
3. **Task-type prompts** — `src/projects/<type>/` overrides for specific
   task types (Godot, React, doc generation).

## Where LLM output gets parsed

agent-core treats every LLM response as **structured tool calls** (JSON).
The parser lives at `src/providers/factory/automation/actions/jsonTools.js`.
This is also where:

- **Diagnostics spam** is hard-blocked (PRM-style low-reward signal).
- **Prose-only responses** are detected and converted to `[]` for read-only
  phases (researcher / scoper) instead of triggering retries.

If the agent loops on a malformed response, look here.

## Provider layer (the bridge connection)

```
agent-core node
    │ provider.sendTurn(text, label)
    ▼
src/providers/factory/automationApi/sendTurn.js
    │ HTTP POST /api/ask  ← attaches state.pendingAttachments on first turn
    ▼
src/providers/api/interaction.js / client.js
    │
    ▼
browser-ai-bridge (separate process)
```

Key state on `automationState`:
- `pendingAttachments` — images to send with the next turn, cleared after first send
- `sessionContext` — full graph state used to build a rich handoff prompt
  when the browser session rotates (context-limit hit). See
  [src/providers/factory/rotation.js](./src/providers/factory/rotation.js).

## Common pitfalls

- **Adding a new event** for the UI? Make sure dev-agent's
  `FORWARDED_EVENTS` in `agentSession.js` includes it. Emit via
  `eventBus.emit(...)` from `src/web/eventBus.js`.
- **New node?** Update three places: register in `workflow.js`, add a
  persona in `personas.js`, add edges in `transitions/`.
- **Don't `console.log`** for user-facing output — use `src/ui/log.js`.
  It respects the panel/dashboard rendering.
- **Path aliases** — this repo uses Node subpath imports (`#agent/...`,
  `#utils/...`, etc.). They're declared in `package.json#imports`. Adding
  a new top-level folder under `src/` requires adding an `#alias/*` entry.

## Tests

There aren't any yet. Adding `node --test`-based tests under `tests/` is a
fine next step; mirror the layout used by browser-ai-bridge.

## Modern AI theory applied (reference)

The pipeline draws on a few published techniques (see
`memory/project_architecture.md` for citations):

- **PRM** — diagnostics spam treated as low-reward signal, hard-blocked.
- **Constitutional AI** — React scaffold hazard injection in coder system prompt.
- **Reflexion** — verbal lessons from prior failed attempts.
- **Tree-of-Thought diversity** — different retry strategies at each retry level.
