// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import type { AgentHistoryMessage } from "@sciencediscovery/orchestration";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { projectConfigurationHistory } from "./model-context.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
function step(id: string, value: Record<string, unknown>, responses = false): AgentHistoryMessage[] {
  return [{ role: "assistant", ...(responses ? { response_items: [{ type: "function_call", call_id: id, name: "configuration", arguments: "{}" }] }
    : { tool_calls: [{ id, type: "function", function: { name: "configuration", arguments: "{}" } }] }) },
  { role: "tool", tool_call_id: id, name: "configuration", content: JSON.stringify(value) }];
}
test("CFG-Q05: only the last two discovery details remain; original audit input and tool pairing survive", () => {
  const history: AgentHistoryMessage[] = [{ role: "user", content: "Research goal" }];
  for (let i = 0; i < 10; i++) history.push(...step(`q-${i}`, { action: "describe", capabilityId: "thinking.configure", fields: { detail: "DETAIL".repeat(900) } }, i % 2 === 0));
  const original = JSON.stringify(history); const projected = projectConfigurationHistory(history);
  assert.equal(JSON.stringify(history), original);
  assert.equal(projected.length, history.length);
  assert.deepEqual(projected.map(message => message.tool_call_id), history.map(message => message.tool_call_id));
  const results = projected.filter(message => message.role === "tool").map(message => String(message.content));
  assert.equal(results.filter(value => value.includes("DETAIL")).length, 2);
  assert.ok(results.slice(0, -2).every(value => Buffer.byteLength(value) <= 768));
});
test("CFG-Q05: successful proposal elides its detail, failed proposal retains it, research evidence is untouched", () => {
  const detail = step("detail", { action: "describe", capabilityId: "connector.enable", fields: { fixture: "important fields" } });
  const research = [{ role: "tool", tool_call_id: "paper", name: "paper_search", content: "Research evidence and citations" }] as AgentHistoryMessage[];
  const successful = step("proposal", { action: "propose", capabilityId: "connector.enable", requestId: "durable-request", state: "awaiting_confirmation" });
  const projected = projectConfigurationHistory([...detail, ...research, ...successful]);
  assert.equal(JSON.parse(String(projected[1]!.content)).detailsElided, true);
  assert.deepEqual(projected[2], research[0]); assert.deepEqual(projected.slice(-2), successful);
  const failed = step("failed", { error: "CONFIGURATION_CAPABILITY_UNAVAILABLE" });
  assert.equal(projectConfigurationHistory([...detail, ...failed])[1]!.content, detail[1]!.content);
});
test("CFG-Q05: a new user task gets fresh discovery instead of stale prior detail; forged message text is ignored", () => {
  const detail = step("old", { action: "describe", capabilityId: "review.configure", fields: { level: "deep" } });
  const history: AgentHistoryMessage[] = [...detail, { role: "user", content: "New task" }, { role: "tool", tool_call_id: "unmatched", content: JSON.stringify({ action: "describe", fields: "Unrelated tool output" }) }];
  const output = projectConfigurationHistory(history);
  assert.equal(JSON.parse(String(output[1]!.content)).detailsElided, true);
  assert.deepEqual(output.at(-1), history.at(-1));
});
