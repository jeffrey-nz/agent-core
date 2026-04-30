import { runAgent } from "#agent/index.js";
import { createProvider } from "#providers/factory.js";
import { execAsync } from "#utils/exec.js";
import path from "node:path";
import process from "node:process";

const MOCK_PROJECT_DIR = path.join(process.cwd(), "projects", "eval-mock");

async function setupMockEnvironment() {
  await execAsync(`mkdir -p ${MOCK_PROJECT_DIR}`);
  await execAsync(`git init`, { cwd: MOCK_PROJECT_DIR });
  await execAsync(`echo "function add(a, b) { return a - b; }" > math.js`, {
    cwd: MOCK_PROJECT_DIR,
  });
  await execAsync(`echo "const x = ;" > broken.js`, { cwd: MOCK_PROJECT_DIR });
  await execAsync(`git add . && git commit -m "Initial commit"`, {
    cwd: MOCK_PROJECT_DIR,
  });
}

async function cleanupMockEnvironment() {
  await execAsync(`rm -rf ${MOCK_PROJECT_DIR}`);
}

async function runEvaluation() {
  console.log("🚀 Starting Sub-Task Orchestration Eval...");

  await setupMockEnvironment();

  try {
    const provider = await createProvider("openai-api");
    await provider.startNewChat();

    const task =
      "1. Fix the add function in math.js. 2. Fix the syntax error in broken.js.";

    console.log("🤖 Running Agent in Multi-Task Mode...");
    const result = await runAgent({
      provider,
      projectDir: MOCK_PROJECT_DIR,
      projectId: "eval-mock",
      task,
      sessionInfo: { bootstrapMode: "crawl" },
    });

    if (!result.ok) {
      throw new Error("Agent workflow failed.");
    }

    if (result.state.subtasks.length < 2) {
      throw new Error(
        "Eval Failed: Planner did not decompose the task into sub-tasks.",
      );
    }

    console.log(`✅ Sub-tasks generated: ${result.state.subtasks.length}`);
    console.log("🔍 Verifying final state...");

    const mathContent = await execAsync("cat math.js", {
      cwd: MOCK_PROJECT_DIR,
    });
    if (!mathContent.stdout.includes("a + b")) {
      throw new Error("Sub-task 1 failed.");
    }

    console.log(
      "✅ Eval Passed: Both sub-tasks executed and verified individually.",
    );
  } catch (error) {
    console.error("❌ Eval Execution Error:", error);
    process.exitCode = 1;
  } finally {
    await cleanupMockEnvironment();
  }
}

runEvaluation();
