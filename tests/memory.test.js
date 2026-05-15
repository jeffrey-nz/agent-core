import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseMemory,
  serializeMemory,
  listMemoriesFromDir,
  writeMemory,
  readMemoryByName,
  deleteMemory,
  rebuildIndex,
  projectMemoryDir,
} from "../src/memory/bank.js";
import { renderMemorySnapshot, renderMemoryIndex } from "../src/memory/loader.js";
import {
  shouldCompact,
  totalChars,
  compactMessages,
} from "../src/memory/compactor.js";
import { executeMemoryTool } from "../src/agent/tools/memory.js";

async function tmpdir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
}

test.describe("bank — frontmatter parser", () => {
  test("parses minimal frontmatter + body", () => {
    const text = `---\nname: hi\ndescription: short\nmetadata:\n  type: user\n---\n\nHello world.\n`;
    const { meta, body } = parseMemory(text);
    assert.equal(meta.name, "hi");
    assert.equal(meta.description, "short");
    assert.equal(meta.metadata.type, "user");
    assert.equal(body, "Hello world.");
  });

  test("strips quotes from values", () => {
    const text = `---\nname: q\ndescription: "has: colon"\nmetadata:\n  type: feedback\n---\n\nx\n`;
    const { meta } = parseMemory(text);
    assert.equal(meta.description, "has: colon");
  });

  test("throws on missing frontmatter", () => {
    assert.throws(() => parseMemory("no frontmatter here"));
  });
});

test.describe("bank — serializer", () => {
  test("round-trips through parseMemory", () => {
    const text = serializeMemory({
      name: "rt",
      description: "round-trip check",
      type: "project",
      body: "Body content.",
    });
    const { meta, body } = parseMemory(text);
    assert.equal(meta.name, "rt");
    assert.equal(meta.metadata.type, "project");
    assert.equal(body, "Body content.");
  });

  test("rejects invalid type", () => {
    assert.throws(() =>
      serializeMemory({ name: "x", description: "y", type: "garbage", body: "" }),
    );
  });

  test("escapes colons in descriptions", () => {
    const text = serializeMemory({
      name: "x",
      description: "has: colon",
      type: "user",
      body: "",
    });
    assert.ok(text.includes('"has: colon"'));
  });
});

test.describe("bank — list/write/delete + index", () => {
  test("writes a memory and updates MEMORY.md", async () => {
    const dir = await tmpdir();
    try {
      const projectDir = dir; // pretend this is the project root
      await writeMemory({
        name: "u-test",
        description: "user-level test memory",
        type: "user",
        body: "I am Jeffrey.",
        scope: "project",
        projectDir,
      });
      const index = await fs.readFile(path.join(projectMemoryDir(projectDir), "MEMORY.md"), "utf8");
      assert.match(index, /# Memory Index/);
      assert.match(index, /u-test\.md/);
      assert.match(index, /user-level test memory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("listMemoriesFromDir returns entries sorted", async () => {
    const dir = await tmpdir();
    try {
      const projectDir = dir;
      await writeMemory({ name: "b", description: "second", type: "user", body: "B", scope: "project", projectDir });
      await writeMemory({ name: "a", description: "first", type: "user", body: "A", scope: "project", projectDir });
      const entries = await listMemoriesFromDir(projectMemoryDir(projectDir));
      assert.deepEqual(entries.map((e) => e.meta.name), ["a", "b"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("readMemoryByName + deleteMemory", async () => {
    const dir = await tmpdir();
    try {
      const projectDir = dir;
      await writeMemory({ name: "d", description: "del me", type: "user", body: "X", scope: "project", projectDir });
      const found = await readMemoryByName("d", { projectDir });
      assert.ok(found);
      assert.equal(found.body, "X");

      const removed = await deleteMemory("d", { scope: "project", projectDir });
      assert.equal(removed, true);

      const gone = await readMemoryByName("d", { projectDir });
      assert.equal(gone, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("rebuildIndex skips MEMORY.md and malformed files", async () => {
    const dir = await tmpdir();
    try {
      await fs.writeFile(path.join(dir, "good.md"),
        `---\nname: g\ndescription: good\nmetadata:\n  type: user\n---\n\nG\n`);
      await fs.writeFile(path.join(dir, "junk.md"), "no frontmatter\n");
      await fs.writeFile(path.join(dir, "MEMORY.md"), "should not be parsed\n");
      await rebuildIndex(dir);
      const index = await fs.readFile(path.join(dir, "MEMORY.md"), "utf8");
      assert.match(index, /good\.md/);
      assert.doesNotMatch(index, /junk\.md/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe("loader — renderMemorySnapshot", () => {
  test("returns empty string when no memories", async () => {
    const dir = await tmpdir();
    try {
      const out = await renderMemorySnapshot({ projectDir: dir });
      assert.equal(out, "");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("renders sections by type and includes bodies", async () => {
    const dir = await tmpdir();
    try {
      const projectDir = dir;
      await writeMemory({ name: "u", description: "user fact", type: "user", body: "U body", scope: "project", projectDir });
      await writeMemory({ name: "f", description: "feedback rule", type: "feedback", body: "F body", scope: "project", projectDir });
      const out = await renderMemorySnapshot({ projectDir });
      assert.match(out, /## Memory bank/);
      assert.match(out, /### User/);
      assert.match(out, /### Feedback/);
      assert.match(out, /U body/);
      assert.match(out, /F body/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("renderMemoryIndex lists names only", async () => {
    const dir = await tmpdir();
    try {
      const projectDir = dir;
      await writeMemory({ name: "a", description: "x", type: "user", body: "AAA", scope: "project", projectDir });
      const out = await renderMemoryIndex({ projectDir });
      assert.match(out, /## Memory index/);
      assert.match(out, /\*\*a\*\*/);
      assert.doesNotMatch(out, /AAA/); // bodies excluded
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe("memory tool — executeMemoryTool", () => {
  test("memory_save writes a project-scope file the agent can read back", async () => {
    const dir = await tmpdir();
    try {
      const res = await executeMemoryTool(
        "memory_save",
        {
          name: "tool-test",
          description: "from the tool",
          type: "feedback",
          body: "Always read before writing.",
          scope: "project",
        },
        { rootDir: dir },
      );
      assert.equal(res.ok, true);
      assert.match(res.text, /Wrote project memory "tool-test"/);

      const back = await readMemoryByName("tool-test", { projectDir: dir });
      assert.ok(back);
      assert.equal(back.body, "Always read before writing.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("memory_save rejects missing fields", async () => {
    const res = await executeMemoryTool(
      "memory_save",
      { name: "x", description: "d", type: "user" /* body missing */ },
      {},
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /missing required field "body"/);
  });

  test("memory_save rejects invalid type", async () => {
    const dir = await tmpdir();
    try {
      const res = await executeMemoryTool(
        "memory_save",
        {
          name: "bad-type",
          description: "d",
          type: "garbage",
          body: "b",
          scope: "project",
        },
        { rootDir: dir },
      );
      assert.equal(res.ok, false);
      assert.match(res.error, /Memory type must be one of/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("memory_list reports stored entries", async () => {
    const dir = await tmpdir();
    try {
      await executeMemoryTool(
        "memory_save",
        { name: "first", description: "one", type: "user", body: "A", scope: "project" },
        { rootDir: dir },
      );
      const res = await executeMemoryTool("memory_list", {}, { rootDir: dir });
      assert.equal(res.ok, true);
      assert.match(res.text, /first/);
      assert.match(res.text, /one/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test.describe("compactor", () => {
  test("totalChars sums message content", () => {
    const msgs = [{ content: "abc" }, { content: "defg" }];
    assert.equal(totalChars(msgs), 7);
  });

  test("shouldCompact false when under threshold", () => {
    const msgs = Array.from({ length: 20 }, () => ({ role: "user", content: "tiny" }));
    assert.equal(shouldCompact(msgs, { softCapChars: 1000, minMessages: 5 }), false);
  });

  test("shouldCompact true when over threshold", () => {
    const big = "x".repeat(10_000);
    const msgs = Array.from({ length: 20 }, () => ({ role: "user", content: big }));
    assert.equal(shouldCompact(msgs, { softCapChars: 50_000, minMessages: 5 }), true);
  });

  test("compactMessages preserves head + tail and inserts summary", async () => {
    const msgs = [
      { role: "user", content: "TASK" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "step1" },
      { role: "assistant", content: "ok1" },
      { role: "user", content: "step2" },
      { role: "assistant", content: "ok2" },
      { role: "user", content: "step3" },
      { role: "assistant", content: "ok3" },
      { role: "user", content: "current" },
      { role: "assistant", content: "current-reply" },
    ];
    const out = await compactMessages(msgs, { keepHead: 2, keepTail: 2 });
    assert.equal(out[0].content, "TASK");
    assert.equal(out[1].content, "ack");
    assert.match(out[2].content, /Conversation summary/);
    assert.equal(out[out.length - 2].content, "current");
    assert.equal(out[out.length - 1].content, "current-reply");
    assert.ok(out.length < msgs.length);
  });

  test("compactMessages no-op when under combined keep limit", async () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ];
    const out = await compactMessages(msgs, { keepHead: 2, keepTail: 2 });
    assert.equal(out.length, msgs.length);
  });
});
