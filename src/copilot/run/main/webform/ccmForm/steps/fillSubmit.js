import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { clickFirstVisible } from "../dom.js";
import * as sel from "../selectors.js";
import * as prm from "../prompts/index.js";
import { fillStep } from "../helpers/fillStep.js";

export async function fillSubmit(page, rl) {
  if (rl) {
    log(
      `\n${colors.dim("15) Capturing approver / peer reviewer name (CLI prompt)...")}`,
    );
    const approverName = await prm.promptApproverName(rl);
    const an = sel.approverNameSelectors(page);
    await fillStep(
      page,
      an.approverNameQuestion,
      an.approverNameInput,
      approverName,
      "Entered Approver Name.",
    );

    log(
      `\n${colors.dim("16) Capturing approver email address (CLI prompt)...")}`,
    );
    const approverEmail = await prm.promptApproverEmail(rl);
    const ae = sel.approverEmailSelectors(page);
    await fillStep(
      page,
      ae.approverEmailQuestion,
      ae.approverEmailInput,
      approverEmail,
      "Entered Approver Email.",
    );

    log(
      `\n${colors.dim("17) Capturing description of proposed change (CLI prompt)...")}`,
    );
    const description = await prm.promptDescriptionOfProposedChange(rl);
    const dc = sel.descriptionOfChangeSelectors(page);
    await fillStep(
      page,
      dc.descriptionQuestion,
      dc.descriptionInput,
      description,
      "Entered description of change.",
    );
  }

  log(`\n${colors.dim("Submitting form...")}`);
  const { submitBtn, maybeThanks } = sel.submitSelectors(page);
  await clickFirstVisible(submitBtn, { timeout: 20000 });
  log(`  ${colors.green("✔")} Submit clicked.`);
  await page.waitForTimeout(1500);
  await maybeThanks
    .first()
    .waitFor({ state: "visible", timeout: 4000 })
    .catch(() => {});
}
