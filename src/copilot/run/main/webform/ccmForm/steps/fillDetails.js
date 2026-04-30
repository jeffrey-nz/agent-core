import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { tryClickAny, clickFirstVisible } from "../dom.js";
import * as sel from "../selectors.js";
import * as prm from "../prompts/index.js";
import { fillStep } from "../helpers/fillStep.js";

export async function fillDetails(page, rl) {
  log(`\n${colors.dim("7) Capturing Date/Time Down (CLI prompt)...")}`);
  const dateTimeDown = await prm.promptDateTimeDown(rl);
  const dt = sel.dateTimeDownSelectors(page);
  await fillStep(
    page,
    dt.dateTimeQuestion,
    dt.dateTimeInput,
    dateTimeDown,
    "Entered Date/Time Down.",
  );

  log(`\n${colors.dim("8) Setting estimated outage length...")}`);
  const ol = sel.outageLengthSelectors(page);
  await fillStep(
    page,
    ol.outageLengthQuestion,
    ol.outageLengthInput,
    "15 minutes",
    "Entered estimated outage length.",
  );

  log(`\n${colors.dim("9) Selecting stakeholders recommended: Yes...")}`);
  const sr = sel.stakeholdersRecommendedSelectors(page);
  await sr.stakeholdersRecommendedQuestion
    .first()
    .waitFor({ state: "visible", timeout: 20000 });
  await tryClickAny("Stakeholders recommended - Yes", [
    async () => clickFirstVisible(sr.yesRadioByAutomation, { timeout: 20000 }),
    async () => clickFirstVisible(sr.yesByChoiceItemText, { timeout: 20000 }),
    async () => clickFirstVisible(sr.yesByAriaLabel, { timeout: 20000 }),
  ]);
  log(`  ${colors.green("✔")} Selected: Stakeholders recommended = Yes.`);
  await page.waitForTimeout(900);

  log(`\n${colors.dim("10) Filling reason change is required...")}`);
  const rcr = sel.reasonChangeRequiredSelectors(page);
  await fillStep(
    page,
    rcr.question,
    rcr.input,
    "Requested",
    "Entered reason change is required.",
  );

  log(`\n${colors.dim("11) Filling expected impact of the change...")}`);
  const ei = sel.expectedImpactSelectors(page);
  await fillStep(
    page,
    ei.question,
    ei.input,
    "Website gets updated",
    "Entered expected impact.",
  );

  log(`\n${colors.dim("12) Filling escalation plan...")}`);
  const ep = sel.escalationPlanSelectors(page);
  await fillStep(
    page,
    ep.question,
    ep.input,
    "Rollback",
    "Entered escalation plan.",
  );

  log(`\n${colors.dim("13) Filling communications plan...")}`);
  const cp = sel.communicationsPlanSelectors(page);
  await fillStep(
    page,
    cp.question,
    cp.input,
    "email",
    "Entered communications plan.",
  );

  log(`\n${colors.dim("14) Filling risks and rollback details...")}`);
  const rr = sel.risksAndRollbackSelectors(page);
  await fillStep(
    page,
    rr.question,
    rr.input,
    "Rollback",
    "Entered risks and rollback plan.",
  );
}
