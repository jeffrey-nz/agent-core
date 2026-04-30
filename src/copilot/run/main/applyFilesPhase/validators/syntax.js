import { checkPhpSyntax } from "./syntax/php.js";
import { checkJsonSyntax } from "./syntax/json.js";
import { checkCSharpSyntax } from "./syntax/csharp.js";
import { checkUxmlSyntax } from "./syntax/uxml.js";
import { checkYamlSyntax } from "./syntax/yaml.js";
import { checkSwiftSyntax } from "./syntax/swift.js";

export async function checkSyntax(
  projectDir,
  { phpFiles, jsonFiles, csFiles, uxmlFiles = [], ussFiles = [], yamlFiles = [], swiftFiles = [] },
) {
  const errors = [];

  errors.push(...(await checkPhpSyntax(projectDir, phpFiles)));
  errors.push(...(await checkJsonSyntax(projectDir, jsonFiles)));
  errors.push(...(await checkCSharpSyntax(projectDir, csFiles)));
  errors.push(...(await checkUxmlSyntax(projectDir, uxmlFiles)));
  errors.push(...(await checkYamlSyntax(projectDir, yamlFiles)));
  errors.push(...(await checkSwiftSyntax(projectDir, swiftFiles)));
  // USS files are CSS-like; no automated validator beyond write_file success.
  // .storyboard and .xib are XML; validated by checkUxmlSyntax if needed separately.

  return errors;
}
