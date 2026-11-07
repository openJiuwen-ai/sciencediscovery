// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { shellFailureDiagnostic } from "./shell-diagnostics.js";

test("command-not-found failures carry bounded recovery guidance", () => {
  assert.deepEqual(shellFailureDiagnostic(127, "/usr/bin/bash: line 2: head: command not found\n"), {
    code: "COMMAND_NOT_FOUND",
    command: "head",
    instruction: "Inspect check_runner shell.utilities and use an available command or Python equivalent; do not retry the same command unchanged.",
  });
  assert.equal(shellFailureDiagnostic(1, "head: command not found\n"), undefined);
  assert.equal(shellFailureDiagnostic(127, "script selected exit 127\n"), undefined);
  assert.equal(shellFailureDiagnostic(127, "bad command; rm -rf workspace: command not found\n"), undefined);
});
