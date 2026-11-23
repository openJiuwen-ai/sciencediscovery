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
 * The one rule every ledger writer follows.
 *
 * `credit_ledger.balance_after` is the ledger's own running total, so the
 * account page can check "previous balance + delta = this balance" on adjacent
 * rows. It is deliberately not `credit_accounts.balance`: that figure has the
 * open holds subtracted from it, and a hold has no ledger row of its own, so
 * recording it here makes two concurrent calls look like the ledger lost and
 * regained the other call's hold (±2.227 in the 0.4.0-rc1 report).
 *
 * A helper rather than three copies: the settle path, the sign-in grant
 * (REGISTER/CHECKIN/BONUS) and the admin adjustment all write rows, and mixing
 * the two definitions is what made the column non-additive in the first place.
 */

import type { Queryable } from "./db.js";

export interface LedgerEntry {
  userId: number;
  delta: number;
  bizType: string;
  bizId: string;
  remark: string;
}

/** The raw row as PostgreSQL returns it; `toLedger` in `store.ts` maps it. */
export interface LedgerInsertRow {
  id: number;
  user_id: number;
  delta: number;
  balance_after: number;
  biz_type: string;
  biz_id: string;
  remark: string | null;
  created_at: Date;
}

/** The running total a new row carries, given the previous row's value. */
export function ledgerAfter(previous: number | undefined, delta: number): number {
  return (previous ?? 0) + delta;
}

/**
 * Appends one row that continues the running total.
 *
 * The caller must already hold the user's `credit_accounts` row
 * (`SELECT … FOR UPDATE`) in the same transaction. That lock is what makes the
 * read below and the insert atomic with respect to the other writers, so the
 * insert order matches the id order the ledger endpoint returns; without it a
 * concurrent `settleCredits` could read an older row, insert a higher id, and
 * leave the page with a pair that is not additive.
 *
 * Returns `undefined` when `(biz_type, biz_id)` already exists, which keeps the
 * callers' "pay once" behaviour.
 */
export async function appendLedger(tx: Queryable, entry: LedgerEntry): Promise<LedgerInsertRow | undefined> {
  const previous = await tx.query<{ balance_after: number }>(
    `SELECT balance_after FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [entry.userId],
  );
  const balanceAfter = ledgerAfter(previous[0]?.balance_after, entry.delta);
  const inserted = await tx.query<LedgerInsertRow>(
    `INSERT INTO credit_ledger (user_id, delta, balance_after, biz_type, biz_id, remark)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (biz_type, biz_id) DO NOTHING
     RETURNING *`,
    [entry.userId, entry.delta, balanceAfter, entry.bizType, entry.bizId, entry.remark],
  );
  return inserted[0];
}
