import { checkPhpSyntax } from "./syntax/php.js";
import { checkJsonSyntax } from "./syntax/json.js";
import { checkCSharpSyntax } from "./syntax/csharp.js";
import { checkUxmlSyntax } from "./syntax/uxml.js";
import { checkYamlSyntax } from "./syntax/yaml.js";
import { checkSwiftSyntax } from "./syntax/swift.js";
import { checkPythonSyntax } from "./syntax/python.js";
import { checkRubySyntax } from "./syntax/ruby.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function checkSyntax(
  projectDir,
  { phpFiles, jsonFiles, csFiles, uxmlFiles = [], ussFiles = [], yamlFiles = [], swiftFiles = [], pyFiles = [], rubyFiles = [], cssFiles = [] },
) {
  const errors = [];

  errors.push(...(await checkPhpSyntax(projectDir, phpFiles)));
  errors.push(...(await checkJsonSyntax(projectDir, jsonFiles)));
  errors.push(...(await checkCSharpSyntax(projectDir, csFiles)));
  errors.push(...(await checkUxmlSyntax(projectDir, uxmlFiles)));
  errors.push(...(await checkYamlSyntax(projectDir, yamlFiles)));
  errors.push(...(await checkSwiftSyntax(projectDir, swiftFiles)));
  errors.push(...(await checkPythonSyntax(projectDir, pyFiles)));
  errors.push(...(await checkRubySyntax(projectDir, rubyFiles)));
  // USS files are CSS-like; no automated validator beyond write_file success.
  // .storyboard and .xib are XML; validated by checkUxmlSyntax if needed separately.

  // CSS/SCSS/Sass brace-balance check — an unmatched { } silently drops all
  // subsequent styles while the HTTP smoke test returns 200.
  for (const relPath of cssFiles) {
    try {
      const absPath = path.isAbsolute(relPath) ? relPath : path.join(projectDir, relPath);
      const content = await fs.readFile(absPath, "utf8");
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const opens  = (stripped.match(/\{/g) || []).length;
      const closes = (stripped.match(/\}/g) || []).length;
      if (opens !== closes) {
        const diff = opens - closes;
        errors.push(
          `CSS/SCSS brace imbalance in ${relPath}: ` +
          `${opens} opening { vs ${closes} closing } (${diff > 0 ? `${diff} unclosed` : `${-diff} extra`}). ` +
          `An unmatched brace silently drops all subsequent styles.`,
        );
      }
    } catch { /* file unreadable — skip */ }
  }

  return errors;
}
