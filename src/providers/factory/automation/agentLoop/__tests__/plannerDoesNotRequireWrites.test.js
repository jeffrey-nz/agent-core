import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoopState } from "../loopState.js";

test("planning phase does not require file writes", () => {
  const state = createLoopState({
    remoteSessionId: "test",
    rootDir: "/tmp",
    toolContext: {},
    label: "test",
    initialResponseText: "Here is the plan",
    send: async () => "",
    requireWriteFile: false,
  });

  assert.equal(state.requireWriteFile, false);
});
