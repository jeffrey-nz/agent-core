/**
 * Utilities for detecting and extracting failures from execution tool output.
 *
 * Tool handlers (sake, composer, phpunit, bash) return structured strings like:
 *   [EXIT CODE: 0]  → success
 *   [EXIT CODE: 1 (Forced by Fatal Error)]  → PHP fatal
 *   [EXIT CODE: 2]\n[STDERR]\n...  → command failure
 *   [ERROR] ...  → handler-level error
 *
 * These utilities let the verifier and requirements reviewer make a deterministic
 * pass/fail decision based on actual command output rather than just "did the
 * tool get called". This closes the gap where db:build ran but errored, yet the
 * system auto-passed because the run_sake tool was invoked.
 */

// Non-zero exit code patterns — all tool wrappers use this format
const NON_ZERO_EXIT_RE =
  /\[EXIT CODE:\s*(?:404|[1-9][0-9]*(?:\s*\([^)]+\))?)\]/i;

// PHP runtime error patterns
const PHP_ERROR_RE =
  /(?:PHP\s+)?(?:Fatal|Parse)\s+error:/i;

// Uncaught exception (catches InvalidArgumentException, RuntimeException, etc.)
const UNCAUGHT_RE = /Uncaught\s+\w+Exception/i;

// PHP parse error (syntax)
const PARSE_ERROR_RE = /PHP\s+Parse\s+error:/i;

// npm hard failure
const NPM_ERR_RE = /^npm ERR!/m;

// Composer dependency failure
const COMPOSER_FAIL_RE = /Your requirements could not be resolved/i;

const PATTERNS = [
  NON_ZERO_EXIT_RE,
  PHP_ERROR_RE,
  UNCAUGHT_RE,
  PARSE_ERROR_RE,
  NPM_ERR_RE,
  COMPOSER_FAIL_RE,
];

// ── Environment-error patterns ────────────────────────────────────────────────
// These indicate infrastructure/permission issues that code changes cannot fix.
// They are returned by classifyEnvironmentError() so callers can handle them
// differently (escalate to user / auto-advance) rather than retrying the coder.

const ENV_ERROR_PATTERNS = [
  // DNS resolution failure — curl exit code 6, hostname not found
  {
    re: /curl.*exit\s*code[:\s]+6|Could not resolve host|Name or service not known|curl:\s*\(6\)/i,
    type: "DNS_UNREACHABLE",
    description: "Hostname could not be resolved (DNS). The verification URL is a local vhost that doesn't exist in the agent environment.",
  },
  // Network connection refused / unreachable — curl exit code 7
  {
    re: /curl.*exit\s*code[:\s]+7|Failed to connect|Connection refused|curl:\s*\(7\)/i,
    type: "NETWORK_UNREACHABLE",
    description: "Network connection refused or unreachable. The target host is not accessible from the agent environment.",
  },
  // SilverStripe Flysystem assets/.htaccess write failure.
  // SilverStripe's dev/build ALWAYS tries to write public/assets/.htaccess for
  // server config, but this is non-fatal — template compilation succeeds even
  // when the file write fails. Treating it as a hard error causes false FAIL on
  // every single verification attempt in restricted-permissions environments.
  {
    re: /League\\Flysystem\\UnableToWriteFile.*\.htaccess|Unable to write file at location:.*\.htaccess/i,
    type: "PERMISSION_NONFATAL",
    description: "SilverStripe assets/.htaccess write failed (permission denied). This is non-fatal — template compilation and application rendering still succeed.",
  },
  // SilverStripe CLI (sake / dev/build) exit code 255.
  // PHP's CLI SAPI returns 255 when the process is killed by the framework's
  // task runner after completing. This is a known behaviour — the build succeeded
  // (templates compiled, DB flushed) but PHP exits non-zero. Only treat as
  // environmental when there are NO PHP fatal/parse/exception lines in the output.
  // Use excludeIf to let real PHP errors still surface as code failures.
  {
    re: /\[EXIT CODE:\s*255\]/i,
    type: "SAKE_CLI_EXIT_255",
    description: "SilverStripe CLI (sake/dev/build) exited with code 255. This is a known PHP CLI behaviour — the build completed successfully. Exit 255 without PHP fatal/parse errors is not a code defect.",
    excludeIf: /Fatal error|Parse error|Uncaught\s+\w+Exception|Exception:/i,
  },
];

/**
 * If the error string matches a known environment-level issue (DNS, permissions,
 * network), returns a descriptor object { type, description }. Returns null for
 * real code errors.
 */
export function classifyEnvironmentError(resultStr) {
  if (!resultStr || typeof resultStr !== "string") return null;
  for (const { re, type, description, excludeIf } of ENV_ERROR_PATTERNS) {
    if (!re.test(resultStr)) continue;
    // If the pattern has an exclusion guard and the exclusion matches, skip —
    // the error is a real code defect despite looking like an env issue.
    if (excludeIf && excludeIf.test(resultStr)) continue;
    return { type, description };
  }
  return null;
}

// ── HTTP response environment-error patterns ─────────────────────────────────
// These detect infrastructure failures that appear in HTTP response bodies
// (e.g. 500 pages from web applications). Unlike ENV_ERROR_PATTERNS above,
// these work on HTTP response text rather than shell command output.

const HTTP_ENV_PATTERNS = [
  {
    re: /file_put_contents\([^)]+\):\s*Permission denied|Unable to write file at location|League\\Flysystem\\UnableToWriteFile/i,
    type: "FILESYSTEM_PERMISSION",
    description: "Web server cannot write to a required directory (Permission denied)",
    pathRe: /file_put_contents\(([^)]+)\)/i,
  },
  {
    re: /EACCES.*Permission denied|EPERM.*operation not permitted/i,
    type: "FILESYSTEM_PERMISSION",
    description: "Filesystem permission error (EACCES/EPERM)",
    pathRe: null,
  },
  {
    re: /No space left on device|ENOSPC/i,
    type: "DISK_FULL",
    description: "Disk full — no space left on device",
    pathRe: null,
  },
];

/**
 * Classifies infrastructure errors from an HTTP response body.
 * Used by verifierNode to detect environment-level failures in acceptance tests.
 * Only inspects 5xx responses — 4xx are application errors, not infrastructure.
 * Returns { type, description, path } or null.
 */
export function classifyHttpResponseError(responseText) {
  if (!responseText || typeof responseText !== "string") return null;
  // Only classify 5xx responses — 4xx are application errors, not infrastructure
  if (!/Status:\s*5\d\d/i.test(responseText)) return null;
  for (const { re, type, description, pathRe } of HTTP_ENV_PATTERNS) {
    if (!re.test(responseText)) continue;
    let filePath = null;
    if (pathRe) {
      const m = responseText.match(pathRe);
      if (m) filePath = m[1].trim();
    }
    return { type, description, path: filePath };
  }
  return null;
}

/**
 * Strips non-fatal environment noise from a result string so the remaining
 * content can be checked for real errors. Currently removes:
 * - SilverStripe assets/.htaccess write failures (non-fatal in dev/build)
 */
function stripNonFatalNoise(resultStr) {
  // Remove entire lines containing the htaccess write failure — these are
  // logged by SilverStripe but don't represent a build failure.
  return resultStr
    .split("\n")
    .filter((line) => !/(?:League\\Flysystem\\UnableToWriteFile|Unable to write file at location:).*\.htaccess/i.test(line))
    .join("\n");
}

// Code-level error patterns — these represent real defects the coder must fix.
// Separated from PATTERNS so we can check them independently of the exit code.
const CODE_ERROR_PATTERNS = [PHP_ERROR_RE, UNCAUGHT_RE, PARSE_ERROR_RE, NPM_ERR_RE, COMPOSER_FAIL_RE];

// ── Multi-language class/module/type reference error patterns ─────────────────
// When a framework reports a missing class, module, or type, it may mean either:
//   (a) The dependency truly doesn't exist — install or create it.
//   (b) The stored reference format is wrong — config serialisation mismatch,
//       wrong escaping, or missing import directive.
//
// These patterns detect both cases across PHP, C#, Node.js, Python, Java, and
// Ruby so the coder can apply the correct diagnostic steps rather than guessing.
//
// PHP/SilverStripe instance of (b):
//   "Page references nonexistent \ElementalPageExtension in 'extensions'"
//   Cause: YAML single-quoted string with double backslashes → double-backslash
//   runtime string → PHP tokenizer produces bare \ClassName global-namespace ref.

const CLASS_REF_PATTERNS = [
  {
    // PHP/SilverStripe: "X references nonexistent \Y in 'extensions'"
    re: /(\w[\w\\]+)\s+references\s+nonexistent\s+([\w\\]+)\s+in\s+'(\w+)'/i,
    language: "php",
    extractOwner: (m) => m[1],
    extractRef:   (m) => m[2],
    context:      (m) => m[3],
  },
  {
    // PHP general: "Class 'X' not found" / "Class X does not exist"
    re: /[Cc]lass\s+['"]?([\w\\]+)['"]?\s+(?:not found|does not exist|could not be autoloaded)/i,
    language: "php",
    extractOwner: () => null,
    extractRef:   (m) => m[1],
    context:      () => "autoload",
  },
  {
    // C# / .NET: "The type or namespace name 'X' could not be found"
    re: /[Tt]he type or namespace(?:\s+name)?\s+'([\w.]+)'\s+could not be found/i,
    language: "csharp",
    extractOwner: () => null,
    extractRef:   (m) => m[1],
    context:      () => "namespace",
  },
  {
    // Node.js: "Cannot find module 'X'"
    re: /Cannot find module '([^']+)'/i,
    language: "node",
    extractOwner: () => null,
    extractRef:   (m) => m[1],
    context:      () => "require",
  },
  {
    // Python: "ModuleNotFoundError: No module named 'X'"
    re: /(?:ModuleNotFoundError|ImportError):\s*No module named '([^']+)'/i,
    language: "python",
    extractOwner: () => null,
    extractRef:   (m) => m[1],
    context:      () => "import",
  },
  {
    // Java: "cannot find symbol: class X" / "package X does not exist"
    re: /cannot find symbol[^:]*:\s*(?:class|interface)\s+([\w.]+)|package\s+([\w.]+)\s+does not exist/i,
    language: "java",
    extractOwner: () => null,
    extractRef:   (m) => m[1] || m[2],
    context:      () => "import",
  },
  {
    // Ruby: "uninitialized constant X"
    re: /uninitialized constant\s+([\w:]+)/i,
    language: "ruby",
    extractOwner: () => null,
    extractRef:   (m) => m[1],
    context:      () => "constant",
  },
];

/**
 * Per-language rules for deciding whether the bad reference is a format/escaping
 * bug (isFormatBug=true) rather than a genuinely missing dependency.
 *
 *   PHP    — bare global-namespace ref (\ClassName or single-segment name with no \)
 *            is almost always a YAML single-quote double-backslash escaping bug.
 *   C#     — a single-segment type name (no dot) usually means a missing `using`.
 *   Node   — a relative path (./foo, ../bar) means the local file is absent.
 *   Python — single top-level module: ambiguous; default false (treat as missing).
 *   Java   — single-segment class: missing import is likely.
 *   Ruby   — no :: separator: constant not required/autoloaded.
 */
function isRefFormatBug(ref, language) {
  switch (language) {
    case "php":    return ref.startsWith("\\") || !ref.includes("\\");
    case "csharp": return !ref.includes(".");
    case "node":   return ref.startsWith("./") || ref.startsWith("../");
    case "java":   return !ref.includes(".");
    case "ruby":   return !ref.includes("::");
    default:       return false;
  }
}

const LANG_CAUSES = {
  php: {
    formatBug:   "Config serialisation mismatch — YAML single-quoted string with double backslashes produces a bare global-namespace reference (\\ClassName) at runtime. The class exists in vendor but the stored reference format is wrong.",
    realMissing: "Class does not exist in vendor — wrong namespace, package not installed, or autoload not refreshed.",
  },
  csharp: {
    formatBug:   "Missing `using` directive or namespace alias — the type exists but is not imported in this file.",
    realMissing: "Type/namespace not found — NuGet package not installed or project reference missing.",
  },
  node: {
    formatBug:   "Relative path does not resolve — the local file or directory is missing or the import path is incorrect.",
    realMissing: "Package not installed — run `npm install <package>` or verify package.json.",
  },
  python: {
    formatBug:   "Import path may be wrong — check the module hierarchy and __init__.py files.",
    realMissing: "Package not installed — run `pip install <module>` or activate the correct virtualenv.",
  },
  java: {
    formatBug:   "Missing import statement — add `import full.package.ClassName;` at the top of the file.",
    realMissing: "Class/package not on the classpath — check build.gradle / pom.xml dependencies.",
  },
  ruby: {
    formatBug:   "Constant not required — add a `require` statement or check gem load order.",
    realMissing: "Gem not installed or not required — check Gemfile and `require` statements.",
  },
};

const LANG_FIX_HINTS = {
  php: {
    formatBug: (ref, owner) =>
      `In the project config files (e.g. app/_config/*.yml), find the entry for ${owner || ref} that references this class name.` +
      ` It is likely wrapped in single quotes with double backslashes (e.g. '${ref.replace(/\\/g, "\\\\")}').` +
      ` Fix: remove the surrounding quotes so YAML passes single backslashes to PHP.\n` +
      `Then clear the compiled config cache:\n` +
      `  execute_bash("find /tmp -maxdepth 3 -name 'configcache' -exec rm -rf {} + 2>/dev/null; echo done")`,
    realMissing: (ref) =>
      `Verify the class exists in vendor:\n` +
      `  execute_bash("php -r \\"require 'vendor/autoload.php'; echo class_exists('${ref.replace(/\\/g, "\\\\")}') ? 'EXISTS' : 'MISSING';\\"" )\n` +
      `If MISSING: check composer.json for the package, run composer install, or verify the namespace.`,
  },
  csharp: {
    formatBug: (ref) =>
      `Add a using directive: using ${ref.split(".").slice(0, -1).join(".") || ref};  — or use the fully-qualified type name inline.`,
    realMissing: (ref) =>
      `Search for the type: grep -r "class ${ref.split(".").pop()}" src/\n` +
      `If not found, add the NuGet package: dotnet add package <PackageName>`,
  },
  node: {
    formatBug: (ref) =>
      `Check the resolved path: ls ${ref}  — verify the file exists relative to the importing module.`,
    realMissing: (ref) =>
      `Install the package: npm install ${ref}\n` +
      `If it is a local module, verify the path is correct and the file exists.`,
  },
  python: {
    formatBug: (ref) =>
      `Check the module path: python -c "import ${ref.split(".")[0]}; print('OK')"\n` +
      `Verify __init__.py files exist at each level of the package hierarchy.`,
    realMissing: (ref) =>
      `Install the package: pip install ${ref.split(".")[0]}\n` +
      `Then verify: python -c "import ${ref}; print('OK')"`,
  },
  java: {
    formatBug: (ref) =>
      `Add import: import ${ref};  at the top of the file, or use the fully-qualified class name inline.`,
    realMissing: (ref) =>
      `Search for the class: grep -r "class ${ref.split(".").pop()}" src/\n` +
      `If not found, add the dependency to build.gradle / pom.xml.`,
  },
  ruby: {
    formatBug: (ref) =>
      `Add: require '${ref.replace(/::/g, "/").toLowerCase()}'  at the top of the file or in the gem's main entry point.`,
    realMissing: (ref) =>
      `Add the gem to Gemfile and run bundle install.\n` +
      `Then verify: bundle exec ruby -e "require '${ref.replace(/::/g, "/").toLowerCase()}'"`,
  },
};

/**
 * Multi-language classifier for missing class/module/type reference errors.
 *
 * Covers PHP (including SilverStripe config errors), C#, Node.js, Python, Java,
 * and Ruby. For each match it distinguishes between:
 *
 *   isFormatBug=true  — the reference format is wrong (config serialisation
 *                        mismatch, missing import directive, wrong escaping).
 *                        The dependency exists; the stored reference is broken.
 *
 *   isFormatBug=false — the dependency genuinely doesn't exist and must be
 *                        installed or created.
 *
 * Returns { ownerClass, badRef, language, context, isFormatBug, likelyCause, fixHint }
 * or null when no pattern matches.
 *
 * @param {string} text - Shell output or HTTP response body to scan.
 */
export function classifyClassReferenceError(text) {
  if (!text || typeof text !== "string") return null;

  for (const { re, language, extractOwner, extractRef, context } of CLASS_REF_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;

    const ownerClass = extractOwner(m) || null;
    const badRef     = extractRef(m);
    const ctx        = context(m);
    const formatBug  = isRefFormatBug(badRef, language);

    const causes = LANG_CAUSES[language] || LANG_CAUSES.php;
    const hints  = LANG_FIX_HINTS[language] || LANG_FIX_HINTS.php;

    return {
      ownerClass,
      badRef,
      language,
      context:     ctx,
      isFormatBug: formatBug,
      likelyCause: formatBug ? causes.formatBug   : causes.realMissing,
      fixHint:     formatBug ? hints.formatBug(badRef, ownerClass)
                             : hints.realMissing(badRef, ownerClass),
    };
  }

  return null;
}

/**
 * Backward-compatible alias for the original SilverStripe-specific classifier.
 * Returns the new shape with extra legacy fields (badClass, isBareGlobal) so
 * existing callers (verifierNode) do not need immediate updates.
 */
export function classifyExtensionClassError(text) {
  const result = classifyClassReferenceError(text);
  if (!result) return null;
  return { ...result, badClass: result.badRef, isBareGlobal: result.isFormatBug };
}

/**
 * Returns true if the tool result string indicates the command failed.
 * Safe to call on any string — returns false for null/undefined.
 *
 * Non-fatal environment noise (SilverStripe assets/.htaccess permission errors)
 * is stripped before checking. When that noise is the SOLE cause of a non-zero
 * exit code, the non-zero exit is also ignored — template compilation still
 * succeeded and the application is functional.
 */
export function hasExecutionFailure(resultStr) {
  if (!resultStr || typeof resultStr !== "string") return false;

  // Strip known non-fatal lines (htaccess permission failures, etc.).
  const cleaned = stripNonFatalNoise(resultStr);
  const hadNonFatalNoise = cleaned.length !== resultStr.length;

  if (cleaned.trimStart().startsWith("[ERROR]")) return true;

  // If non-fatal noise was stripped, check ONLY for real code errors — not
  // for a non-zero exit code, which may have been caused solely by the noise.
  // Example: SilverStripe dev/build exits 255 because of the htaccess write;
  // the templates compiled fine and the exit code is a consequence of the noise.
  if (hadNonFatalNoise) {
    return CODE_ERROR_PATTERNS.some((re) => re.test(cleaned));
  }

  return PATTERNS.some((re) => re.test(cleaned));
}

/**
 * Extracts the most relevant error lines from a tool result string, capped at
 * maxLen characters, for inclusion in verifier feedback messages.
 */
export function extractErrorSummary(resultStr, maxLen = 700) {
  if (!resultStr) return "";
  const lines = resultStr.split("\n");
  // Prefer lines that mention exit code, stderr, or error keywords
  const relevant = lines.filter((l) =>
    /exit code|stderr|fatal|exception|error:|parse error|npm err/i.test(l),
  );
  const summary = (relevant.length > 0 ? relevant : lines)
    .slice(0, 12)
    .join("\n")
    .trim();
  return summary.length > maxLen ? summary.slice(0, maxLen) + "\n...[truncated]" : summary;
}
