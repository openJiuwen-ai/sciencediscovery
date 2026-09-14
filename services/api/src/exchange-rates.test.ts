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
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { UsageExchangeRateProvider } from "./exchange-rates.js";

const config = {
  enabled: true,
  sourceUrl: "https://api.frankfurter.dev/v2/rate/USD/CNY",
  timeoutMs: 1_000,
  ttlMs: 60_000,
};

function dataDir(name: string): string {
  return resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
}

test("USG-021 exchange rates are fetched, cached and reused while fresh", async () => {
  const dir = dataDir("usage-rates-cache");
  await mkdir(dir, { recursive: true });
  let calls = 0;
  const provider = new UsageExchangeRateProvider({
    config,
    dataDir: dir,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        base: "USD",
        date: "2026-09-08",
        quote: "CNY",
        rate: 6.69,
      }));
    },
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });

  const first = await provider.rates();
  const second = await provider.rates();

  assert.equal(calls, 1);
  assert.equal(first.find((rate) => rate.baseCurrency === "USD" && rate.quoteCurrency === "CNY")?.rate, 6.69);
  assert.equal(first.find((rate) => rate.baseCurrency === "CNY" && rate.quoteCurrency === "USD")?.rate, 1 / 6.69);
  assert.equal(first[0]?.effectiveDate, "2026-09-08");
  assert.equal(first[0]?.provider, "Frankfurter");
  assert.equal(first[0]?.stale, false);
  assert.deepEqual(second, first);
});

test("USG-022 exchange rates fall back to stale cache when refresh fails", async () => {
  const dir = dataDir("usage-rates-stale");
  await mkdir(dir, { recursive: true });
  const warmProvider = new UsageExchangeRateProvider({
    config: { ...config, ttlMs: 1 },
    dataDir: dir,
    fetchImpl: async () => new Response(JSON.stringify({
      base: "USD",
      date: "2026-09-08",
      quote: "CNY",
      rate: 6.69,
    })),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });
  await warmProvider.rates();

  const staleProvider = new UsageExchangeRateProvider({
    config: { ...config, ttlMs: 1 },
    dataDir: dir,
    fetchImpl: async () => {
      throw new Error("network down");
    },
    now: () => new Date("2026-09-08T00:00:01.000Z"),
  });

  const rates = await staleProvider.rates();

  assert.equal(rates.find((rate) => rate.baseCurrency === "USD" && rate.quoteCurrency === "CNY")?.rate, 6.69);
  assert.equal(rates[0]?.stale, true);
});

test("USG-023 exchange rates can be disabled", async () => {
  let called = false;
  const provider = new UsageExchangeRateProvider({
    config: { ...config, enabled: false },
    dataDir: dataDir("usage-rates-disabled"),
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });

  assert.deepEqual(await provider.rates(), []);
  assert.equal(called, false);
});

test("USG-024 exchange rates label custom sources by host", async () => {
  const provider = new UsageExchangeRateProvider({
    config: { ...config, sourceUrl: "https://rates.example.test/usage/usd-cny" },
    dataDir: dataDir("usage-rates-custom-provider"),
    fetchImpl: async () => new Response(JSON.stringify({
      base: "USD",
      date: "2026-09-08",
      quote: "CNY",
      rate: 6.71,
    })),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  });

  const rates = await provider.rates();

  assert.equal(rates[0]?.provider, "rates.example.test");
  assert.equal(rates[1]?.provider, "rates.example.test");
});
