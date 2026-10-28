// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import type { ModelProfile } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { thinkingChoices } from "./p1-adapters.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
test("CFG-R11: unknown model effort remains unknown unless the user declared finite support", () => {
  const model = { model: "unlisted-gateway-model", apiProtocol: "openai-responses", apiVariant: "responses" } as ModelProfile;
  assert.deepEqual(thinkingChoices(model), { modes: [], efforts: [] });
  assert.deepEqual(thinkingChoices({ ...model, facts: { thinkingEfforts: ["low", "high"] } }).efforts, ["low", "high"]);
  assert.deepEqual(thinkingChoices({ ...model, facts: { thinkingSupported: false, thinkingEfforts: ["low", "high"] } }), { modes: [], efforts: [] });
});
