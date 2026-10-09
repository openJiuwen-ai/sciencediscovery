// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { researchModel } from "./research-model.ts";

const child = (name: string, prior = false) => ({
  messages: [{ role: "system", content: "Applied subagent preset general-purpose" }, { role: "user", content: `LR_CHILD_${name}` },
    ...(prior ? [{ role: "assistant", tool_calls: [{ id: `lr_${name}_0_0` }] }, { role: "tool", content: `RESULT_${name}` }] : [])],
  tools: [{ function: { name: "run_shell" } }], stream: true,
});

test("controlled upstream failures are replayable without becoming fixture assertion errors", async () => {
  const stub = await researchModel({ main: [{ httpStatus: 503 }] });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({
        messages: [{ role: "user", content: "fixture" }], tools: [{ function: { name: "run_shell" } }],
      }) });
      assert.equal(response.status, 503);
      assert.match(await response.text(), /Controlled upstream failure/);
    }
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(stub.errors, []);
  } finally { await stub.stop(); }
});

test("research model isolates parallel children and replays requests from history", async () => {
  const stub = await researchModel({
    a: [{ gate: "a", tools: [{ name: "run_shell", arguments: { command: "printf A" } }] }, { text: "DONE_A" }],
    b: [{ text: "DONE_B" }],
  });
  const post = async (body: unknown) => fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify(body) });
  try {
    const a = await post(child("a"));
    const b = await post(child("b"));
    assert.match(await b.text(), /DONE_B/);
    assert.equal(stub.calls.find(c => c.route === "a")?.endedAt, undefined);
    stub.release("a");
    const first = await a.text();
    assert.match(first, /lr_a_0_0/);
    assert.equal(await (await post(child("a"))).text(), first);
    assert.match(await (await post(child("a", true))).text(), /DONE_A/);
    assert.deepEqual(stub.calls.at(-1)?.results, ["RESULT_a"]);
    assert.deepEqual(stub.errors, []);
  } finally { await stub.stop(); }
});

test("malformed arguments remain malformed on the wire", async () => {
  const stub = await researchModel({ main: [{ tools: [{ name: "run_shell", arguments: {}, rawArguments: '{"command":' }] }] });
  try {
    const response = await fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({
      messages: [{ role: "user", content: "fixture" }], tools: [{ function: { name: "run_shell" } }],
    }) });
    const chunks = (await response.text()).split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
    const call = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? [])[0];
    assert.equal(call.function.arguments, '{"command":');
    assert.throws(() => JSON.parse(call.function.arguments));
  } finally { await stub.stop(); }
});

test("missing tools fail the fixture instead of fabricating tool execution", async () => {
  const stub = await researchModel({ main: [{ tools: [{ name: "run_shell", arguments: {} }] }] });
  try {
    const response = await fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({
      messages: [{ role: "user", content: "fixture" }], tools: [{ function: { name: "read_file" } }],
    }) });
    assert.equal(response.status, 500);
    assert.match(stub.errors[0]!, /Tool not offered/);
  } finally { await stub.stop(); }
});

test("Swarm compression with inherited tool schemas uses the summary fixture, not main task steps", async () => {
  const stub = await researchModel({ main: [{ tools: [{ name: "run_shell", arguments: {} }] }] }, {
    summary: () => "<coverage_check>covered</coverage_check><state_snapshot>CHECKPOINT</state_snapshot>",
  });
  try {
    const response = await fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", body: JSON.stringify({
      messages: [{ role: "user", content: "Do NOT call any tools. Return <coverage_check> and <state_snapshot>." }],
      tools: [{ function: { name: "run_shell" } }],
    }) });
    const wire = await response.text();
    assert.match(wire, /CHECKPOINT/);
    assert.doesNotMatch(wire, /tool_calls/);
    assert.equal(stub.calls[0]?.route, "summary");
    assert.deepEqual(stub.errors, []);
  } finally { await stub.stop(); }
});
