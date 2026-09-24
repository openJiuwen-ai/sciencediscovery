import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { recordInvalidArguments } from "./model-argument-diagnostics.js";

test("argument diagnostics are opt-in, bounded, rotated and safe for concurrent writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "argument-diagnostics-"));
  const file = join(dir, "errors.jsonl");
  const previous = process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE;
  t.mock.method(console, "warn", () => {});
  const raw = "HEAD" + "x".repeat(20000) + "TAIL";
  const turn = {
    assistantMessage: { role: "assistant" as const, content: "", tool_calls: [
      { id: "call", type: "function", function: { name: "tool", arguments: raw } },
    ] },
    toolCalls: [{ id: "call", name: "tool", args: {}, argsParseError: "invalid JSON" }],
  };
  try {
    delete process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE;
    await recordInvalidArguments(turn, "disabled");
    await assert.rejects(readFile(file), { code: "ENOENT" });
    process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE = file;
    await writeFile(file, "x".repeat(5 * 1024 * 1024));
    await Promise.all([recordInvalidArguments(turn, "first"), recordInvalidArguments(turn, "second")]);
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.requestId), ["first", "second"]);
    assert.equal((await readFile(`${file}.1`)).length, 5 * 1024 * 1024);
    assert.equal(lines[0].calls[0].clipped, true);
    assert.equal(lines[0].calls[0].argumentChars, raw.length);
    assert.equal(lines[0].calls[0].rawArguments, undefined);
    assert.ok(lines[0].calls[0].head.startsWith("HEAD"));
    assert.ok(lines[0].calls[0].tail.endsWith("TAIL"));
    assert.equal(lines[0].calls[0].head.length + lines[0].calls[0].tail.length, 16384);
    const before = await readFile(file, "utf8");
    await recordInvalidArguments({ assistantMessage: { role: "assistant", content: "ok" }, toolCalls: [] }, "valid");
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    if (previous === undefined) delete process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE;
    else process.env.SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
