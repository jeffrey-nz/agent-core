export function urgencySelectors(page) {
  return {
    nonUrgentByAutomation: page.locator(
      '[data-automation-id="radio"][data-automation-value^="Non-Urgent"]',
    ),
    nonUrgentByChoiceItemText: page
      .locator('[data-automation-id="choiceItem"]')
      .filter({ hasText: /Non-Urgent/i }),
    nonUrgentByAriaLabel: page.locator('span[aria-label^="Non-Urgent"]'),
  };
}

export function teamQuestionSelectors(page) {
  const teamQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Team completing the change/i });
  return {
    teamQuestion,
    webDevRadioByAutomation: teamQuestion.locator(
      '[data-automation-id="radio"][data-automation-value="Web Development"]',
    ),
    webDevByChoiceItemText: teamQuestion
      .locator('[data-automation-id="choiceItem"]')
      .filter({ hasText: /Web Development/i }),
    webDevByAriaLabel: teamQuestion.locator(
      'span[aria-label="Web Development"]',
    ),
  };
}

export function changeNameSelectors(page) {
  const changeNameQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Change Name/i });
  return {
    changeNameQuestion,
    changeNameInput: changeNameQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function systemAffectedSelectors(page) {
  const systemQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /System or Service affected/i });
  return {
    systemQuestion,
    systemInput: systemQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function stakeholdersSelectors(page) {
  const stakeholdersQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Stakeholders involved in the change/i });
  return {
    stakeholdersQuestion,
    stakeholdersInput: stakeholdersQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function specificPeopleSelectors(page) {
  const specificPeopleQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({
      hasText: /Any specific people you want to tell about the change/i,
    });
  return {
    specificPeopleQuestion,
    specificPeopleInput: specificPeopleQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function dateTimeDownSelectors(page) {
  const dateTimeQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Date\/Time Down/i });
  return {
    dateTimeQuestion,
    dateTimeInput: dateTimeQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function outageLengthSelectors(page) {
  const outageLengthQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Estimated length of outage in minutes/i });
  return {
    outageLengthQuestion,
    outageLengthInput: outageLengthQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function stakeholdersRecommendedSelectors(page) {
  const stakeholdersRecommendedQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Stakeholders have recommended the change proceed\?/i });
  return {
    stakeholdersRecommendedQuestion,
    yesRadioByAutomation: stakeholdersRecommendedQuestion.locator(
      '[data-automation-id="radio"][data-automation-value="Yes"]',
    ),
    yesByChoiceItemText: stakeholdersRecommendedQuestion
      .locator('[data-automation-id="choiceItem"]')
      .filter({ hasText: /^Yes$/i }),
    yesByAriaLabel: stakeholdersRecommendedQuestion.locator(
      'span[aria-label="Yes"]',
    ),
  };
}

export function reasonChangeRequiredSelectors(page) {
  const question = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Reason Change is required/i });
  return {
    question,
    input: question.locator('textarea[data-automation-id="textInput"]'),
  };
}

export function expectedImpactSelectors(page) {
  const question = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Expected impact of the change/i });
  return {
    question,
    input: question.locator('textarea[data-automation-id="textInput"]'),
  };
}

export function escalationPlanSelectors(page) {
  const question = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Escalation Plan/i });
  return {
    question,
    input: question.locator('textarea[data-automation-id="textInput"]'),
  };
}

export function communicationsPlanSelectors(page) {
  const question = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Communications plan/i });
  return {
    question,
    input: question.locator('textarea[data-automation-id="textInput"]'),
  };
}

export function risksAndRollbackSelectors(page) {
  const question = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Risks including roll back plan/i });
  return {
    question,
    input: question.locator('textarea[data-automation-id="textInput"]'),
  };
}

export function approverNameSelectors(page) {
  const approverNameQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Approver\/\s*Peer Reviewer Name/i });
  return {
    approverNameQuestion,
    approverNameInput: approverNameQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function approverEmailSelectors(page) {
  const approverEmailQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Approvers email address/i });
  return {
    approverEmailQuestion,
    approverEmailInput: approverEmailQuestion.locator(
      'input[data-automation-id="textInput"]',
    ),
  };
}

export function descriptionOfChangeSelectors(page) {
  const descriptionQuestion = page
    .locator('[data-automation-id="questionItem"]')
    .filter({ hasText: /Description of proposed change/i });
  return {
    descriptionQuestion,
    descriptionInput: descriptionQuestion.locator(
      'textarea[data-automation-id="textInput"], [data-automation-id="textInput"] textarea, textarea',
    ),
  };
}

export function submitSelectors(page) {
  return {
    submitBtn: page.locator('button[data-automation-id="submitButton"]'),
    maybeThanks: page.locator("text=/thank you|submitted|response/i"),
  };
}
