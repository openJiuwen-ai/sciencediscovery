// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";

import { stepAwaitingIdea } from "../src/idea/awaiting.js";

test("the first read after the command is the baseline, not news", () => {
  // A research that predates the command must never be taken for the one it
  // created; a slow first read is the reason this baseline exists.
  const first = stepAwaitingIdea(undefined, ["older"]);
  assert.deepEqual([...(first.baseline ?? [])], ["older"]);
  assert.equal(first.fresh, undefined);
});

test("only an id a later read adds is the research this window asked for", () => {
  const first = stepAwaitingIdea(undefined, ["older"]);
  const second = stepAwaitingIdea(first.baseline, ["older", "created"]);
  assert.equal(second.fresh, "created");
});

test("an empty first read keeps waiting, and the next read's research is the new one", () => {
  const first = stepAwaitingIdea(undefined, []);
  assert.equal(first.fresh, undefined);
  const second = stepAwaitingIdea(first.baseline, ["created"]);
  assert.equal(second.fresh, "created");
});

test("with a finished read before the command, its ids are the baseline", () => {
  // The common case: the session was already read, so a research that shows up
  // in the very next read is the new one — even if the agent was fast.
  assert.equal(stepAwaitingIdea(new Set<string>(), ["created"]).fresh, "created");
  assert.equal(stepAwaitingIdea(new Set(["older"]), ["older", "created"]).fresh, "created");
});

test("a read that adds nothing is not news", () => {
  const baseline = stepAwaitingIdea(undefined, ["a"]).baseline;
  assert.equal(stepAwaitingIdea(baseline, ["a"]).fresh, undefined);
});
