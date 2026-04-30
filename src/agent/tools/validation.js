/**
 * Tool output validation schemas.
 * Validates tool results against expected schemas to catch malformed outputs.
 */

/**
 * Validate a tool result against expected schema.
 * @param {string} toolName - Name of the tool
 * @param {any} result - Result returned by the tool executor
 * @param {Object} context - Additional context (unused currently, reserved for future)
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateToolResult(toolName, result, context = {}) {
  // Basic structure check: result must be an object
  if (!result || typeof result !== 'object') {
    return { valid: false, error: `Result is not an object: ${typeof result}` };
  }

  // If result has an 'ok' field, it's likely a tool response
  if (result.ok === false) {
    // Failed tools may not have complete structure; accept them as valid
    // because the failure reason is in the error field
    return { valid: true };
  }

  // Tool-specific validation
  switch (toolName) {
    case 'write_file':
      return validateWriteFile(result);
    case 'read_file':
      return validateReadFile(result);
    case 'patch_file':
    case 'apply_diff':
      return validatePatchFile(result);
    case 'execute_bash':
      return validateExecuteBash(result);
    case 'list_dir':
      return validateListDir(result);
    case 'find_file':
      return validateFindFile(result);
    case 'grep':
      return validateGrep(result);
    case 'run_composer':
    case 'run_phpunit':
    case 'run_sake':
    case 'run_npm':
      return validateCommandTool(result);
    case 'http_request':
      return validateHttpRequest(result);
    default:
      // Unknown tool: accept as valid but log warning? Return valid to avoid breaking
      return { valid: true };
  }
}

function validateWriteFile(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'write_file must have ok: true' };
  }
  // Accept either: structured {path} from handlers that return objects,
  // OR text-normalized {text} from handlers that return plain strings
  // (normalized by localDispatcher to { ok, text }).
  const hasStructured = typeof result.path === 'string';
  const hasText = typeof result.text === 'string' && result.text.length > 0;
  if (!hasStructured && !hasText) {
    return { valid: false, error: 'write_file missing both path and text output' };
  }
  return { valid: true };
}

function validateReadFile(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'read_file must have ok: true' };
  }
  // Accept either structured {content} or legacy string-normalized {text} output.
  if (typeof result.content !== 'string' && typeof result.text !== 'string') {
    return { valid: false, error: 'read_file missing content or text string' };
  }
  const body = result.content ?? result.text;
  if (typeof result.size === 'number' && result.size > 0 && body.length === 0) {
    return { valid: false, error: 'read_file size > 0 but content is empty' };
  }
  return { valid: true };
}

function validatePatchFile(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'patch_file/apply_diff must have ok: true' };
  }
  if (result.applied !== undefined && typeof result.applied !== 'boolean') {
    return { valid: false, error: 'patch_file applied must be boolean' };
  }
  // linesChanged is optional but should be number if present
  if (result.linesChanged !== undefined && typeof result.linesChanged !== 'number') {
    return { valid: false, error: 'patch_file linesChanged must be number' };
  }
  return { valid: true };
}

function validateExecuteBash(result) {
  if (result.ok === false) {
    // Failed execution is valid as long as it has error message
    if (typeof result.error !== 'string') {
      return { valid: false, error: 'execute_bash failure missing error string' };
    }
    return { valid: true };
  }
  // Successful execution
  if (result.ok !== true) {
    return { valid: false, error: 'execute_bash must have ok: true on success' };
  }
  if (result.exitCode !== undefined && typeof result.exitCode !== 'number') {
    return { valid: false, error: 'execute_bash exitCode must be number' };
  }
  if (result.stdout !== undefined && typeof result.stdout !== 'string') {
    return { valid: false, error: 'execute_bash stdout must be string' };
  }
  return { valid: true };
}

function validateListDir(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'list_dir must have ok: true' };
  }
  // Accept structured {files/entries} or legacy string-normalized {text} output.
  if (!Array.isArray(result.files) && !Array.isArray(result.entries) && typeof result.text !== 'string') {
    return { valid: false, error: 'list_dir missing files/entries array or text output' };
  }
  return { valid: true };
}

function validateFindFile(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'find_file must have ok: true' };
  }
  // Accept structured {results/files} or legacy string-normalized {text} output.
  if (!Array.isArray(result.results) && !Array.isArray(result.files) && typeof result.text !== 'string') {
    return { valid: false, error: 'find_file missing results/files array or text output' };
  }
  return { valid: true };
}

function validateGrep(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'grep must have ok: true' };
  }
  // Accept structured {matches/results} or legacy string-normalized {text} output.
  if (typeof result.matches === 'undefined' && !Array.isArray(result.results) && typeof result.text !== 'string') {
    return { valid: false, error: 'grep missing matches/results array or text output' };
  }
  return { valid: true };
}

function validateCommandTool(result) {
  // Composer, PHPUnit, Sake, NPM tools return similar structure
  if (result.ok === false) {
    if (typeof result.error !== 'string') {
      return { valid: false, error: `${result.tool || 'command'} failure missing error string` };
    }
    return { valid: true };
  }
  if (result.ok !== true) {
    return { valid: false, error: `${result.tool || 'command'} must have ok: true on success` };
  }
  return { valid: true };
}

function validateHttpRequest(result) {
  if (result.ok !== true) {
    return { valid: false, error: 'http_request must have ok: true' };
  }
  // Accept structured {status} or legacy string-normalized {text} output.
  if (typeof result.status !== 'number' && typeof result.text !== 'string') {
    return { valid: false, error: 'http_request missing status code or text output' };
  }
  return { valid: true };
}
