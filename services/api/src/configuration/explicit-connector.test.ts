// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { explicitConnectorEnableTarget } from "./explicit-connector.js";

const connectors = [{ id: "pubmed", name: "PubMed" }, { id: "uniprot", name: "UniProt" }];

test("CFG explicit connector request resolves only a standalone enable command", () => {
  for (const content of ["帮我打开PubMed工具", "请在当前会话启用 PubMed", "Enable PubMed connector."]) {
    assert.equal(explicitConnectorEnableTarget(content, connectors)?.id, "pubmed", content);
  }
  for (const content of ["不要启用 PubMed", "请使用 PubMed 查论文", "请启用 PubMed 并查论文", "请启用未知连接器"]) {
    assert.equal(explicitConnectorEnableTarget(content, connectors), undefined, content);
  }
});

test("CFG ambiguous connector names do not resolve", () => {
  assert.equal(explicitConnectorEnableTarget("启用 PubMed", [...connectors, { id: "other", name: "PubMed" }]), undefined);
});
