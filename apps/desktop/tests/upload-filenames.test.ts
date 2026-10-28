// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { uploadWorkspaceFiles } from "../src/api/sessions.js";
import { StubClient } from "./api-stub.js";

for (const [name, expected] of [["../outside.txt", "outside.txt"], ["a/b.txt", "b.txt"], ["C:\\folder\\notes.md", "notes.md"], ["notes.md", "notes.md"], ["测量.csv", "测量.csv"]] as const) {
  test(`workspace uploads send only the basename of ${name}`, async () => {
    const stub = new StubClient().reply({ files: [] });
    const file = new File(["contents"], name);
    await uploadWorkspaceFiles(stub.asClient(), "session/one", [file]);
    const call = stub.calls[0]!;
    const uploaded = (call.init.body as FormData).get("files") as File;
    assert.equal(uploaded.name, expected);
    assert.equal(await uploaded.text(), "contents");
    assert.equal(call.path, "/api/sessions/session%2Fone/workspace/upload?conflict=rename");
  });
}

test("invalid terminal filename components are rejected before sending a batch", () => {
  for (const name of ["", ".", "..", "folder/", "folder/.."]) {
    const stub = new StubClient();
    assert.throws(() => uploadWorkspaceFiles(stub.asClient(), "one", [new File(["safe"], "safe.txt"), new File(["invalid"], name)]), /valid name/);
    assert.equal(stub.calls.length, 0);
  }
});
