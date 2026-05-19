import path from "node:path";
import { execAsync } from "#utils/exec.js";
import { fileExists } from "./utils.js";
import { log } from "#app/ui/log.js";
import { colors } from "#app/ui/colors.js";

export async function checkTests(projectDir, { phpTestFiles, jsTestFiles, rubyTestFiles = [], goTestFiles = [], pythonTestFiles = [] }) {
  const errors = [];

  if (
    phpTestFiles.length > 0 &&
    (await fileExists(path.join(projectDir, "vendor/bin/phpunit")))
  ) {
    log(colors.dim("  [Verifier] Running PHPUnit tests..."));
    const res = await execAsync(
      `vendor/bin/phpunit ${phpTestFiles.map((f) => `"${f}"`).join(" ")}`,
      { cwd: projectDir },
    );
    if (res.status !== 0) {
      errors.push(`PHPUnit Test Failure:\n${res.stdout || res.stderr}`);
    } else {
      log(colors.green("  [Verifier] PHPUnit tests passed! 🟢"));
    }
  }

  if (jsTestFiles.length > 0 && !(await fileExists(path.join(projectDir, "package.json")))) {
    // Fail loudly rather than silently skipping — a "passing" verifier with no
    // package.json means the tests never ran and the result is a false positive.
    errors.push(
      `JS/TS Test Failure: package.json is missing — tests cannot run without it.\n\n` +
      `The coder wrote test files but did not create the project scaffold. ` +
      `You MUST create package.json with the correct dependencies (react, react-dom, vite, ` +
      `@vitejs/plugin-react, vitest, @testing-library/react if needed) so that Vitest can be installed and run.`
    );
  }

  if (
    jsTestFiles.length > 0 &&
    (await fileExists(path.join(projectDir, "package.json")))
  ) {
    // Ensure dependencies are installed before running tests. For brand-new
    // projects the coder may write package.json + source files in one subtask
    // but skip the npm install step — the tests would always fail without this.
    const nodeModulesExists = await fileExists(path.join(projectDir, "node_modules"));
    if (!nodeModulesExists) {
      log(colors.dim("  [Verifier] node_modules missing — running npm install..."));
      const installRes = await execAsync("npm install", { cwd: projectDir });
      if (installRes.status !== 0) {
        errors.push(`npm install failed:\n${installRes.stdout || installRes.stderr}`);
        return errors;
      }
      log(colors.green("  [Verifier] npm install succeeded."));
    }

    log(colors.dim("  [Verifier] Running JS/TS tests..."));

    const res = await execAsync(
      `npx vitest run ${jsTestFiles.map((f) => `"${f}"`).join(" ")} --passWithNoTests || npx jest ${jsTestFiles.map((f) => `"${f}"`).join(" ")} --passWithNoTests`,
      { cwd: projectDir },
    );
    if (res.status !== 0) {
      const rawOutput = res.stdout || res.stderr || "";
      // Extract "Cannot find module './X'" errors and give the coder specific guidance
      // instead of a generic test failure — prevents the "test before source" failure loop.
      const missingModuleMatches = [...rawOutput.matchAll(/Cannot find module ['"]([^'"]+)['"]/g)];
      if (missingModuleMatches.length > 0) {
        const missingPaths = [...new Set(missingModuleMatches.map((m) => m[1]))];
        const hint =
          `\n\nROOT CAUSE — MISSING SOURCE FILE(S):\n` +
          missingPaths.map((p) => `  • The test imports '${p}' but that file does not exist yet.`).join("\n") +
          `\n\nFIX: You MUST create the source file(s) BEFORE the test file can pass.\n` +
          `For each missing module above, use write_file to create it with the exported functions/classes the test expects.\n` +
          `Do NOT rewrite the test file — create the implementation file first.`;
        errors.push(`JS/TS Test Failure:\n${rawOutput}${hint}`);
      } else {
        errors.push(`JS/TS Test Failure:\n${rawOutput}`);
      }
    } else {
      log(colors.green("  [Verifier] JS/TS tests passed! 🟢"));
    }
  }

  // Ruby RSpec / Minitest — run when Ruby test files are modified
  if (rubyTestFiles.length > 0) {
    const gemfilePath = path.join(projectDir, "Gemfile");
    if (await fileExists(gemfilePath)) {
      // Detect whether it's RSpec or Minitest by checking the Gemfile / spec dir
      const specDirPath = path.join(projectDir, "spec");
      const hasSpecDir = await fileExists(specDirPath);
      const testCmd = hasSpecDir ? "bundle exec rspec spec/ 2>&1" : "bundle exec rake test 2>&1";

      log(colors.dim(`  [Verifier] Running Ruby tests (${testCmd.split(" ")[2]})...`));
      const res = await execAsync(testCmd, { cwd: projectDir, timeout: 120000 });
      const output = (res.stdout || res.stderr || "").trim();

      // Guard: command not found means Ruby/Bundler not installed in this env
      if (/command not found|No such file/i.test(output)) {
        log(colors.dim("  [Verifier] bundle not available — skipping Ruby test check"));
      } else {
        // "0 examples" = no tests ran — same false-confidence problem as Python's "0 items"
        const noExamples = /\b0 examples?\b/i.test(output);
        const passed = /[1-9]\d* examples?, 0 failures?/i.test(output) ||
                       /[1-9]\d* tests?, 0 failures?/i.test(output);
        if (noExamples) {
          errors.push(
            `Ruby Test Failure: RSpec ran 0 examples — the test suite collected nothing.\n\n` +
            `This means no \`it\` / \`specify\` / \`example\` blocks were found in the spec files.\n\n` +
            `Common causes:\n` +
            `  - Spec file has only a \`describe\` / \`context\` shell with no \`it\` blocks inside\n` +
            `  - Spec methods not wrapped in \`it 'description' do ... end\`\n` +
            `  - RSpec shared example groups not included with \`include_examples\` or \`it_behaves_like\`\n\n` +
            `FIX: Add \`it 'description' do ... expect(...).to ... end\` blocks to each spec file.\n` +
            `Run: bundle exec rspec spec/ -f documentation 2>&1 | head -30\n\n` +
            `RSpec output:\n${output}`,
          );
        } else if (!passed && (res.status !== 0 || /\d+ (failure|error)s?/i.test(output))) {
          errors.push(`Ruby Test Failure:\n${output}`);
        } else {
          log(colors.green("  [Verifier] Ruby tests passed! 🟢"));
        }
      }
    }
  }

  // Go tests — run when Go test files are modified
  if (goTestFiles.length > 0) {
    const goModPath = path.join(projectDir, "go.mod");
    if (await fileExists(goModPath)) {
      log(colors.dim("  [Verifier] Running Go tests..."));
      // Use -v to detect "no tests to run" warning (empty _test.go files)
      const res = await execAsync("go test -v ./... 2>&1", { cwd: projectDir, timeout: 120000 });
      const output = (res.stdout || res.stderr || "").trim();

      if (/command not found|No such file/i.test(output)) {
        log(colors.dim("  [Verifier] go not available — skipping Go test check"));
      } else {
        const hasFailLine = /^FAIL\b/m.test(output);
        const hasBuildFail = /build failed|cannot|undefined:/i.test(output);
        // "no tests to run" = _test.go exists but has no func Test* — false-passing run
        const goNoTests = /warning: no tests to run/i.test(output);
        if (goNoTests) {
          errors.push(
            `Go Test Failure: go test ran 0 tests — "warning: no tests to run" was emitted.\n\n` +
            `The _test.go file(s) exist but contain no \`func Test*(t *testing.T)\` functions.\n\n` +
            `FIX: Add at least one \`func TestFoo(t *testing.T) { ... }\` to each _test.go file.\n` +
            `Test functions must start with "Test" (uppercase T) and accept \`*testing.T\`.\n\n` +
            `go test output:\n${output.slice(-1000)}`,
          );
        } else if (hasFailLine || hasBuildFail) {
          errors.push(`Go Test Failure:\n${output}`);
        } else {
          log(colors.green("  [Verifier] Go tests passed! 🟢"));
        }
      }
    }
  }

  // Python tests — run pytest when Python test files are modified
  if (pythonTestFiles.length > 0) {
    const requirementsPath = path.join(projectDir, "requirements.txt");
    const setupPyPath = path.join(projectDir, "setup.py");
    const pyprojectPath = path.join(projectDir, "pyproject.toml");
    const pipfilePath = path.join(projectDir, "Pipfile");
    const setupCfgPath = path.join(projectDir, "setup.cfg");
    const hasPythonProject =
      (await fileExists(requirementsPath)) ||
      (await fileExists(setupPyPath)) ||
      (await fileExists(pyprojectPath)) ||
      (await fileExists(pipfilePath)) ||
      (await fileExists(setupCfgPath));

    if (hasPythonProject) {
      log(colors.dim("  [Verifier] Running Python pytest..."));
      // Prefer project venv so deps installed there are found
      const venvPython = path.join(projectDir, ".venv", "bin", "python");
      const hasVenv = await fileExists(venvPython);
      const pytestCmd = hasVenv
        ? `"${venvPython}" -m pytest --tb=short -q 2>&1`
        : "python3 -m pytest --tb=short -q 2>&1";
      const res = await execAsync(pytestCmd, { cwd: projectDir, timeout: 120000 });
      const output = (res.stdout || res.stderr || "").trim();

      if (/command not found|No such file|No module named pytest/i.test(output)) {
        log(colors.dim("  [Verifier] pytest not available — skipping Python test check"));
      } else {
        const passed = /\d+ passed/.test(output) && !/\d+ failed/.test(output) && !/\d+ error/.test(output);
        const noTests = /no tests ran|collected 0 items/i.test(output);
        if (noTests) {
          // Pytest found no test functions in the modified test files. This is a false-passing
          // run — 0 items collected means the code is completely untested.
          errors.push(
            `Python Test Failure: pytest collected 0 test items from the modified test files.\n\n` +
            `This means no test functions (def test_*) were found — the test suite ran nothing.\n\n` +
            `Common causes:\n` +
            `  - Test functions not named with "test_" prefix (e.g. "def check_foo" instead of "def test_foo")\n` +
            `  - Test class methods not starting with "test_"\n` +
            `  - Test file imports failing silently (check for ImportError above)\n\n` +
            `FIX: Ensure all test functions are named def test_<something> and all test class\n` +
            `methods follow the same pattern. Run: .venv/bin/python -m pytest -v 2>&1 | head -30\n\n` +
            `pytest output:\n${output}`,
          );
        } else if (!passed && res.status !== 0) {
          errors.push(`Python Test Failure:\n${output}`);
        } else {
          log(colors.green("  [Verifier] Python pytest passed! 🟢"));
        }
      }
    }
  }

  return errors;
}
