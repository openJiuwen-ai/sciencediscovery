// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { ToolOutputGuard } from "./bounded-output.js";
import { createToolOutputTools, ToolOutputStore } from "./tool-output-store.js";

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n");

let rootSequence = 0;

async function temporaryRoot(context: { after(fn: () => unknown): void }): Promise<string> {
  const root = resolve(process.cwd(), ".tmp", `tool-output-store-${process.pid}-${Date.now()}-${rootSequence += 1}`);
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("a saved result is paged back by 1-based line range", async () => {
  const store = new ToolOutputStore();
  const saved = await store.save("run_python", numbered(500));
  assert.equal(saved.lines, 500);
  assert.match(saved.ref, /^tool-output-[0-9a-f]{16}$/);

  const first = await store.read(saved.ref, { limit: 100 });
  assert.equal(first.startLine, 1);
  assert.equal(first.endLine, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 101);
  assert.equal(first.text.startsWith("line-1\n"), true);

  const next = await store.read(saved.ref, { limit: 100, offset: first.nextOffset });
  assert.equal(next.startLine, 101);
  assert.equal(next.text.startsWith("line-101\n"), true);

  const last = await store.read(saved.ref, { limit: 100, offset: 401 });
  assert.equal(last.endLine, 500);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextOffset, undefined);
});

test("a page is capped by bytes even when the caller asks for more lines", async () => {
  const store = new ToolOutputStore();
  const saved = await store.save("web_fetch", `${"w".repeat(1_000)}\n`.repeat(500));
  const page = await store.read(saved.ref, { limit: 10_000 });
  assert.ok(page.bytes <= 40 * 1_024, `page is ${page.bytes} bytes`);
  assert.equal(page.hasMore, true);
});

test("a reference resolves from disk after the producing process forgot it", async (context) => {
  const root = await temporaryRoot(context);
  const producer = new ToolOutputStore({ root });
  const saved = await producer.save("mcp__pubmed__search", numbered(30));

  const laterRun = new ToolOutputStore({ root });
  const page = await laterRun.read(saved.ref);
  assert.equal(page.toolName, "mcp__pubmed__search");
  assert.equal(page.totalLines, 30);
});

test("refs are validated before they can reach the filesystem", async (context) => {
  const root = await temporaryRoot(context);
  const store = new ToolOutputStore({ root });
  await assert.rejects(store.read("../../etc/passwd"), /Unknown tool output ref/);
  await assert.rejects(store.read("tool-output-00000000000000ff"), /no longer available/);
});

test("expired records are pruned so a long-lived session directory stays bounded", async (context) => {
  const root = await temporaryRoot(context);
  const expired = new ToolOutputStore({ retentionMs: -1, root });
  const stale = await expired.save("run_shell", "old output");
  assert.ok(await new ToolOutputStore({ root }).read(stale.ref), "the record exists before the next store prunes it");

  const later = new ToolOutputStore({ retentionMs: -1, root });
  await later.save("run_shell", "new output");
  await assert.rejects(new ToolOutputStore({ root }).read(stale.ref), /no longer available/);
});

test("retention caps one stored result and reports the dropped bytes", async () => {
  const store = new ToolOutputStore({ retainedBytes: 1_000 });
  const saved = await store.save("run_shell", "d\n".repeat(5_000));
  assert.ok(saved.bytes <= 1_000);
  assert.equal(saved.droppedBytes, 10_000 - saved.bytes);
});

test("read_tool_output returns a self-bounded page with a continue hint", async () => {
  const store = new ToolOutputStore();
  const saved = await store.save("run_python", numbered(300));
  const [readToolOutput] = createToolOutputTools(store);
  assert.ok(readToolOutput);

  const result = await readToolOutput.execute("call-1", { limit: 50, ref: saved.ref });
  const text = result.content[0]?.text ?? "";
  assert.equal(result.bounded, true);
  assert.match(text, /\[tool output page] run_python ref tool-output-[0-9a-f]{16}: lines 1-50 of 300/);
  assert.match(text, new RegExp(`Continue with read_tool_output\\(ref="${saved.ref}", offset=51\\)`));
  assert.equal(text.includes("line-50\n"), true);
  assert.equal(text.includes("line-51"), false);

  const tail = await readToolOutput.execute("call-2", { offset: 291, ref: saved.ref });
  assert.match(tail.content[0]?.text ?? "", /This is the end of the stored output\./);
});

test("an oversized result is stored whole and its omitted head is recoverable", async (context) => {
  const root = await temporaryRoot(context);
  const store = new ToolOutputStore({ root });
  const guard = new ToolOutputGuard({ sink: store });
  const full = numbered(60_000);

  const bounded = await guard.apply("run_python", full);
  assert.equal(bounded.includes("line-1\n"), false, "the head is not in the current tool result");

  const ref = /ref "(tool-output-[0-9a-f]{16})"/.exec(bounded)?.[1];
  assert.ok(ref, "the bounded result carries a ref");
  const page = await store.read(ref, { limit: 5 });
  assert.equal(page.text, "line-1\nline-2\nline-3\nline-4\nline-5\n");
  assert.equal(page.totalLines, 60_000);
  // The stored file lives under the session-scoped root and nowhere else.
  assert.equal(resolve(root, `${ref}.json`).startsWith(root), true);
});
