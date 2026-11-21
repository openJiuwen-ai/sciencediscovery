// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { requiresLocalToken } from "../src/auth/gate.js";
import type { UserSession } from "../src/auth/session.js";
import { TEXT } from "../src/text.js";
import { Rail } from "../src/views/Rail.js";

const session: UserSession = {
  accessExpiresAt: "2026-11-20T13:00:00.000Z",
  accessToken: "access",
  balanceCredits: 598.891,
  createdAt: "2026-11-19T12:00:00.000Z",
  displayName: "赵宇",
  isNewUser: false,
  openId: "openid",
  refreshToken: "refresh",
  userId: 1,
};

test("the workspace requires the local token; the account is one of two ways in", () => {
  assert.equal(requiresLocalToken(""), true);
  assert.equal(requiresLocalToken("   "), true);
  assert.equal(requiresLocalToken("local-token"), false);
});

test("the rail's user button carries the account's initial and opens the account page", () => {
  const markup = renderToStaticMarkup(
    <Rail
      account={session}
      accountOpen
      onOpenAccount={() => {}}
      onOpenSettings={() => {}}
      onSelectTask={() => {}}
      settingsOpen={false}
    />,
  );
  assert.match(markup, /class="rail-item rail-user is-active"/u);
  assert.match(markup, /rail-user-avatar/u);
  assert.ok(markup.includes(TEXT.rail.user));
  assert.ok(markup.includes("赵"));
});

test("with no account the same button reads as a guest", () => {
  const markup = renderToStaticMarkup(
    <Rail
      onOpenAccount={() => {}}
      onOpenSettings={() => {}}
      onSelectTask={() => {}}
      settingsOpen={false}
    />,
  );
  assert.match(markup, /rail-user-avatar is-guest/u);
  assert.ok(markup.includes(TEXT.login.accountTab));
});
