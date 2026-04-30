import { handleComposer } from "./handlers/composer/run.js";
import { handleComposerFork } from "./handlers/composer/fork.js";
import { handleSake } from "./handlers/sake.js";
import { handleLint } from "./handlers/lint.js";
import { handlePhpUnit } from "./handlers/phpunit.js";
import { handlePackageVersion } from "./handlers/lock.js";
import { createToolDispatcher } from "../dispatcher.js";

const phpHandlers = {
  run_composer: (input, ctx) => handleComposer(input, ctx.rootDir),
  run_composer_fork: (input, ctx) => handleComposerFork(input, ctx.rootDir),
  php_lint: (input, ctx) => handleLint(input, ctx.rootDir),
  run_phpunit: (input, ctx) => handlePhpUnit(input, ctx?.rootDir),
  run_sake: (input, ctx) => handleSake(input, ctx.rootDir),
  check_package_version: (input, ctx) => handlePackageVersion(input),
};

export const executePhpTool = createToolDispatcher(phpHandlers);
