import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { fillBasics } from "./steps/fillBasics.js";
import { fillDetails } from "./steps/fillDetails.js";
import { fillSubmit } from "./steps/fillSubmit.js";

export async function runCcmFormFill(page, url, { rl = null } = {}) {
  log(`\n${colors.cyan("== CCM Form ==")}`);
  log(`Action: ${colors.bold("Fill out form")}\n`);
  log(`${colors.dim(url)}`);

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);

  await fillBasics(page, rl);
  await fillDetails(page, rl);
  await fillSubmit(page, rl);

  log(`\n${colors.green("✔")} CCM form flow complete.\n`);
}
