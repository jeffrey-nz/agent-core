import { colors } from "#app/ui/colors.js";

export class ActionableError extends Error {
  constructor(message, suggestion) {
    super(message);
    this.suggestion = suggestion;
  }
}

export function handleError(err) {
  if (err instanceof ActionableError && err.suggestion) {
    console.error(colors.red(`❌ ${err.message}`));
    console.error(colors.yellow(`💡 Suggestion: ${err.suggestion}`));
  } else {
    console.error(colors.red(`❌ ${err.message || err}`));
  }
}
