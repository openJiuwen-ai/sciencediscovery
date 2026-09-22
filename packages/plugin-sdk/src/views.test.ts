// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createViewRegistry } from "./views.js";
test("view selection is deterministic and disabled plugins do not contribute", () => {
  const entry = (id: string, priority: number) => ({ id, pluginId: id, priority, matches: () => true, render: () => id });
  const registry = createViewRegistry([entry("b", 1), entry("a", 1), entry("c", 2)], ["c"]);
  assert.equal(registry.resolve(null)?.render(null), "a");
  assert.equal(createViewRegistry([entry("a", 1)], ["a"]).resolve(null), undefined);
  assert.throws(() => createViewRegistry([entry("a", 1), entry("a", 2)]), /duplicate/);
});
