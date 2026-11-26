// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TEXT } from "../src/text.js";
import { EN } from "../src/text/en.js";
import { ZH } from "../src/text/zh.js";
import { SignedOutAccount } from "../src/views/AccountPage.js";
import { LoginPage } from "../src/views/LoginPage.js";

/**
 * `node:test` has no `import.meta.env`, which is exactly the state of a desktop
 * bundle whose `VITE_ACCOUNTS_API` resolved to an empty value. Both sign-in
 * entries must then say the account service is missing instead of navigating:
 * the local API answers `/v1/auth/huawei/start` with `index.html`, so the
 * navigation silently reloads the workspace (#1430).
 *
 * The sentence is shared by two different pages — the entry page that also
 * offers a custom model, and the token gate that has no such route — so it may
 * only name the one action available on both.
 */
test("the sign-in entry reports the missing account service instead of navigating", () => {
  const markup = renderToStaticMarkup(<LoginPage onAuthenticated={() => {}} offerModelSetup />);

  assert.ok(markup.includes(TEXT.login.accountServiceMissing));
  assert.match(markup, /class="login-huawei-button login-entry-primary" disabled=""/);
  // The custom-model route is the entry page's own button, not something the
  // shared notice may promise: the token gate renders this page without it.
  assert.ok(markup.includes(TEXT.login.skipToModel));
  assert.doesNotMatch(EN.login.accountServiceMissing, /custom model/iu);
  assert.doesNotMatch(ZH.login.accountServiceMissing, /自定义模型/u);
});

test("the token gate shows the same notice where no custom-model route exists", () => {
  const markup = renderToStaticMarkup(<LoginPage onAuthenticated={() => {}} />);

  assert.ok(markup.includes(TEXT.login.accountServiceMissing));
  assert.ok(!markup.includes(TEXT.login.skipToModel));
});

test("the account panel shows the notice where its sign-in button would be", () => {
  const markup = renderToStaticMarkup(<SignedOutAccount />);

  assert.ok(markup.includes(TEXT.login.accountServiceMissing));
  assert.ok(!markup.includes(TEXT.login.huaweiButton));
});
