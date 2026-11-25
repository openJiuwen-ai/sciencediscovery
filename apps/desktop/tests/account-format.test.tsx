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
const { afterEach, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { UserSession } from "../src/auth/session.js";
import { setLanguage } from "../src/text.js";
import { EN } from "../src/text/en.js";
import { ZH } from "../src/text/zh.js";
import { AccountPage } from "../src/views/AccountPage.js";
import {
  bizLabel,
  formatAccountCredits,
  formatAccountNumber,
  formatAccountTime,
  formatAccountTokens,
} from "../src/views/account-format.js";

// The language is module state, so leave it where the app starts for the tests
// that run after this file.
afterEach(() => setLanguage("zh-CN"));

/** CJK ideographs: what an English page must never print (#1394). */
const CJK = /[\u3400-\u9fff]/u;

const TOKEN_COUNTS = [
  0, 42, 9_999, 10_000, 15_000, 99_999, 100_000, 240_000,
  1_000_000, 1_500_000, 23_955_640, 999_999_999,
];

test("the ledger business types are translated, and both tables key the same types", () => {
  // The keys the account service sends today; a missing one used to render the
  // raw REGISTER/CHECKIN on the page.
  for (const type of ["REGISTER", "CHECKIN", "BONUS", "LLM_USAGE", "ADMIN", "REFUND"]) {
    assert.ok(type in ZH.account.biz, `zh.ts is missing the label for ${type}`);
    assert.ok(type in EN.account.biz, `en.ts is missing the label for ${type}`);
    assert.ok(!CJK.test(EN.account.biz[type]), `en.ts still has Chinese text for ${type}`);
  }
  assert.equal(bizLabel("REGISTER", ZH), "注册赠送");
  assert.equal(bizLabel("CHECKIN", ZH), "每日签到");
  assert.equal(bizLabel("REGISTER", EN), "Sign-up bonus");
  assert.equal(bizLabel("CHECKIN", EN), "Daily check-in");
  assert.equal(bizLabel("LLM_USAGE", EN), "Model usage");
  // A type this build does not know still says something.
  assert.equal(bizLabel("NEW_TYPE", EN), "NEW_TYPE");
  assert.deepEqual(Object.keys(EN.account.biz).sort(), Object.keys(ZH.account.biz).sort());
});

test("the two account tables keep the same keys", () => {
  // `Text` is `typeof ZH`, so a missing key is normally a compile error; this
  // catches the case where somebody loosens the annotation or removes a key
  // from both tables while a formatter still reads it.
  assert.deepEqual(Object.keys(EN.account).sort(), Object.keys(ZH.account).sort());
});

test("large token counts read as 万 in Chinese and never as 万 in English", () => {
  // Chinese keeps the scale the page shipped with: 1.5万, 2400万.
  assert.equal(formatAccountTokens(9_999, ZH), "9,999");
  assert.equal(formatAccountTokens(15_000, ZH), "1.5万");
  assert.equal(formatAccountTokens(240_000, ZH), "24万");
  assert.equal(formatAccountTokens(23_955_640, ZH), "2396万");

  // English gets the same magnitudes in K/M/B, and no Chinese at all.
  assert.equal(formatAccountTokens(9_999, EN), "9,999");
  assert.equal(formatAccountTokens(15_000, EN), "15K");
  assert.equal(formatAccountTokens(1_500_000, EN), "1.5M");
  assert.equal(formatAccountTokens(23_955_640, EN), "24M");
  assert.equal(formatAccountTokens(2_500_000_000, EN), "2.5B");
  for (const value of TOKEN_COUNTS) {
    const english = formatAccountTokens(value, EN);
    assert.ok(!english.includes("万"), `English printed 万 for ${value}: ${english}`);
    assert.ok(!CJK.test(english), `English printed Chinese for ${value}: ${english}`);
  }
  for (const value of TOKEN_COUNTS.filter((count) => count >= 10_000)) {
    assert.ok(formatAccountTokens(value, ZH).includes("万"), `Chinese lost 万 for ${value}`);
  }
});

test("numbers and credits are formatted from the dictionary's locale, not zh-CN", () => {
  assert.equal(formatAccountNumber(1_234.6, EN), "1,235");
  assert.equal(formatAccountNumber(23_955_640, EN), "23,955,640");
  assert.equal(formatAccountCredits(598.891, EN), "598.891");
  assert.equal(formatAccountCredits(-0.35, EN), "-0.350");
  // A different locale tag proves the locale is read from the table: hardcoded
  // `toLocaleString("zh-CN")` would print the same string for both.
  const german = { ...EN, languageTag: "de-DE" };
  assert.equal(formatAccountNumber(1_234.6, german), "1.235");
  assert.equal(formatAccountCredits(598.891, german), "598,891");
});

test("ledger times follow the language's date order", () => {
  const when = "2026-11-25T06:07:08.000Z";
  // en-US is month first and comma separated; zh-CN is year first.
  assert.match(formatAccountTime(when, EN), /^\d{1,2}\/\d{1,2}\/\d{4}, \d{2}:\d{2}:\d{2}$/u);
  assert.match(formatAccountTime(when, ZH), /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/u);
  assert.match(formatAccountTime(when, { ...EN, languageTag: "de-DE" }), /^\d{1,2}\.\d{1,2}\.\d{4},/u);
  assert.equal(formatAccountTime("not a date", EN), "—");
});

const account: UserSession = {
  accessExpiresAt: "2026-11-20T13:00:00.000Z",
  accessToken: "access",
  balanceCredits: 598.891,
  createdAt: "2026-11-19T12:00:00.000Z",
  displayName: "Ada Chen",
  isNewUser: false,
  openId: "openid",
  refreshToken: "refresh",
  userId: 1,
};

function renderAccount(): string {
  return renderToStaticMarkup(
    <AccountPage account={account} onAccountChange={() => {}} onSignOut={() => {}} />,
  );
}

test("the account page itself prints no Chinese and no 万 in English", () => {
  // 598.891 credits is the report's balance, and the token estimate is
  // balance × 40 000, the figure the page shows in its second metric.
  setLanguage("en");
  const markup = renderAccount();
  assert.ok(markup.includes("24M"), "the English page should read 24M, not 2396万");
  assert.ok(!markup.includes("万"), "the English page still prints 万");
  assert.ok(!CJK.test(markup), "the English page still prints Chinese text");
  assert.ok(markup.includes("Available credits"));
  assert.ok(markup.includes("Credit activity and spending"));
});

test("the account page keeps the Chinese labels and 万 scale in Chinese", () => {
  setLanguage("zh-CN");
  const markup = renderAccount();
  assert.ok(markup.includes("2396万"));
  assert.ok(markup.includes("可用积分"));
  assert.ok(markup.includes("积分流水与消耗明细"));
});
