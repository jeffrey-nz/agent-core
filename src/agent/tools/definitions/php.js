import { z } from "zod";

export const phpTools = {
  run_composer: {
    description: "Run a Composer command in a PHP project directory.",
    parameters: z.object({
      command: z
        .string()
        .describe("Composer sub-command and flags, e.g. 'update -W'"),
      working_dir: z.string().optional(),
    }),
  },
  run_composer_fork: {
    description: "Automate the local forking of a vendor package.",
    parameters: z.object({
      package: z.string(),
      version: z.string(),
    }),
  },
  php_lint: {
    description: "Check PHP syntax for a file or directory.",
    parameters: z.object({
      path: z
        .string()
        .describe("Absolute path to a PHP file or directory to lint."),
    }),
  },
  run_phpunit: {
    description: "Run PHPUnit tests.",
    parameters: z.object({
      working_dir: z.string().describe("Absolute path to the project root."),
      filter: z.string().optional(),
      config: z.string().optional(),
    }),
  },
  run_sake: {
    description: "Run a SilverStripe CLI command (sake).",
    parameters: z.object({
      command: z
        .string()
        .describe("Sake command and arguments, e.g. 'dev/build flush=all'"),
      working_dir: z.string().describe("Absolute path to the project root."),
    }),
  },
  check_package_version: {
    description:
      "Retrieve the exactly resolved version of a specific package from composer.lock.",
    parameters: z.object({
      package: z.string(),
      working_dir: z.string(),
    }),
  },
};
