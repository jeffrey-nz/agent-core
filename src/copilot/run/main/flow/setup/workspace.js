import fs from "node:fs/promises";
import path from "node:path";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import {
  checkoutBranch,
  cleanGitWorkspace,
} from "#copilot/run/main/gitPhase.js";
import { askYesNo } from "#app/ui/readline/index.js";
import {
  suspendDashboardForPrompt,
  resumeDashboardAfterPrompt,
} from "#app/ui/dashboard.js";
import { isWebMode } from "#web/mode.js";
import { getSessionDir } from "#copilot/run/main/sessionState/paths.js";

export async function configureWorkspace(options, gitDir) {
  const { branch, sessionInfo, rl, autoReset, projectId, clearWorkspace } =
    options;

  const shouldClear =
    clearWorkspace !== undefined ? clearWorkspace : sessionInfo.isNew;

  if (shouldClear) {
    if (gitDir) {
      let doReset = autoReset;

      if (doReset === undefined) {
        if (isWebMode()) {
          doReset = true;
        } else {
          suspendDashboardForPrompt();
          doReset = await askYesNo(
            rl,
            "Do you want to reset the git workspace to a clean state?",
            { defaultYes: true },
          );
          resumeDashboardAfterPrompt();
        }
      }

      if (doReset) {
        await cleanGitWorkspace(gitDir);
      }

      try {
        await fs.unlink(path.join(gitDir, ".ai-plan.json"));
        await fs.unlink(path.join(gitDir, ".ai-status.md"));
      } catch (e) {}
    }

    try {
      const internalDir = await getSessionDir(projectId);
      await fs.unlink(path.join(internalDir, ".ai-plan.json")).catch(() => {});
      await fs.unlink(path.join(internalDir, ".ai-status.md")).catch(() => {});

      log(
        colors.dim(
          `  [Workspace] Cleared previous .ai-plan.json and .ai-status.md context.`,
        ),
      );
    } catch (e) {
      log(
        colors.dim(`  [Workspace] Failed to clear session dir: ${e.message}`),
      );
    }
  }

  if (branch && gitDir && sessionInfo.isNew) {
    await checkoutBranch(gitDir, branch);
  }
}
