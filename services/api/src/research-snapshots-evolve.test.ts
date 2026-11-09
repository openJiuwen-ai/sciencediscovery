// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { packageRanEvolve } from "./research-snapshots.js";

test("a package proves an evolve search ran only through its published result artifact", () => {
  // #1019: a run's result is published as `evolve/<run>/<entrypoint>`, so that
  // artifact is the package's own evidence a search existed. A package from a
  // session that never ran one must not report the loss.
  assert.equal(packageRanEvolve(undefined), false);
  assert.equal(packageRanEvolve([]), false);
  assert.equal(packageRanEvolve([{ name: "results/result.csv" }, { name: "analysis.ipynb" }]), false);
  assert.equal(packageRanEvolve([{ name: "evolve/83cbb6de/main.py" }]), true);
  assert.equal(packageRanEvolve([{ name: "results/a.csv" }, { name: "evolve/a539ffc0/run.py" }]), true);
});

test("an artifact without a usable name is not evidence either way", () => {
  // The field is `unknown` at the package boundary; a malformed entry must not
  // throw during import.
  assert.equal(packageRanEvolve([{}]), false);
  assert.equal(packageRanEvolve([{ name: 42 }]), false);
  assert.equal(packageRanEvolve([{ name: null }]), false);
});