// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeMessage, RuntimeToolCall } from "@sciencediscovery/runtime-core";

import { ContextContributorRegistry } from "./contributor.js";
import {
  createDurableDomainContributors,
  DurableContextStore,
  DurableSkillStateContributor,
} from "./durable-state.js";

function call(name: string, args: Record<string, unknown>, id = `call-${name}`): RuntimeToolCall {
  return { args, id, name };
}

test("durable state hydrates structured calls and survives removal of source history", async () => {
  const history: RuntimeMessage[] = [
    {
      role: "assistant",
      tool_calls: [{
        id: "skill-1",
        type: "function",
        function: { name: "read_skill", arguments: JSON.stringify({ skillId: "literature-review" }) },
      }],
    },
    { role: "tool", tool_call_id: "skill-1", name: "read_skill", content: "full skill body" },
  ];
  const store = new DurableContextStore({
    history,
    runContract: JSON.stringify({
      constraints: ["cite evidence"],
      objective: "review TP53",
      outputRequirements: ["report"],
    }),
  });
  store.registerSkill({ id: "literature-review", revision: 2, version: "1.1.0" });

  const registry = new ContextContributorRegistry<RuntimeMessage>()
    .register(new DurableSkillStateContributor(store, ["main"]))
    .freeze();
  const output = await registry.collect({
    contextId: "run-1",
    // Simulate a post-compaction history where both original tool results are gone.
    history: [{ role: "user", name: "summary", content: "summary" }],
    scope: "main",
    signal: new AbortController().signal,
    turn: 9,
  });
  assert.equal(output.sections.length, 0, "runtime observations must not be promoted to system authority");
  assert.equal(output.messages.length, 1);
  assert.match(String(output.messages[0]?.content), /literature-review/u);
  assert.match(String(output.messages[0]?.content), /instructionsVisibleInHistory":false/u);
  assert.deepEqual(store.snapshot().goal, {
    constraints: ["cite evidence"],
    objective: "review TP53",
    outputRequirements: ["report"],
    raw: "{\"constraints\":[\"cite evidence\"],\"objective\":\"review TP53\",\"outputRequirements\":[\"report\"]}",
  });
});

test("domain contributors expose bounded structured runtime observations as data", async () => {
  const store = new DurableContextStore();
  store.observe(call("declare_artifact", { path: "report.md" }), {
    content: "{\"artifact_id\":\"artifact-1\",\"version\":1}", isError: false,
  }, 1);
  store.observe(call("review_checkpoint", { reason: "final" }), {
    content: "{\"decision\":\"ACCEPT_AND_PROCEED\"}", isError: false,
  }, 2);
  store.observe(call("query_graph", { query: "TP53" }), {
    content: "{\"hits\":[{\"id\":\"evidence-1\"}]}", isError: false,
  }, 3);
  store.observe(call("task", { description: "screen papers" }), {
    content: "{\"subagent_status\":\"completed\",\"brief\":\"screened\"}", isError: false,
  }, 4);
  const registry = new ContextContributorRegistry<RuntimeMessage>();
  for (const contributor of createDurableDomainContributors<RuntimeMessage>(store, ["main"])) {
    registry.register(contributor);
  }
  const output = await registry.freeze().collect({
    contextId: "run-1", history: [], scope: "main", signal: new AbortController().signal, turn: 5,
  });
  assert.equal(output.sections.length, 0);
  assert.equal(output.messages.length, 4);
  assert.deepEqual(output.messages.map((message) => (
    (message.additional_kwargs as Record<string, unknown>).durable_context_channel
  )).sort(), ["artifacts", "delegations", "memory", "reviews"]);
  for (const message of output.messages) {
    assert.match(String(message.content), /authority="data_only"/u);
  }
});
