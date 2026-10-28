// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { configurationDiscoveryMatches } from "./discovery-match.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const connector = "connector source pubmed arxiv literature paper papers 数据源 连接器 启用 检索 文献 论文";
const connect = "model api connect provider 模型 接入 添加 接口 服务商";
const runner = "id runnerName description alias token username password";

test("CFG-Q02: Chinese task words and joined resource names match at a boundary", () => {
  assert.equal(configurationDiscoveryMatches("找几篇论文", connector), true);
  assert.equal(configurationDiscoveryMatches("启用pubmed", "pubmed PubMed"), true);
  assert.equal(configurationDiscoveryMatches("请启用 PubMed", "pubmed PubMed"), true);
  assert.equal(configurationDiscoveryMatches("rapid literature search", connector), true);
  assert.equal(configurationDiscoveryMatches("proxy", "proxy 代理 defaultPolicy"), true);
});

test("CFG-Q02: short catalog words do not match inside longer ASCII identifiers", () => {
  assert.equal(configurationDiscoveryMatches("validate the rapid citation", connect), false);
  assert.equal(configurationDiscoveryMatches("validate the rapid citation", runner), false);
  assert.equal(configurationDiscoveryMatches("session_id", runner), false);
  assert.equal(configurationDiscoveryMatches("wallpaper newspaper", connector), false);
  assert.equal(configurationDiscoveryMatches("runner id", runner), true);
});
