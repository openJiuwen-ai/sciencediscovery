// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import {
  appendEvolveDirection, EVOLVE_BASELINE_LIMIT, EVOLVE_EDITABLE_LIMIT, evolveCommandTask,
  readEvolveAlgorithm, readEvolveDirection, withEvolveAlgorithm,
} from "./evolve-direction.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("evolve command helpers read and replace the algorithm without consuming task text or other flags", () => {
  const task = "Tune policy --algorithm puct";
  const cases = [
    ["/evolve-design --allow-direct --no-confirm", "puct", "/evolve-design --algorithm openevolve --allow-direct --no-confirm"],
    ["/evolve-design --algorithm puct --no-confirm", "puct", "/evolve-design --algorithm openevolve --no-confirm"],
    ["/evolve-design --allow-direct --no-confirm --algorithm puct", "puct", "/evolve-design --allow-direct --no-confirm --algorithm openevolve"],
    ["/evolve-design --algorithm openevolve", "openevolve", "/evolve-design --algorithm openevolve"],
  ] as const;
  for (const [prefix, algorithm, updated] of cases) {
    const command = `${prefix} ${task}`;
    assert.equal(evolveCommandTask(command), task);
    assert.equal(readEvolveAlgorithm(command), algorithm);
    assert.equal(withEvolveAlgorithm(command, "openevolve"), `${updated} ${task}`);
  }
  assert.equal(withEvolveAlgorithm("Discuss policy", "openevolve"), "Discuss policy");
});

test("direction round trips only on an Evolve command with a terminal block", () => {
  const command = "/evolve-design --no-confirm Tune policy";
  const direction = { baseline: '{"weight":0,"fixed":null}', editable: ["weight"] };
  const message = appendEvolveDirection(command + "  ", direction);
  assert.equal(message, command + "\n\n```evolve-input\n" + JSON.stringify(direction) + "\n```");
  assert.deepEqual(readEvolveDirection("  " + message + "\n"), direction);
  assert.equal(readEvolveDirection(command), undefined);
  assert.equal(readEvolveDirection(appendEvolveDirection("/evolve-design-extra", direction)), undefined);
  assert.equal(readEvolveDirection(message + "\ntrailing text"), undefined);
  assert.equal(readEvolveDirection(command + "\n```evolve-input\n{invalid}\n```"), "invalid");
});

test("direction refuses malformed baselines and out-of-scope editable lists", () => {
  const baseline = '{"weight":0,"nested":{"weight":1}}';
  const tooMany = Array.from({ length: EVOLVE_EDITABLE_LIMIT + 1 }, (_, index) => `field_${index}`);
  const manyFields = JSON.stringify(Object.fromEntries(tooMany.map(name => [name, 0])));
  const oversize = JSON.stringify({ weight: "x".repeat(EVOLVE_BASELINE_LIMIT) });
  const cases = [
    { baseline, editable: [] },
    { baseline, editable: ["weight", "weight"] },
    { baseline, editable: ["nested.weight"] },
    { baseline: manyFields, editable: tooMany },
    { baseline: oversize, editable: ["weight"] },
    { baseline: "[]", editable: ["weight"] },
    { baseline: "{broken", editable: ["weight"] },
  ];
  for (const direction of cases) {
    assert.equal(readEvolveDirection(appendEvolveDirection("/evolve-design Tune policy", direction)), "invalid");
  }
  assert.deepEqual(readEvolveDirection(appendEvolveDirection("/evolve-design Tune policy", {
    baseline: manyFields, editable: tooMany.slice(0, EVOLVE_EDITABLE_LIMIT),
  })), { baseline: manyFields, editable: tooMany.slice(0, EVOLVE_EDITABLE_LIMIT) });
});
