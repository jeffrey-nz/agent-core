import fs from "node:fs/promises";

export async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function categorizeFiles(modifiedFilesAbs) {
  const modifiedFiles = Array.from(new Set(modifiedFilesAbs || []));
  return {
    phpFiles: modifiedFiles.filter((f) => f.endsWith(".php")),
    jsonFiles: modifiedFiles.filter((f) => f.endsWith(".json")),
    tsFiles: modifiedFiles.filter(
      (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
    ),
    jsFiles: modifiedFiles.filter(
      (f) => f.endsWith(".js") || f.endsWith(".jsx"),
    ),

    csFiles: modifiedFiles.filter((f) => f.endsWith(".cs")),

    // Unity UI Toolkit asset files — not C#, validated separately
    uxmlFiles: modifiedFiles.filter((f) => f.endsWith(".uxml")),
    ussFiles: modifiedFiles.filter((f) => f.endsWith(".uss")),

    yamlFiles: modifiedFiles.filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
    ),

    phpTestFiles: modifiedFiles.filter((f) => f.endsWith("Test.php")),
    jsTestFiles: modifiedFiles.filter((f) =>
      f.match(/\.(test|spec)\.(js|ts|jsx|tsx)$/),
    ),

    csTestFiles: modifiedFiles.filter(
      (f) => f.includes("/Tests/") || f.endsWith("Tests.cs"),
    ),

    swiftFiles: modifiedFiles.filter((f) => f.endsWith(".swift")),
    swiftTestFiles: modifiedFiles.filter(
      (f) => f.endsWith(".swift") && (f.includes("/Tests/") || f.endsWith("Tests.swift")),
    ),

    // Swift/Xcode UI layout asset files — XML, no compilation needed
    storyboardFiles: modifiedFiles.filter((f) => f.endsWith(".storyboard")),
    xibFiles: modifiedFiles.filter((f) => f.endsWith(".xib")),

    // Ruby test files — match _spec.rb / _test.rb or files under spec/ or test/ dirs
    rubyTestFiles: modifiedFiles.filter(
      (f) => f.endsWith(".rb") && (/(?:_spec|_test)\.rb$/.test(f) || /\/(?:spec|test)\//.test(f)),
    ),

    // Go test files — *_test.go
    goTestFiles: modifiedFiles.filter((f) => f.endsWith("_test.go")),

    // All Go source files (for go vet)
    goFiles: modifiedFiles.filter((f) => f.endsWith(".go")),

    // Python test files — test_*.py / *_test.py or files under tests/ / test/
    pythonTestFiles: modifiedFiles.filter(
      (f) => f.endsWith(".py") && (/(?:^|[\\/])test_[^/]+\.py$/.test(f) || /[^/]+_test\.py$/.test(f) || /[\\/](?:tests?|test_suite)[\\/]/.test(f)),
    ),

    // All Python source files (for syntax checking)
    pyFiles: modifiedFiles.filter((f) => f.endsWith(".py")),

    // All Ruby source files (for syntax checking)
    rubyFiles: modifiedFiles.filter((f) => f.endsWith(".rb") && !f.includes("/vendor/") && !f.includes("/gems/")),

    // CSS/SCSS/Sass files (for brace-balance check)
    cssFiles: modifiedFiles.filter((f) => /\.(css|scss|sass)$/i.test(f)),
  };
}
