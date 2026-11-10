// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { configurationImpactText } from "@sciencediscovery/configuration-ui";
const source = {
  resourceLocation: "Shared proxy registry",
  effectiveScope: "Every session using this proxy",
  message: "Manual confirmation required. Creating a proxy does not select a route. Editing a used proxy affects later connections, possibly within an active run. Existing connections are not rebound. URL syntax is checked without connecting; reachability and proxy authentication remain unverified.",
};
const chinese = {
  resourceLocation: "共享代理注册表",
  effectiveScope: "所有使用此代理的会话",
  message: "需要手动确认。新建代理不会选用该路由。编辑正在使用的代理会影响后续连接，可能包括当前运行中的任务。已有连接不会重新绑定。仅检查 URL 格式，不会发起连接；尚未验证可达性和代理认证。",
};
test("proxy impact localization preserves unknown text, other capabilities and English", () => {
  for (const field of ["resourceLocation", "effectiveScope", "message"] as const) {
    assert.equal(configurationImpactText("zh-CN", "proxy.resources", field, source[field]), chinese[field]);
    assert.equal(configurationImpactText("en", "proxy.resources", field, source[field]), source[field]);
    assert.equal(configurationImpactText("zh-CN", "memory.enable", field, source[field]), source[field]);
    assert.equal(configurationImpactText("zh-CN", "proxy.resources", field, "Unknown warning"), "Unknown warning");
    assert.equal(configurationImpactText("zh-CN", "proxy.resources", field, "toString"), "toString");
  }
  assert.match(chinese.message, /手动确认/);
  assert.match(chinese.message, /当前运行中的任务/);
  assert.match(chinese.message, /不会发起连接/);
  assert.match(chinese.message, /尚未验证可达性和代理认证/);
});
