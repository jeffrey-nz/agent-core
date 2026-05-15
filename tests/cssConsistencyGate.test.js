// Regression tests for the verifier's CSS class-name consistency gate.
// The gate forces a coder retry if a .css file was written without evidence
// of reading the consumer (JSX/TSX/HTML).
//
// History:
//   - Original gate only accepted .jsx/.tsx as consumers. This blocked vanilla
//     HTML/CSS/JS projects entirely — the verifier would force retries even
//     when the agent had correctly produced working code. Observed during the
//     chess-game test run; fix lives in src/agent/graph/nodes/verifierNode.js.

import test from "node:test";
import assert from "node:assert/strict";

// Mirror of the gate's two checks. Keep these in sync with verifierNode.js;
// if the gate logic changes, update both. Tested here in isolation because
// the full verifierNode has heavy state dependencies.
const consumerRegex = /\.(jsx|tsx|html?)$/;
const readConsumerEvidence = (resp) =>
  /"read_file"[^}]{1,200}\.(jsx|tsx|html?)/.test(resp) ||
  /read_file[^\n]{1,100}\.(jsx|tsx|html?)/.test(resp);

test.describe("CSS class-name consistency gate — consumer detection", () => {
  test("matches .jsx as consumer", () => {
    assert.ok("src/App.jsx".match(consumerRegex));
  });
  test("matches .tsx as consumer", () => {
    assert.ok("src/App.tsx".match(consumerRegex));
  });
  test("matches .html as consumer", () => {
    assert.ok("index.html".match(consumerRegex));
  });
  test("matches .htm as consumer", () => {
    assert.ok("legacy.htm".match(consumerRegex));
  });
  test("does NOT match .js as consumer (no template)", () => {
    assert.equal("script.js".match(consumerRegex), null);
  });
  test("does NOT match .css as consumer (it's the producer)", () => {
    assert.equal("style.css".match(consumerRegex), null);
  });
});

test.describe("CSS class-name consistency gate — read_file evidence detection", () => {
  test("detects read_file of a .jsx in JSON tool call", () => {
    const resp = '[{"tool":"read_file","path":"src/App.jsx"}]';
    assert.ok(readConsumerEvidence(resp));
  });
  test("detects read_file of a .html in JSON tool call", () => {
    const resp = '[{"tool":"read_file","path":"index.html"}]';
    assert.ok(readConsumerEvidence(resp));
  });
  test("detects read_file of a .tsx in plain-text fallback", () => {
    const resp = "I'll read_file the src/App.tsx component to verify";
    assert.ok(readConsumerEvidence(resp));
  });
  test("does NOT detect when no consumer file mentioned", () => {
    const resp = '[{"tool":"read_file","path":"style.css"}]';
    assert.equal(readConsumerEvidence(resp), false);
  });
  test("does NOT false-positive on .jsx mentioned outside read_file context", () => {
    // 200+ chars of unrelated text before the .jsx mention should not match.
    const filler = "x".repeat(300);
    const resp = `read_file ${filler} App.jsx`;
    assert.equal(readConsumerEvidence(resp), false);
  });
});
