// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import {
  SESSION_STORAGE_KEY,
  accountSessionToUserSession,
  clearSession,
  parseSession,
  readSession,
  saveSession,
  sessionNeedsRefresh,
  sessionRefreshDelayMs,
  type AccountSession,
  type UserSession,
} from "./index.js";

const NOW = Date.parse("2026-11-21T00:00:00Z");

function session(overrides: Partial<UserSession> = {}): UserSession {
  return {
    userId: 7,
    openId: "openid",
    displayName: "测试用户",
    accessToken: "access",
    refreshToken: "refresh",
    accessExpiresAt: new Date(NOW + 3600_000).toISOString(),
    balanceCredits: 797,
    createdAt: "2026-10-19T00:00:00Z",
    isNewUser: false,
    ...overrides,
  };
}

function accountSession(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    accessToken: "access-2",
    accessExpiresIn: 3600,
    refreshToken: "refresh-2",
    refreshExpiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
    isNewUser: false,
    user: {
      id: 7,
      openid: "openid",
      openidTail: "1234",
      displayName: null,
      avatarUrl: null,
      email: null,
      status: 0,
      createdAt: "2026-10-19T00:00:00Z",
      lastLoginAt: null,
    },
    credit: {
      balance: 797000,
      balanceCredits: 797,
      frozen: 0,
      frozenCredits: 0,
      totalEarned: 900000,
      totalEarnedCredits: 900,
      totalSpent: 103000,
      totalSpentCredits: 103,
      updatedAt: null,
    },
    ...overrides,
  };
}

test("a stored session round-trips, and one without its refresh token is discarded", () => {
  const stored = session();
  assert.deepEqual(parseSession(JSON.stringify(stored)), stored);
  assert.equal(parseSession(JSON.stringify({ ...stored, refreshToken: "" })), undefined);
  assert.equal(parseSession("not json"), undefined);
});

test("a session is refreshed before the access token expires, not after", () => {
  const stored = session();
  assert.equal(sessionNeedsRefresh(stored, NOW), false);
  assert.equal(sessionNeedsRefresh(stored, NOW + 3600_000 - 59_000), true);
  assert.equal(sessionRefreshDelayMs(stored, NOW), 3540_000);
  assert.equal(sessionRefreshDelayMs(stored, NOW + 3600_000), 0);
});

test("a server session keeps the local display name and takes the server's credential", () => {
  const previous = session({ displayName: "本地昵称" });
  const next = accountSessionToUserSession(accountSession(), previous, "默认", NOW);
  assert.equal(next.displayName, "本地昵称");
  assert.equal(next.accessToken, "access-2");
  assert.equal(next.refreshToken, "refresh-2");
  assert.equal(next.accessExpiresAt, new Date(NOW + 3600_000).toISOString());
  assert.equal(next.balanceCredits, 797);
});

test("the desktop shell's storage keeps the refresh token out of localStorage", () => {
  const writes: Array<[string, string]> = [];
  const localWrites: string[] = [];
  const shell = {
    store: new Map<string, string>(),
    getItem(key: string): string | null { return this.store.get(key) ?? null; },
    setItem(key: string, value: string): void { writes.push([key, value]); this.store.set(key, value); },
    removeItem(key: string): void { this.store.delete(key); },
  };
  const globals = globalThis as { sdShell?: unknown; localStorage?: unknown };
  globals.localStorage = {
    getItem: () => null,
    setItem: (_key: string, value: string) => { localWrites.push(value); },
    removeItem: () => {},
  };
  globals.sdShell = { accountSessionStorage: shell };
  try {
    const stored = session();
    saveSession(stored);
    assert.equal(localWrites.length, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]![0], SESSION_STORAGE_KEY);
    assert.deepEqual(readSession(), stored);
    clearSession();
    assert.equal(readSession(), undefined);
  } finally {
    delete globals.sdShell;
    delete globals.localStorage;
  }
});
