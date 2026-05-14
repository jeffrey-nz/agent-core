# agent-core

LangGraph-powered AI coding agent pipeline. Plans, codes, verifies, and
reflects — driven entirely through browser-based LLM access (no API keys).

This is the **engine** of a three-repo system. See
[dev-agent/ARCHITECTURE.md](https://github.com/jeffrey-nz/dev-agent/blob/master/ARCHITECTURE.md)
for how it connects to the VS Code extension and the browser bridge.

## What it does

Given a user prompt and a project directory:

1. **Intent** — classifies the task (code generation, doc generation, etc.)
2. **Researcher** — explores the repo, gathers context
3. **Scoper** — converts the prompt into a structured scope document
4. **Project Manager** — generates an executable plan (list of subtasks)
5. **Coder** — for each subtask, writes/edits files
6. **Verifier / Critic** — runs tests, checks output, requests retries
7. **Reflexion** — captures verbal lessons from failed attempts to feed
   forward into the next try

Each step is a node in a LangGraph workflow defined in
`src/agent/graph/workflow.js`.

## Two entry points

```js
// High-level: full LangGraph workflow
import { runAgent } from "agent-core";
const result = await runAgent({
  provider,        // { id, model, ... } — created by createProvider()
  projectDir,
  task: "Build a tic-tac-toe game",
  sessionInfo: { initialPrompt: "..." },
});
```

```js
// Lower-level: copilot-style flow (used by dev-agent)
import { runCopilotFlow } from "agent-core";
await runCopilotFlow({ /* same shape */ });
```

## How it talks to the LLM

agent-core never calls an LLM API directly. Every turn goes through
[browser-ai-bridge](https://github.com/jeffrey-nz/browser-ai-bridge) at
`http://localhost:3333/api/ask`, which drives a logged-in Chrome tab.
See `src/providers/api/` for the HTTP client.

## Source layout

```
src/
├── agent/                  LangGraph workflow
│   ├── index.js            runAgent() entry
│   ├── graph/
│   │   ├── workflow.js     Edges + node registration
│   │   ├── state.js        Graph state shape
│   │   └── nodes/          One file per node (intent, coder, critic, ...)
│   ├── personas.js         System-prompt personas per node
│   └── tools/              Tools the LLM can call (filesystem, search, ...)
│
├── copilot/run/main/       Higher-level flow used by dev-agent
│   ├── runCopilotFlow.js   Top-level orchestration
│   ├── flow/               Scoping, finalisation, smoke tests
│   ├── applyFilesPhase/    File-write phase with validators
│   ├── report/             Git stats, performance reports
│   └── sessionState/       Checkpointing
│
├── providers/              LLM provider abstraction
│   ├── factory/            createProvider, automation state
│   └── api/                HTTP client for browser-ai-bridge
│
├── projects/               Per-task-type project policies
├── tools/                  Tool implementations (read, write, grep, ...)
├── verification/           Test runners, build verifiers
├── utils/                  Shared utilities
└── web/                    Event bus, WebSocket-style streaming
```

## Requirements

- Node.js >= 20
- A running [browser-ai-bridge](https://github.com/jeffrey-nz/browser-ai-bridge) server
- Active browser logins to whichever AI provider you want to use

## Standalone testing

This package doesn't have its own CLI — it's a library. Use the
[dev-agent](https://github.com/jeffrey-nz/dev-agent) `scripts/run-agent.mjs`
runner to exercise it from the command line.

## License

MIT
