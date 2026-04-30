import { promptChoice } from "#app/ui/readline/index.js";

export async function promptSystemAffected(existingRl = null) {
  const OPTIONS = [
    { label: "Marketing Website", value: "Marketing Website" },
    { label: "Corporate Website", value: "Corporate Website" },
    { label: "Scopes website", value: "Scopes website" },
    { label: "Custom (enter manually)", value: null },
  ];
  return promptChoice(existingRl, "System or Service affected:", OPTIONS, {
    customPrompt: "Enter system or service affected (required): ",
  });
}

export async function promptStakeholders(existingRl = null) {
  const OPTIONS = [
    { label: "Alastair Nicholl", value: "Alastair Nicholl" },
    { label: "Rebecca Farrell", value: "Rebecca Farrell" },
    { label: "Custom (enter names manually)", value: null },
  ];
  return promptChoice(
    existingRl,
    "Stakeholders involved in the change:",
    OPTIONS,
    {
      customPrompt:
        "Enter stakeholders (e.g. Finance - Louisa Homersham, Registry - Mel Wright): ",
    },
  );
}

export async function promptSpecificPeople(existingRl = null) {
  const OPTIONS = [
    { label: "alastair.nicholl@op.ac.nz", value: "alastair.nicholl@op.ac.nz" },
    { label: "rebecca.farrell@op.ac.nz", value: "rebecca.farrell@op.ac.nz" },
    { label: "Custom (enter email addresses manually)", value: null },
  ];
  return promptChoice(
    existingRl,
    "Any specific people you want to tell about the change?\nTip: If entering multiple emails, separate with a semi-colon.",
    OPTIONS,
    {
      customPrompt:
        "Enter email(s) (e.g. jono.aldridge@op.ac.nz; mini.mouse@op.ac.nz): ",
    },
  );
}

export async function promptApproverName(existingRl = null) {
  const OPTIONS = [
    { label: "Alastair Nicholl", value: "Alastair Nicholl" },
    { label: "Torleif West", value: "Torleif West" },
    { label: "Custom (enter name manually)", value: null },
  ];
  return promptChoice(existingRl, "Approver / Peer Reviewer Name:", OPTIONS, {
    customPrompt: "Enter approver / peer reviewer name: ",
  });
}

export async function promptApproverEmail(existingRl = null) {
  const OPTIONS = [
    { label: "Alastair.Nicholl@op.ac.nz", value: "Alastair.Nicholl@op.ac.nz" },
    { label: "Torleif.West@op.ac.nz", value: "Torleif.West@op.ac.nz" },
    { label: "Custom (enter email manually)", value: null },
  ];
  return promptChoice(existingRl, "Approver's email address:", OPTIONS, {
    customPrompt: "Enter approver email address: ",
  });
}
