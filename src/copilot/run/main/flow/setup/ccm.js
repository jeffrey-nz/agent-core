import process from "node:process";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { tryConnectWithRetry } from "#copilot/client/browser.js";
import { runCcmFormFill } from "#copilot/run/main/webform/ccmForm/index.js";

export async function prepareCcmFormSession(options) {
  const { project, rl } = options;
  const url = project?.url ? String(project.url).trim() : "";
  if (!url) throw new Error("CRITICAL: CCM form project is missing 'url'.");

  const { browser } = await tryConnectWithRetry(5);
  const context = browser.contexts()[0];

  browser.on("disconnected", () => {
    log(`\n${colors.red("⚠️  FATAL: Browser was disconnected.")}`);
    process.exit(1);
  });

  const page =
    context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  await page.bringToFront();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  await runCcmFormFill(page, url, { rl });

  return {
    kind: "ccm_form",
    gitDir: options.targetRepoDir || options.projectDir,
    close: async () => await browser.close(),
  };
}
