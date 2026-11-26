/**
 * E2E-META
 * Purpose: Verify the two-step entry gate, the auto-enter after HUAWEI sign-in,
 *   the centred account page, nickname persistence and the credit summary/ledger
 *   ceiling against a deterministic account-service mock.
 * Steps:
 *   1. Skip step one and prove the model page cannot be skipped and offers
 *      返回上一步; the skip beside 使用华为账号登录 is a same-height button.
 *   2. Return from a HUAWEI callback and prove the workspace opens by itself.
 *   3. Save a nickname once and prove a reload, then a fresh sign-in, reads the
 *      server copy.
 *   4. Measure the account page's centred reading column.
 *   5. Prove available + spent = earned and that the ledger stops at 1000 rows.
 *   6. Prove signing out asks first, and greys the credits model.
 * Environment: Isolated Desktop Vite app with a mocked `/api/**` and a mocked
 *   account service (`**\/v1/**`). No real stack.
 * Type: mocked
 * LLM: none; model behavior is deterministic fixture data.
 * WebSearch: none
 * PaperSources: none
 * MCP: deterministic fixture responses only where the journey requires them.
 * OtherExternal: none
 * Credentials: none
 * CostSideEffects: none
 */
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect, test, type Page } from "@playwright/test";

import { CREATED_AT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/** `SESSION_STORAGE_KEY` in `packages/account-session`. Spelled out because
 *  these specs do not load the app's module graph. */
const SESSION_STORAGE_KEY = "sciencediscovery-session";
const ACCOUNT_TOKEN = "account-access-token";
const ACCOUNT_REFRESH = "account-refresh-token";
const MODEL = {
  id: "model-1",
  model: "deepseek-v4.1-flash-1017",
  name: "华为账号积分",
  providerId: "provider-1",
};

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function storedSession(displayName: string, balanceCredits = 598.891) {
  return {
    userId: 1,
    openId: "openid-1",
    displayName,
    accessToken: ACCOUNT_TOKEN,
    refreshToken: ACCOUNT_REFRESH,
    accessExpiresAt: isoFromNow(60 * 60 * 1000),
    balanceCredits,
    createdAt: CREATED_AT,
    isNewUser: false,
  };
}

interface AccountMockOptions {
  displayName?: string;
  /** Milli-credits, the unit the service reports. */
  balance?: number;
  totalEarned?: number;
  /** How many ledger rows exist; the page reads at most its own ceiling. */
  ledgerRows?: number;
}

function userView(displayName: string) {
  return {
    id: 1,
    openid: "openid-1",
    openidTail: "enid-1",
    displayName,
    avatarUrl: null,
    email: null,
    status: 0,
    createdAt: CREATED_AT,
    lastLoginAt: CREATED_AT,
  };
}

function creditView(balance: number, totalEarned: number) {
  return {
    balance,
    balanceCredits: balance / 1000,
    frozen: 0,
    frozenCredits: 0,
    totalEarned,
    totalEarnedCredits: totalEarned / 1000,
    totalSpent: Math.max(0, totalEarned - balance),
    totalSpentCredits: Math.max(0, totalEarned - balance) / 1000,
    updatedAt: CREATED_AT,
  };
}

/**
 * The account service, answered in the browser. The app reads it through the
 * build-time `VITE_ACCOUNTS_API`, which may be an absolute origin, so the
 * matcher is the `/v1/` path rather than a host.
 */
async function installMockAccount(page: Page, options: AccountMockOptions = {}) {
  const state = {
    displayName: options.displayName ?? "旧昵称",
    balance: options.balance ?? 598_891,
    totalEarned: options.totalEarned ?? 1_000_999,
    ledgerRows: options.ledgerRows ?? 0,
  };
  const ledgerCalls: string[] = [];

  await page.route((url) => url.pathname.includes("/v1/"), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/v1\//u, "/v1/");
    const method = request.method();

    if (path === "/v1/me" && method === "GET") {
      return route.fulfill({
        json: {
          user: userView(state.displayName),
          credit: creditView(state.balance, state.totalEarned),
          checkins: { total: 0, lastDate: null },
          onlineSessions: 1,
          activeSessions: 1,
          currentSessionId: "session-1",
        },
      });
    }

    if (path === "/v1/me" && method === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}") as { displayName?: string };
      if (body.displayName) state.displayName = body.displayName;
      return route.fulfill({ json: { user: userView(state.displayName) } });
    }

    if (path === "/v1/credits/ledger") {
      ledgerCalls.push(url.search);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 100);
      const before = url.searchParams.get("beforeId");
      const start = before === null ? state.ledgerRows : Math.min(Number(before) - 1, state.ledgerRows);
      const items = [];
      for (let id = start; id >= 1 && items.length < limit; id -= 1) {
        const delta = id % 2 === 0 ? -10 : 10;
        items.push({
          id,
          delta,
          deltaCredits: delta / 1000,
          balanceAfter: 1_000_000,
          balanceAfterCredits: 1000,
          bizType: delta < 0 ? "LLM_USAGE" : "CHECKIN",
          bizId: `${id}`,
          remark: null,
          createdAt: CREATED_AT,
        });
      }
      const nextBeforeId = items.length === limit && items[items.length - 1]!.id > 1
        ? items[items.length - 1]!.id
        : null;
      return route.fulfill({ json: { items, nextBeforeId } });
    }

    if (path === "/v1/me/sessions") {
      return route.fulfill({
        json: {
          currentSessionId: "session-1",
          items: [{
            id: "session-1",
            platform: 2,
            platformLabel: "Linux Web",
            deviceLabel: null,
            createdAt: CREATED_AT,
            lastSeenAt: CREATED_AT,
            expiresAt: isoFromNow(60 * 60 * 1000),
            revokedAt: null,
            online: true,
            current: true,
          }],
        },
      });
    }

    if (path === "/v1/me/usage") return route.fulfill({ json: { days: [], records: [] } });

    // The credits provider: `ensureCreditsModel` lists the gateway's models
    // after a sign-in, and creates a provider from the first one.
    if (path === "/v1/models") {
      return route.fulfill({ json: { data: [{ id: MODEL.model }] } });
    }

    if (path === "/v1/auth/ticket") {
      return route.fulfill({
        json: {
          accessToken: ACCOUNT_TOKEN,
          accessExpiresIn: 3600,
          refreshToken: ACCOUNT_REFRESH,
          refreshExpiresAt: isoFromNow(30 * 24 * 60 * 60 * 1000),
          isNewUser: false,
          user: userView(state.displayName),
          credit: creditView(state.balance, state.totalEarned),
        },
      });
    }

    if (path === "/v1/auth/refresh") {
      return route.fulfill({
        json: {
          accessToken: ACCOUNT_TOKEN,
          accessExpiresIn: 3600,
          refreshToken: ACCOUNT_REFRESH,
          refreshExpiresAt: isoFromNow(30 * 24 * 60 * 60 * 1000),
          user: userView(state.displayName),
          credit: creditView(state.balance, state.totalEarned),
        },
      });
    }

    if (path === "/v1/auth/logout") return route.fulfill({ json: { ok: true } });

    return route.fulfill({ status: 404, json: { error: { code: "not_mocked", message: path } } });
  });

  return { state, ledgerCalls };
}

async function seedAccount(page: Page, displayName: string): Promise<void> {
  await page.addInitScript(
    ([tokenKey, sessionKey, token, session]) => {
      localStorage.setItem(tokenKey, token);
      localStorage.setItem(sessionKey, JSON.stringify(session));
    },
    [TOKEN_STORAGE_KEY, SESSION_STORAGE_KEY, TOKEN, storedSession(displayName)] as const,
  );
}

async function openAccount(page: Page): Promise<void> {
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByRole("button", { name: "用户" }).click();
  await expect(page.locator(".account-page")).toBeVisible();
}

test.describe("the two-step entry gate", () => {
  test("step one can be skipped, and step two cannot", async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [TOKEN_STORAGE_KEY, TOKEN] as const,
    );
    await installMockApi(page, { models: [], sessions: [] });
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "账号登录" })).toBeVisible();
    await expect(page.getByText("通过积分免费使用模型", { exact: false })).toBeVisible();
    await expect(page.getByText("服务条款", { exact: false })).toHaveCount(0);

    // The benefit and the redirect notice are one paragraph, with no step
    // number anywhere on the page.
    const instruction = page.locator(".login-lead.is-ink");
    await expect(instruction).toContainText("使用华为账号登录成功后即可获得积分，并通过积分免费使用模型。");
    await expect(instruction).toContainText("点击下方登录按钮，将跳转至华为账号页面完成登录");
    await expect(instruction).toContainText("不会读取或保存华为账号的手机号");
    await expect(page.locator(".login-step-badge")).toHaveCount(0);
    await expect(page.locator(".login-credit-hint")).toHaveCount(0);

    // The skip is a real button beside the HUAWEI button, the same height, with
    // no arrow of its own.
    const huawei = page.locator(".login-huawei-button");
    const skip = page.getByRole("button", { name: "暂不登录，配置自定义模型" });
    await expect(skip).toBeVisible();
    await expect(skip).toHaveText("暂不登录，配置自定义模型");
    const huaweiBox = (await huawei.boundingBox())!;
    const skipBox = (await skip.boundingBox())!;
    expect(Math.abs(huaweiBox.height - skipBox.height)).toBeLessThanOrEqual(1);
    expect(skipBox.x).toBeGreaterThan(huaweiBox.x + huaweiBox.width - 1);
    expect(Math.abs(skipBox.y - huaweiBox.y)).toBeLessThanOrEqual(1);
    const huaweiRadius = await huawei.evaluate((node) => getComputedStyle(node).borderRadius);

    await skip.click();
    await expect(page.getByRole("heading", { name: "自定义模型配置" })).toBeVisible();
    // No step number and no explanatory paragraphs on the model page.
    await expect(page.locator(".login-step-badge")).toHaveCount(0);
    await expect(page.getByText("填写模型服务的接口地址", { exact: false })).toHaveCount(0);
    await expect(page.getByText("此步骤不能跳过", { exact: false })).toHaveCount(0);
    // The second step has no skip.
    await expect(page.getByRole("button", { name: "暂不登录，配置自定义模型" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "自定义模型" })).toHaveCount(0);
    await expect(page.locator(".app-shell")).toHaveCount(0);

    // …but it does lead back to step one, and only step one can be left. The
    // way back sits to the left of the continue button, and both carry the
    // account button's corner radius.
    const back = page.getByRole("button", { name: "返回上一步" });
    const backBox = (await back.boundingBox())!;
    const continueButton = page.getByRole("button", { name: "测试并继续" });
    const continueBox = (await continueButton.boundingBox())!;
    expect(backBox.x).toBeLessThan(continueBox.x);
    const radius = (locator: typeof back) => locator.evaluate((node) => getComputedStyle(node).borderRadius);
    expect(await radius(back)).toBe(huaweiRadius);
    expect(await radius(continueButton)).toBe(huaweiRadius);
    await back.click();
    await expect(page.getByRole("heading", { name: "账号登录" })).toBeVisible();
    await expect(page.locator(".login-step-badge")).toHaveCount(0);
  });

  test("a HUAWEI callback opens the workspace without an enter press", async ({ page }) => {
    const mock = await installMockApi(page, { models: [], sessions: [makeSession()] });
    // The loopback credential is issued after the ticket is exchanged; the real
    // service verifies the account token, the mock hands the machine token over.
    await page.route("**/api/bootstrap/local-token", (route) => route.fulfill({ json: { token: TOKEN } }));
    const account = await installMockAccount(page, { displayName: "研究者" });

    await page.goto("/#auth-ticket=single-use-ticket");

    // No 进入工作台 step: the shell appears as the callback settles.
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: "进入工作台" })).toHaveCount(0);
    expect(account.state.displayName).toBe("研究者");
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), TOKEN_STORAGE_KEY))
      .toBe(TOKEN);

    // A build that *does* name an account service registers the credits-backed
    // provider from that gateway's model list, which is what lets a signed-in
    // user chat without any model setup (#1430). The provider's base URL is the
    // pinned account service (`…/accounts/v1`), not this page's own origin.
    await expect.poll(() => mock.state.providers.length).toBe(1);
    const provider = mock.state.providers[0] as { baseUrl?: unknown; name?: unknown };
    expect(provider.name).toBe("华为账号积分");
    expect(new URL(String(provider.baseUrl)).pathname).toBe("/accounts/v1");
  });
});

test.describe("the account page", () => {
  test("one save writes the nickname, and a reload reads the server copy", async ({ page }) => {
    await seedAccount(page, "旧昵称");
    await installMockApi(page, { models: [MODEL], sessions: [makeSession()] });
    const account = await installMockAccount(page, { displayName: "旧昵称" });
    const patches: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH" && request.url().includes("/v1/me")) patches.push(request.url());
    });

    await page.goto("/");
    await openAccount(page);
    await expect(page.locator(".account-hero h1")).toHaveText("旧昵称");

    await page.getByRole("button", { name: "编辑昵称" }).click();
    await page.locator(".account-name-input").fill("新昵称");
    await page.locator(".account-name-editor").getByRole("button", { name: "保存", exact: true }).click();

    await expect(page.locator(".account-hero h1")).toHaveText("新昵称");
    await expect(page.locator(".account-notice")).toContainText("昵称已保存");
    expect(patches).toHaveLength(1);
    expect(account.state.displayName).toBe("新昵称");

    // Put the old name back in local storage only: the page has to take the
    // saved name from the account service, not from its cached record.
    await page.evaluate(([key]) => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const session = JSON.parse(raw) as Record<string, unknown>;
      session.displayName = "旧昵称";
      localStorage.setItem(key, JSON.stringify(session));
    }, [SESSION_STORAGE_KEY] as const);
    await page.reload();
    await openAccount(page);
    await expect(page.locator(".account-hero h1")).toHaveText("新昵称");

    // Sign out, then sign in again: the name the workspace opens with is the
    // one the account service kept, not the stale copy a fresh page seeds from
    // local storage.
    await page.locator(".account-signout").click();
    await page.locator(".modal-panel").getByRole("button", { name: "退出登录" }).click();
    await expect(page.locator(".account-signedout")).toBeVisible();
    await page.route("**/api/bootstrap/local-token", (route) => route.fulfill({ json: { token: TOKEN } }));
    // `?account=1` is the address the account panel's own sign-in button
    // returns to, so the panel — not the entry page — settles this callback.
    await page.goto("/?account=1#auth-ticket=relogin-ticket");
    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".account-hero h1")).toHaveText("新昵称");
  });

  test("signing out asks first, and the credits model turns unavailable", async ({ page }) => {
    await seedAccount(page, "研究者");
    await installMockApi(page, { models: [MODEL], sessions: [makeSession()] });
    await installMockAccount(page, { displayName: "研究者" });
    // The workspace opens the session, so every catalog refresh also reads its
    // runtime settings; the shared fixture does not model that route.
    await page.route(
      (url) => /^\/api\/sessions\/[^/]+\/settings$/u.test(url.pathname),
      (route) => route.fulfill({ json: { effective: {}, overrides: {}, sources: {} } }),
    );

    await page.goto("/");
    await openAccount(page);

    // The first press only asks: cancelling keeps the account and the session.
    await page.locator(".account-signout").click();
    const dialog = page.locator(".modal-panel");
    await expect(dialog.getByRole("heading", { name: "确认退出华为账号" })).toBeVisible();
    // No context chip, a warning triangle before the consequence, and two
    // answers of the same size.
    await expect(dialog.locator(".modal-eyebrow")).toHaveCount(0);
    await expect(dialog.locator(".modal-body-warning svg")).toBeVisible();
    const cancelBox = (await dialog.locator(".modal-footer .secondary-button").boundingBox())!;
    const acceptBox = (await dialog.locator(".modal-footer .primary-button").boundingBox())!;
    expect(Math.abs(cancelBox.width - acceptBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(cancelBox.height - acceptBox.height)).toBeLessThanOrEqual(1);
    await dialog.locator(".modal-footer").getByRole("button", { name: "取消" }).click();
    await expect(page.locator(".account-page")).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_STORAGE_KEY)).not.toBeNull();

    await page.locator(".account-signout").click();
    await page.locator(".modal-panel").getByRole("button", { name: "退出登录" }).click();
    await expect(page.locator(".account-signedout")).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_STORAGE_KEY)).toBeNull();

    // The credits model stays on the list so its disappearance is not a
    // mystery, but it is greyed and has no actions while signed out.
    await page.locator(".account-back").click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置" });
    await settings.getByRole("button", { name: "模型", exact: true }).click();
    const row = settings.locator(".model-row", { hasText: "华为账号积分" });
    await expect(row).toHaveClass(/is-unavailable/);
    await expect(row.locator(".settings-tag", { hasText: "登录后可用" })).toBeVisible();
    await expect(row.getByRole("button", { name: "测试连接" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "设为主模型" })).toHaveCount(0);
  });

  test("the content is a centred reading column, not the full window", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await seedAccount(page, "研究者");
    await installMockApi(page, { models: [MODEL], sessions: [makeSession()] });
    await installMockAccount(page);

    await page.goto("/");
    await openAccount(page);

    const hero = await page.locator(".account-hero").boundingBox();
    expect(hero).not.toBeNull();
    const left = hero!.x;
    const right = 1600 - (hero!.x + hero!.width);
    // The reading column is at most 1120px, so a 1600px window leaves a wide
    // gap on both sides instead of stretching the cards to the edge.
    expect(hero!.width).toBeLessThanOrEqual(1130);
    expect(left).toBeGreaterThan(150);
    expect(right).toBeGreaterThan(150);
  });

  test("available + spent = earned", async ({ page }) => {
    await seedAccount(page, "研究者", 598.891);
    await installMockApi(page, { models: [MODEL], sessions: [makeSession()] });
    // A fractional balance and a longer spent history, as reported on 11/20.
    await installMockAccount(page, { balance: 598_891, totalEarned: 1_000_999 });

    await page.goto("/");
    await openAccount(page);

    const metric = (label: string) => page.locator(".account-metric", { hasText: label }).locator("strong");
    const available = Number((await metric("可用积分").textContent())?.replace(/,/gu, ""));
    const earned = Number((await metric("累计获得").textContent())?.replace(/,/gu, ""));
    const spent = Number((await metric("累计消耗").textContent())?.replace(/,/gu, ""));

    expect(available).toBeCloseTo(598.891, 3);
    expect(earned).toBeCloseTo(1000.999, 3);
    expect(available + spent).toBeCloseTo(earned, 3);
    // The tolerance the product allows: at most one tenth of a credit.
    expect(Math.abs(available + spent - earned)).toBeLessThanOrEqual(0.1);
  });

  test("the ledger stops at the 1000-row ceiling", async ({ page }) => {
    await seedAccount(page, "研究者");
    await installMockApi(page, { models: [MODEL], sessions: [makeSession()] });
    const account = await installMockAccount(page, { ledgerRows: 1500 });

    await page.goto("/");
    await openAccount(page);

    await page.locator(".account-page-size select").selectOption("100");
    const next = page.getByRole("button", { name: "下一页" });
    const hint = page.getByText("仅显示最近 1000 条流水", { exact: false });
    // The hint appears as the tenth chunk lands; one more press walks to the
    // last page, where 下一页 is disabled because the ceiling is also the end.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (await next.isDisabled()) break;
      await next.click();
      await page.waitForTimeout(30);
    }

    await expect(hint).toBeVisible();
    // load() + nine cursor reads; the eleventh page is never requested.
    expect(account.ledgerCalls.length).toBeLessThanOrEqual(10);
    await expect(next).toBeDisabled();
  });
});
