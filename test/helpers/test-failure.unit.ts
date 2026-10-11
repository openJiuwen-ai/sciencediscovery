// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createTest } from "../support/tagged/compat.mjs";
import { failureHeadline, plainText } from "./test-failure.ts";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

// The shape Playwright gives a failed `expect(…, message).toBe(…)`: colored for a terminal, then the stack.
const assertion = [
  "Error: Main run must complete and reference a readable nonempty final artifact",
  "",
  "\u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m",
  "",
  "Expected: \u001b[32m\"passed\"\u001b[39m",
  "Received: \u001b[31m\"failed\"\u001b[39m",
  "    at /work/test/deepresearchbench-swarm.spec.ts:95:7",
].join("\n");

test("a failure headline says what failed and what was received, without colors or stack", () => {
  assert.deepEqual(failureHeadline(assertion), [
    "Error: Main run must complete and reference a readable nonempty final artifact",
    "expect(received).toBe(expected) // Object.is equality",
    "Expected: \"passed\"",
    "Received: \"failed\"",
  ]);
});

test("a timed-out poll keeps the timeout from its call log", () => {
  const poll = [
    "Error: Run r1 should reach a terminal state",
    "",
    "expect(received).toMatch(expected)",
    "",
    "Expected pattern: /^(cancelled|completed|failed|interrupted)$/",
    "Received string:  \"running\"",
    "",
    "Call Log:",
    "- Timeout 5400000ms exceeded while waiting on the predicate",
    "    at waitForRunTerminal (/work/test/helpers/journeys.ts:511:3)",
  ].join("\n");
  assert.equal(failureHeadline(poll).at(-1), "- Timeout 5400000ms exceeded while waiting on the predicate");
});

test("a failure headline stays short however long the message is", () => {
  const long = Array.from({ length: 20 }, (_, index) => `line ${index} ${"x".repeat(400)}`).join("\n");
  const lines = failureHeadline(long);
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => line.length <= 301));
  assert.equal(plainText("\u001b[1mbold\u001b[22m"), "bold");
});
