import { promptRequired } from "./base.js";

export async function promptChangeName(existingRl = null) {
  return await promptRequired("Change Name", existingRl);
}

export async function promptDescriptionOfProposedChange(existingRl = null) {
  return await promptRequired("Description of proposed change", existingRl);
}
