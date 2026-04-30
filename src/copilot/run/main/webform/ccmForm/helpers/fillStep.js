import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { fillFirstVisible } from "../dom.js";

export async function fillStep(page, questionLoc, inputLoc, value, successMsg) {
  await questionLoc.first().waitFor({ state: "visible", timeout: 20000 });
  await fillFirstVisible(inputLoc, value, { timeout: 20000 });
  log(`  ${colors.green("✔")} ${successMsg}`);
  await page.waitForTimeout(800);
}
