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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { AccountApiError, accountSessionToUserSession, exchangeTicket, refreshAccountSession } from "../src/auth/account.js";
import { readAuthTicket, readAuthorizeFailure } from "../src/auth/huawei.js";
import { parseSession, SESSION_STORAGE_KEY, sessionNeedsRefresh, sessionRefreshDelayMs, type UserSession } from "../src/auth/session.js";
import { ensureFreshAccountSession } from "../src/auth/session-refresh.js";

const ACCOUNT = {
  accessToken: "access-1",
  accessExpiresIn: 900,
  refreshToken: "refresh-1",
  refreshExpiresAt: "2026-12-10T00:00:00.000Z",
  user: {
    id: 7,
    openid: "openid-7",
    openidTail: "enid-7",
    displayName: "Lin",
    avatarUrl: null,
    email: null,
    status: 0,
    createdAt: "2026-11-10T00:00:00.000Z",
    lastLoginAt: "2026-11-10T00:00:00.000Z",
  },
  credit: {
    balance: 500_000,
    balanceCredits: 500,
    frozen: 0,
    frozenCredits: 0,
    totalEarned: 500_000,
    totalEarnedCredits: 500,
    totalSpent: 0,
    totalSpentCredits: 0,
    updatedAt: "2026-11-10T00:00:00.000Z",
  },
};

const SESSION: UserSession = {
  userId: 7,
  openId: "openid-7",
  displayName: "Lin",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  accessExpiresAt: "2026-11-10T00:15:00.000Z",
  balanceCredits: 500,
  createdAt: "2026-11-10T00:00:00.000Z",
  isNewUser: true,
};

function stubFetch(respond: (url: string, init: RequestInit) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    respond(String(input), init ?? {})) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("a stored session survives a round trip and the credential-free local record is discarded", () => {
  assert.deepEqual(parseSession(JSON.stringify(SESSION)), SESSION);
  // The pre-account-service record had no tokens, so it must not be trusted.
  const legacy = { openId: "preview-1", displayName: "Preview", grantedCredits: 500, createdAt: SESSION.createdAt };
  assert.equal(parseSession(JSON.stringify(legacy)), undefined);
  assert.equal(parseSession(JSON.stringify({ ...SESSION, accessToken: "" })), undefined);
  assert.equal(parseSession(JSON.stringify({ ...SESSION, balanceCredits: "500" })), undefined);
  assert.equal(parseSession("not json"), undefined);
});

test("a session is refreshed before the access token expires, not after", () => {
  const expires = Date.parse(SESSION.accessExpiresAt);
  assert.equal(sessionNeedsRefresh(SESSION, expires - 120_000), false);
  assert.equal(sessionNeedsRefresh(SESSION, expires - 60_000), true);
  assert.equal(sessionNeedsRefresh(SESSION, expires + 1), true);
  assert.equal(sessionNeedsRefresh({ ...SESSION, accessExpiresAt: "garbage" }), true);
  assert.equal(sessionRefreshDelayMs(SESSION, expires - 180_000), 120_000);
  assert.equal(sessionRefreshDelayMs(SESSION, expires), 0);
});

test("a server session becomes the stored record without losing the local display name", () => {
  const previous = { ...SESSION, displayName: "本地昵称" };
  const stored = accountSessionToUserSession({ ...ACCOUNT, isNewUser: true }, previous, "默认昵称", Date.parse(SESSION.accessExpiresAt) - 900_000);
  assert.equal(stored.accessToken, "access-1");
  assert.equal(stored.refreshToken, "refresh-1");
  assert.equal(stored.displayName, "Lin");
  assert.equal(stored.accessExpiresAt, SESSION.accessExpiresAt);
  assert.equal(stored.isNewUser, true);

  const anonymous = accountSessionToUserSession(
    { ...ACCOUNT, user: { ...ACCOUNT.user, displayName: null }, isNewUser: false },
    previous,
    "默认昵称",
    Date.parse(SESSION.accessExpiresAt) - 900_000,
  );
  assert.equal(anonymous.displayName, "本地昵称");
});

test("a background refresh persists the rotated access token", async () => {
  const storage = new Map<string, string>([[SESSION_STORAGE_KEY, JSON.stringify(SESSION)]]);
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  globalThis.fetch = (async () => new Response(JSON.stringify({ ...ACCOUNT, accessToken: "access-2", refreshToken: "refresh-2", isNewUser: false }), { status: 200 })) as typeof fetch;
  try {
    const next = await ensureFreshAccountSession();
    assert.equal(next?.accessToken, "access-2");
    assert.equal(JSON.parse(storage.get(SESSION_STORAGE_KEY)! as string).accessToken, "access-2");
  } finally {
    if (originalLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
    if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    globalThis.fetch = originalFetch;
  }
});

test("the callback carries a single-use ticket", () => {
  assert.deepEqual(readAuthTicket("#auth-ticket=t-1&state=s-1"), { ticket: "t-1" });
  assert.deepEqual(readAuthTicket("#state=s-1&auth-ticket=t-1"), { ticket: "t-1" });
  assert.equal(readAuthTicket("#auth=eyJvcGVuSWQiOiJ4In0"), undefined);
  assert.equal(readAuthTicket(""), undefined);
  assert.equal(readAuthorizeFailure("#error=access_denied"), true);
  assert.equal(readAuthorizeFailure("#auth-ticket=t-1"), false);
});

test("ticket exchange posts the device and treats only an explicit flag as a new account", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(ACCOUNT), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const session = await exchangeTicket("t-1", { platform: 2, deviceLabel: "Linux Web", deviceId: "device-1" });
    assert.equal(session.isNewUser, false);
    assert.equal(session.credit.balanceCredits, 500);
    assert.deepEqual(calls, [{
      url: "/v1/auth/ticket",
      body: { ticket: "t-1", platform: 2, deviceLabel: "Linux Web", deviceId: "device-1" },
    }]);
  } finally {
    restore();
  }
});

test("refresh never claims a new account and a refusal surfaces as a denied error", async () => {
  let restore = stubFetch(() => new Response(JSON.stringify(ACCOUNT), { status: 200 }));
  try {
    assert.equal((await refreshAccountSession("refresh-1")).isNewUser, false);
  } finally {
    restore();
  }

  restore = stubFetch(() => new Response(JSON.stringify({ error: { code: "session_revoked", message: "session ended" } }), { status: 401 }));
  try {
    await assert.rejects(refreshAccountSession("refresh-1"), (error: unknown) => {
      assert.ok(error instanceof AccountApiError);
      assert.equal(error.denied, true);
      assert.equal(error.code, "session_revoked");
      assert.equal(error.message, "session ended");
      return true;
    });
  } finally {
    restore();
  }
});

test("an unreachable service is reported without a status", async () => {
  const restore = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    await assert.rejects(refreshAccountSession("refresh-1"), (error: unknown) => {
      assert.ok(error instanceof AccountApiError);
      assert.equal(error.status, 0);
      assert.equal(error.denied, false);
      return true;
    });
  } finally {
    restore();
  }
});

test("the session key is stable so an upgrade never resurrects a second copy", () => {
  assert.equal(SESSION_STORAGE_KEY, "sciencediscovery-session");
});
