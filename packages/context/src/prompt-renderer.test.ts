// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";


import { DeterministicSystemPromptRenderer } from "./prompt-renderer.js";

test("prompt renderer orders sections deterministically", () => {
  const result = new DeterministicSystemPromptRenderer().render([
    { content: "capability", contributorId: "tools", id: "tools", priority: 500, slot: "capabilities" },
    { content: "identity", contributorId: "workspace", id: "identity", priority: 100, protected: true, slot: "identity" },
    { content: "contract", contributorId: "run", id: "contract", priority: 300, protected: true, slot: "run_contract" },
  ]);
  assert.equal(result.systemPrompt, "identity\ncontract\ncapability");
  assert.deepEqual(result.sectionIds, ["identity", "contract", "tools"]);
});
