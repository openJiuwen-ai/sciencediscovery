// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { settingsConfirmationInstruction } from "./settings-confirmation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
for (const completed of [true, false]) test(`Manual confirmation ${completed} is projected as a self-report, never a verified change or refusal`, () => {
  const instruction = settingsConfirmationInstruction({ destination: "models", completed, source: "user", verified: false, configurationWritten: false, confirmedAt: "now" });
  assert.match(instruction, completed ? /reports completing manual/ : /reports not completing manual/);
  assert.match(instruction, /not verification/); assert.match(instruction, /Continue the original task/);
  assert.match(instruction, /do not reapply/); assert.doesNotMatch(instruction, /declined|approved and saved/);
});
