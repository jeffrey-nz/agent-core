import {
  COMMON_IGNORE_DIRS,
  COMMON_IGNORE_FILES,
} from "../../config/ignores.js";

export const DEFAULT_IGNORES = [
  ...Array.from(COMMON_IGNORE_DIRS).map((dir) => `**/${dir}/**`),
  ...Array.from(COMMON_IGNORE_FILES).map((file) => `**/${file}`),
  "**/*.min.*",
  "**/*.map",
];

export const TARGET_GLOBS = [
  "**/*.js",
  "**/*.cjs",
  "**/*.mjs",
  "**/*.ts",
  "**/*.tsx",
  "**/*.jsx",
  "**/*.css",
  "**/*.scss",
  "**/*.sass",
  "**/*.less",
  "**/*.html",
  "**/*.htm",
  "**/*.vue",
  "**/*.svelte",
  "**/*.php",
  "**/*.ss",
];
