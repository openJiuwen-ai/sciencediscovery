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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ModelUsageExchangeRate } from "@sciencediscovery/schema";

export interface UsageExchangeRateConfig {
  enabled: boolean;
  sourceUrl: string;
  timeoutMs: number;
  ttlMs: number;
}

interface CachedUsageExchangeRates {
  rates: ModelUsageExchangeRate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseUsdCnyRate(payload: unknown): { effectiveDate?: string; rate: number } | undefined {
  if (isRecord(payload)) {
    const rate = parseNumber(payload.rate);
    if (rate && payload.base === "USD" && payload.quote === "CNY") {
      return {
        ...(typeof payload.date === "string" && payload.date ? { effectiveDate: payload.date } : {}),
        rate,
      };
    }
    if (isRecord(payload.rates)) {
      const legacyRate = parseNumber(payload.rates.CNY);
      if (legacyRate && payload.base === "USD") {
        return {
          ...(typeof payload.date === "string" && payload.date ? { effectiveDate: payload.date } : {}),
          rate: legacyRate,
        };
      }
    }
    if (Array.isArray(payload.rates)) {
      const row = payload.rates.find((item) => isRecord(item) && item.base === "USD" && item.quote === "CNY");
      if (isRecord(row)) {
        const arrayRate = parseNumber(row.rate);
        if (arrayRate) {
          return {
            ...(typeof row.date === "string" && row.date ? { effectiveDate: row.date } : {}),
            rate: arrayRate,
          };
        }
      }
    }
  }
  return undefined;
}

function usageExchangeRateProviderName(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
    if (host === "api.frankfurter.dev" || host.endsWith(".frankfurter.dev")) return "Frankfurter";
    return host || "custom";
  } catch {
    return "custom";
  }
}

function markRatesStale(rates: ModelUsageExchangeRate[], stale: boolean): ModelUsageExchangeRate[] {
  return rates.map((rate) => ({ ...rate, stale }));
}

function cacheFresh(rates: ModelUsageExchangeRate[], now: Date, ttlMs: number): boolean {
  const retrievedAt = rates
    .map((rate) => Date.parse(rate.retrievedAt))
    .filter((time) => Number.isFinite(time))
    .toSorted((left, right) => right - left)[0];
  return retrievedAt !== undefined && now.getTime() - retrievedAt <= ttlMs;
}

export class UsageExchangeRateProvider {
  private readonly cachePath: string;
  private readonly config?: UsageExchangeRateConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: {
    config?: UsageExchangeRateConfig;
    dataDir: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    this.cachePath = resolve(options.dataDir, "exchange-rates", "usage-display-rates.json");
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async rates(): Promise<ModelUsageExchangeRate[]> {
    if (!this.config?.enabled) return [];
    const cached = await this.readCache();
    const now = this.now();
    if (cached?.rates.length && cacheFresh(cached.rates, now, this.config.ttlMs)) {
      return markRatesStale(cached.rates, false);
    }
    try {
      return await this.fetchRates(now);
    } catch {
      return cached?.rates.length ? markRatesStale(cached.rates, true) : [];
    }
  }

  private async readCache(): Promise<CachedUsageExchangeRates | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as Partial<CachedUsageExchangeRates>;
      const rates = Array.isArray(parsed.rates)
        ? parsed.rates.filter((rate): rate is ModelUsageExchangeRate =>
            isRecord(rate)
            && (rate.baseCurrency === "USD" || rate.baseCurrency === "CNY")
            && (rate.quoteCurrency === "USD" || rate.quoteCurrency === "CNY")
            && parseNumber(rate.rate) !== undefined
            && typeof rate.provider === "string"
            && typeof rate.retrievedAt === "string")
        : [];
      return { rates };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  private async fetchRates(now: Date): Promise<ModelUsageExchangeRate[]> {
    if (!this.config) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.sourceUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Exchange-rate request failed (${response.status})`);
      const parsed = parseUsdCnyRate(await response.json());
      if (!parsed) throw new Error("Exchange-rate response did not include USD/CNY");
      const retrievedAt = now.toISOString();
      const provider = usageExchangeRateProviderName(this.config.sourceUrl);
      const rates: ModelUsageExchangeRate[] = [
        {
          baseCurrency: "USD",
          ...(parsed.effectiveDate ? { effectiveDate: parsed.effectiveDate } : {}),
          provider,
          quoteCurrency: "CNY",
          rate: parsed.rate,
          retrievedAt,
          sourceUrl: this.config.sourceUrl,
          stale: false,
        },
        {
          baseCurrency: "CNY",
          ...(parsed.effectiveDate ? { effectiveDate: parsed.effectiveDate } : {}),
          provider,
          quoteCurrency: "USD",
          rate: 1 / parsed.rate,
          retrievedAt,
          sourceUrl: this.config.sourceUrl,
          stale: false,
        },
      ];
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, `${JSON.stringify({ rates }, null, 2)}\n`, "utf8");
      return rates;
    } finally {
      clearTimeout(timeout);
    }
  }
}
