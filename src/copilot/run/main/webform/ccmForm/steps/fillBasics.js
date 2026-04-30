import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";
import { tryClickAny, clickFirstVisible } from "../dom.js";
import * as sel from "../selectors.js";
import * as prm from "../prompts/index.js";
import { fillStep } from "../helpers/fillStep.js";

export async function fillBasics(page, rl) {
  log(`\n${colors.dim("1) Selecting urgency:")} Non-Urgent...`);
  const urg = sel.urgencySelectors(page);
  await tryClickAny("Non-Urgent", [
    async () =>
      clickFirstVisible(urg.nonUrgentByAutomation, { timeout: 20000 }),
    async () =>
      clickFirstVisible(urg.nonUrgentByChoiceItemText, { timeout: 20000 }),
    async () => clickFirstVisible(urg.nonUrgentByAriaLabel, { timeout: 20000 }),
  ]);
  log(`  ${colors.green("✔")} Selected Non-Urgent.`);
  await page.waitForTimeout(1200);

  log(`\n${colors.dim("2) Selecting team:")} Web Development...`);
  const tm = sel.teamQuestionSelectors(page);
  await tm.teamQuestion.first().waitFor({ state: "visible", timeout: 20000 });
  await tryClickAny("Web Development", [
    async () =>
      clickFirstVisible(tm.webDevRadioByAutomation, { timeout: 20000 }),
    async () =>
      clickFirstVisible(tm.webDevByChoiceItemText, { timeout: 20000 }),
    async () => clickFirstVisible(tm.webDevByAriaLabel, { timeout: 20000 }),
  ]);
  log(`  ${colors.green("✔")} Selected Web Development.`);

  log(`\n${colors.dim("3) Capturing change name (CLI prompt)...")}`);
  const changeName = await prm.promptChangeName(rl);
  const cn = sel.changeNameSelectors(page);
  await fillStep(
    page,
    cn.changeNameQuestion,
    cn.changeNameInput,
    changeName,
    "Entered Change Name.",
  );

  log(
    `\n${colors.dim("4) Selecting system or service affected (CLI prompt)...")}`,
  );
  const systemAffected = await prm.promptSystemAffected(rl);
  const sa = sel.systemAffectedSelectors(page);
  await fillStep(
    page,
    sa.systemQuestion,
    sa.systemInput,
    systemAffected,
    "Entered System or Service affected.",
  );

  log(`\n${colors.dim("5) Selecting stakeholders to notify (CLI prompt)...")}`);
  const stakeholders = await prm.promptStakeholders(rl);
  const st = sel.stakeholdersSelectors(page);
  await fillStep(
    page,
    st.stakeholdersQuestion,
    st.stakeholdersInput,
    stakeholders,
    "Entered stakeholders involved.",
  );

  log(
    `\n${colors.dim("6) Capturing specific people to notify (CLI prompt)...")}`,
  );
  const specificPeople = await prm.promptSpecificPeople(rl);
  const sp = sel.specificPeopleSelectors(page);
  await fillStep(
    page,
    sp.specificPeopleQuestion,
    sp.specificPeopleInput,
    specificPeople,
    "Entered specific people.",
  );
}
