// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { captureStateView, createStateView, canonicalState, type StateProvider } from "./state-view.js";

const component = (value: number) => ({ id: "plan", schemaVersion: 1, revision: String(value), value: { value }, fidelity: "captured" as const });
test("state views retain immutable values and restrict component access", () => {
  const state = component(1);
  const view = createStateView({ id: "run:1", scope: "session:a", components: [state] });
  state.value.value = 2;
  const read = view.read<{ value: number }>("plan"); read.value = 3;
  assert.deepEqual(view.read("plan"), { value: 1 });
  (view.checkpoint.components[0]!.value as { value: number }).value = 4;
  assert.deepEqual(view.read("plan"), { value: 1 });
  assert.throws(() => view.restrict([]).read("plan"), /not available/);
  assert.throws(() => view.read("plan", 2), /schema/);
  assert.throws(() => canonicalState({ invalid: undefined }), /finite JSON/);
});
test("capture retries revision changes and rejects continuously changing state", async () => {
  let reads = 0;
  const provider: StateProvider = { id: "plan", capture: async () => component(Math.min(++reads, 2)) };
  const input = { id: "run:1", scope: "session", signal: new AbortController().signal, providers: [provider] };
  assert.deepEqual((await captureStateView(input)).read("plan"), { value: 2 });
  await assert.rejects(captureStateView({ ...input, providers: [{ id: "plan", capture: async () => component(++reads) }] }), /changed/);
  await assert.rejects(captureStateView({ ...input, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(captureStateView({ ...input, providers: [provider, provider] }), /Duplicate/);
});

test("reference-only observations are pinned once while local states still converge", async () => {
  let observations = 0, localReads = 0;
  const providers: StateProvider[] = [
    { id: "authorities", capture: async () => ({ ...component(++observations), id: "authorities", fidelity: "reference-only" }) },
    { id: "plan", capture: async () => component(Math.min(++localReads, 2)) },
  ];
  const input = { id: "run:1", scope: "session", signal: new AbortController().signal, providers };
  const first = await captureStateView(input);
  assert.equal(observations, 1, "sibling progress must not invalidate the checkpoint");
  assert.deepEqual(first.read("authorities"), { value: 1 });
  assert.deepEqual(first.read("plan"), { value: 2 });
  assert.equal(first.checkpoint.components.find(state => state.id === "authorities")?.fidelity, "reference-only");
  const next = await captureStateView({ ...input, id: "run:2" });
  assert.deepEqual(next.read("authorities"), { value: 2 }, "a new checkpoint takes a fresh observation");
  assert.deepEqual(first.read("authorities"), { value: 1 }, "recording and projection retain the original observation");
  await assert.rejects(captureStateView({ ...input, providers: [providers[0]!,
    { id: "plan", capture: async () => component(++localReads) }],
  }), /State changed during checkpoint capture: plan/);
});
