// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";

import { canExportSession } from "../src/app/session-export.js";

const projects = [{ id: "p1" }, { id: "p2" }];

test("a session is exportable only while its project is reachable", () => {
  assert.equal(canExportSession({ projectId: "p1" }, projects, "inbox"), true);
  assert.equal(canExportSession({ projectId: "inbox" }, projects, "inbox"), true,
    "the inbox is not a removed project");
  assert.equal(canExportSession({ projectId: "gone" }, projects, "inbox"), false,
    "a removed project refuses at both entry points");
  assert.equal(canExportSession({ projectId: "p1" }, [], "inbox"), false,
    "a project that has not loaded yet refuses too");
});
