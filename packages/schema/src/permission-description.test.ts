// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { normalizePermissionDescription } from "./permission-description.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

test("a tool-call description keeps the command or arguments being approved", () => {
  // run_shell's approved resource is the fixed workspace-code, so the command
  // survives normalization only as the description's detail.
  assert.deepEqual(
    normalizePermissionDescription({ detail: "  rm -rf out\n", kind: "tool-call", toolName: "run_shell" }),
    { detail: "rm -rf out", kind: "tool-call", toolName: "run_shell" },
  );
  assert.deepEqual(
    normalizePermissionDescription({ detail: '{"celsius": -40}', kind: "tool-call", toolName: "mcp__custom-1__to_kelvin" }),
    { detail: '{"celsius": -40}', kind: "tool-call", toolName: "mcp__custom-1__to_kelvin" },
  );
  // The field stays optional: a description persisted before it existed, or
  // one with only whitespace, is still a valid tool-call description.
  assert.deepEqual(normalizePermissionDescription({ kind: "tool-call", toolName: "run_shell" }),
    { kind: "tool-call", toolName: "run_shell" });
  assert.deepEqual(normalizePermissionDescription({ detail: "   ", kind: "tool-call" }), { kind: "tool-call" });
  // Anything that is not a string is dropped whole rather than rendered.
  assert.deepEqual(normalizePermissionDescription({ detail: 42, kind: "tool-call", toolName: "run_shell" }),
    { kind: "tool-call", toolName: "run_shell" });
});
