// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { proxyDispatcher } from "./dispatcher.js";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

test("proxy dispatcher bypasses direct targets and reuses a dispatcher per proxy URL", () => {
  assert.equal(proxyDispatcher({ mode: "direct" }, "https://example.test"), undefined);
  const first = proxyDispatcher({ mode: "url", url: "http://proxy.example.test:3128" }, "https://example.test");
  const second = proxyDispatcher({ mode: "url", url: "http://proxy.example.test:3128" }, "https://another.test");
  assert.ok(first);
  assert.strictEqual(first, second);
});
