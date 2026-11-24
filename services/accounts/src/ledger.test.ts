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

/**
 * The ledger's running-total rule, against the production SQL.
 *
 * `app.test.ts` drives `MemoryStore`, so it can pass while the SQL in
 * `store.ts` is wrong. These cases run the real statements through a fake
 * `Queryable`: reverting `appendLedger` to the spendable balance, or
 * `adjustCredits` to an absolute `balance`, fails here.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";

import type { Queryable } from "./db.js";
import { appendLedger, ledgerAfter, LEDGER_MAX_ROWS_PER_KIND } from "./ledger.js";
import { PostgresStore } from "./store.js";

type Row = Record<string, unknown>;

interface Call {
  sql: string;
  values: unknown[];
}

/** A `Queryable` that answers from `handlers` in call order and records every
 *  statement, so a test can assert on the SQL the store actually ran. */
function fakeQueryable(answer: (sql: string, values: unknown[]) => Row[]): { queryable: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const queryable = {
    async query(sql: string, values: unknown[] = []): Promise<Row[]> {
      calls.push({ sql, values });
      return answer(sql, values);
    },
  } as unknown as Queryable;
  return { queryable, calls };
}

function has(sql: string, ...fragments: string[]): boolean {
  return fragments.every((fragment) => sql.includes(fragment));
}

test("a row continues the previous row's balance instead of resetting to the delta", async () => {
  assert.equal(ledgerAfter(700_000, -35_000), 665_000);
  assert.equal(ledgerAfter(undefined, 500_000), 500_000);

  const { queryable, calls } = fakeQueryable((sql) => {
    if (has(sql, "SELECT balance_after FROM credit_ledger")) return [{ balance_after: 700_000 }];
    if (has(sql, "INSERT INTO credit_ledger")) return [{ id: 9, user_id: 1, delta: -35_000, balance_after: 665_000, biz_type: "LLM_USAGE", biz_id: "r-1", remark: "m", created_at: new Date() }];
    return [];
  });

  const row = await appendLedger(queryable, { userId: 1, delta: -35_000, bizType: "LLM_USAGE", bizId: "r-1", remark: "m" });
  assert.equal(row?.balance_after, 665_000);

  const insert = calls.find((call) => has(call.sql, "INSERT INTO credit_ledger"));
  assert.ok(insert, "the insert ran");
  assert.equal(insert.values[2], 665_000, "balance_after is the running total");
});

test("the first row of a ledger starts from its own delta", async () => {
  const { queryable } = fakeQueryable((sql) => {
    if (has(sql, "SELECT balance_after FROM credit_ledger")) return [];
    if (has(sql, "INSERT INTO credit_ledger")) return [{ id: 1, user_id: 1, delta: 500_000, balance_after: 500_000, biz_type: "REGISTER", biz_id: "1", remark: "注册赠送", created_at: new Date() }];
    return [];
  });

  const row = await appendLedger(queryable, { userId: 1, delta: 500_000, bizType: "REGISTER", bizId: "1", remark: "注册赠送" });
  assert.equal(row?.balance_after, 500_000);
});

test("a repeated (biz_type, biz_id) writes nothing and reports no row", async () => {
  const { queryable } = fakeQueryable((sql) => {
    if (has(sql, "SELECT balance_after FROM credit_ledger")) return [{ balance_after: 700_000 }];
    return [];
  });

  const row = await appendLedger(queryable, { userId: 1, delta: 100_000, bizType: "CHECKIN", bizId: "1:2026-03-01", remark: "每日签到 · 2026-03-01" });
  assert.equal(row, undefined);
});

test("a written row prunes both kinds past the per-user ceiling", async () => {
  const { queryable, calls } = fakeQueryable((sql) => {
    if (has(sql, "SELECT balance_after FROM credit_ledger")) return [{ balance_after: 700_000 }];
    if (has(sql, "INSERT INTO credit_ledger")) return [{ id: 2000, user_id: 1, delta: -1, balance_after: 699_999, biz_type: "LLM_USAGE", biz_id: "r-2", remark: "m", created_at: new Date() }];
    return [];
  });

  await appendLedger(queryable, { userId: 1, delta: -1, bizType: "LLM_USAGE", bizId: "r-2", remark: "m" });

  const deletes = calls.filter((call) => has(call.sql, "DELETE FROM credit_ledger"));
  assert.equal(deletes.length, 2, "spent and earned rows are capped independently");
  for (const call of deletes) {
    assert.equal(call.values[1], LEDGER_MAX_ROWS_PER_KIND);
    assert.match(call.sql, /ORDER BY id DESC OFFSET \$2 LIMIT 1/u);
  }
  assert.ok(deletes.some((call) => has(call.sql, "delta < 0")), "the spent history is capped");
  assert.ok(deletes.some((call) => has(call.sql, "delta >= 0")), "the earned history is capped, zero deltas included");
});

test("an admin adjustment records the running total, not the spendable balance", async () => {
  const ledgerRow: Row = {
    id: 12, user_id: 1, delta: 41_000, balance_after: 741_000,
    biz_type: "ADMIN", biz_id: "admin-1", remark: "补偿", created_at: new Date("2026-03-01T08:00:00.000Z"),
  };
  const { queryable, calls } = fakeQueryable((sql) => {
    // A hold of 41 is open: 700 earned, 659 spendable.
    if (has(sql, "SELECT balance FROM credit_accounts", "FOR UPDATE")) return [{ balance: 659_000 }];
    if (has(sql, "SELECT balance_after FROM credit_ledger")) return [{ balance_after: 700_000 }];
    if (has(sql, "INSERT INTO credit_ledger")) return [ledgerRow];
    return [];
  });

  const db = {
    query: queryable.query.bind(queryable),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => work(queryable),
  };
  const store = new PostgresStore(db);

  const result = await store.adjustCredits({ userId: 1, deltaMilli: 41_000, remark: "补偿", adminId: 1 });
  assert.ok(result, "the adjustment was accepted");
  assert.equal(result.ledger.balanceAfter, 741_000, "the ledger row continues the ledger");
  assert.equal(result.balance, 700_000, "the spendable balance is what the caller sees");

  const accountUpdate = calls.find((call) => has(call.sql, "UPDATE credit_accounts"));
  assert.ok(accountUpdate, "the account row was updated");
  assert.equal(accountUpdate.values[1], 41_000, "balance moves by the delta, not to an absolute value");
  assert.ok(!accountUpdate.sql.includes("balance = $2"), "balance is never set to the ledger total");
});

test("sign-in keeps a saved nickname instead of overwriting it with the HUAWEI profile", async () => {
  const userRaw: Row = {
    id: 1, openid: "openid-1", display_name: "研究者", avatar_url: null, email: null,
    status: 0, created_at: new Date("2026-03-01T08:00:00.000Z"), last_login_at: null,
  };
  const creditRaw: Row = {
    user_id: 1, balance: 0, frozen: 0, total_earned: 0, total_spent: 0,
    updated_at: new Date("2026-03-01T08:00:00.000Z"),
  };
  const { queryable, calls } = fakeQueryable((sql) => {
    if (has(sql, "FROM users WHERE openid")) return [userRaw];
    if (has(sql, "FROM users WHERE id = $1")) return [userRaw];
    if (has(sql, "FROM credit_accounts WHERE user_id = $1")) return [creditRaw];
    return [];
  });
  const db = {
    query: queryable.query.bind(queryable),
    transaction: async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => work(queryable),
  };
  const store = new PostgresStore(db);

  const result = await store.signIn({ openid: "openid-1", displayName: "HUAWEI 昵称", grantMilliCredits: 500_000 });
  assert.equal(result.user.displayName, "研究者", "the saved name is what the session carries");

  const nameUpdate = calls.find((call) => has(call.sql, "UPDATE users", "display_name"));
  assert.ok(nameUpdate, "sign-in updates the profile fields it owns");
  // The saved name wins: HUAWEI only fills the column while it is empty.
  assert.match(nameUpdate.sql, /display_name\s*=\s*COALESCE\(display_name, \$2\)/u);
});
