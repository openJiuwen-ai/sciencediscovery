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
 * Curated metadata for well-known models. Every number was copied from the
 * official vendor page in `source`/`pricing.source` on the recorded date;
 * absent fields mean the vendor does not publish the fact, never a guess.
 *
 * Precedence when the UI assembles a model's fact sheet:
 *   live listing endpoint facts (`RemoteModelFacts`) > this catalog > unknown.
 * Pricing is provider-scoped — a rehosted model (e.g. DeepSeek on
 * SiliconFlow) never inherits the original vendor's prices.
 */

import type {
  ModelCatalogEntry,
  ModelCatalogPricing,
  ModelCatalogThinking,
  ModelProviderPresetId,
} from "./model-provider.js";
import type { ModelThinkingEffort, ModelThinkingMode } from "./model-usage.js";

export interface ModelCatalogRecord {
  /** Additional normalized ids that resolve to this record. */
  aliases?: readonly string[];
  /** Model-specific wire dialect required by the official endpoint. */
  apiVariant?: ModelCatalogEntry["apiVariant"];
  contextWindow?: number;
  /** Normalized primary id: lower-case, no vendor path prefix. */
  key: string;
  label: string;
  maxOutputTokens?: number;
  pricing?: Readonly<Partial<Record<ModelProviderPresetId, ModelCatalogPricing>>>;
  source: { retrievedAt: string; url: string };
  thinking?: ModelCatalogThinking;
  vision?: boolean;
}

const RETRIEVED = "2026-08-23";

const src = (url: string) => ({ retrievedAt: RETRIEVED, url });

const THINKING_TOGGLE: ModelCatalogThinking = {
  modes: ["auto", "enabled", "disabled"],
  supported: true,
};
const THINKING_HIGH_MAX: ModelCatalogThinking = {
  efforts: ["high", "max"],
  modes: ["auto", "enabled", "disabled"],
  supported: true,
};
const THINKING_ANTHROPIC_EFFORTS: ModelCatalogThinking = {
  efforts: ["low", "medium", "high", "max"],
  modes: ["auto", "enabled", "disabled"],
  supported: true,
};
const THINKING_OPENAI_55: ModelCatalogThinking = {
  efforts: ["low", "medium", "high", "xhigh"],
  modes: ["auto", "enabled", "disabled"],
  supported: true,
};
const THINKING_OPENAI_56: ModelCatalogThinking = {
  efforts: ["low", "medium", "high", "xhigh", "max"],
  modes: ["auto", "enabled", "disabled"],
  supported: true,
};

export const MODEL_CATALOG: readonly ModelCatalogRecord[] = [
  // ---- DeepSeek (api-docs.deepseek.com) ----
  {
    contextWindow: 1_000_000,
    key: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    maxOutputTokens: 384_000,
    pricing: {
      deepseek: {
        cachedInput: 0.1,
        currency: "CNY",
        input: 3,
        output: 9,
        periods: [
          {
            cachedInput: 0.1,
            id: "peak",
            input: 3,
            output: 9,
            schedule: {
              intervals: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
              kind: "weekdays",
              timeZone: "Asia/Shanghai",
            },
          },
          {
            cachedInput: 0.05,
            id: "off-peak",
            input: 1.5,
            output: 4.5,
            schedule: { kind: "remainder", timeZone: "Asia/Shanghai" },
          },
        ],
        source: src("https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"),
        unit: "per-1m-tokens",
      },
      siliconflow: {
        currency: "CNY",
        input: 1,
        output: 2,
        source: src("https://siliconflow.cn/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://api-docs.deepseek.com/zh-cn/quick_start/pricing"),
    thinking: THINKING_HIGH_MAX,
    vision: false,
  },
  {
    contextWindow: 1_000_000,
    key: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    maxOutputTokens: 384_000,
    pricing: {
      deepseek: {
        cachedInput: 0.3,
        currency: "CNY",
        input: 9,
        output: 27,
        periods: [
          {
            cachedInput: 0.3,
            id: "peak",
            input: 9,
            output: 27,
            schedule: {
              intervals: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
              kind: "weekdays",
              timeZone: "Asia/Shanghai",
            },
          },
          {
            cachedInput: 0.15,
            id: "off-peak",
            input: 4.5,
            output: 13.5,
            schedule: { kind: "remainder", timeZone: "Asia/Shanghai" },
          },
        ],
        source: src("https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://api-docs.deepseek.com/zh-cn/quick_start/pricing"),
    thinking: THINKING_HIGH_MAX,
    vision: false,
  },

  // ---- Moonshot Kimi (platform.kimi.com) ----
  {
    apiVariant: "kimi-k3",
    contextWindow: 1_048_576,
    key: "kimi-k3",
    label: "Kimi K3",
    pricing: {
      moonshot: {
        cachedInput: 2,
        currency: "CNY",
        input: 20,
        output: 100,
        source: src("https://platform.kimi.com/docs/pricing/chat-k3.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.kimi.com/docs/models.md"),
    thinking: {
      defaultEffort: "max",
      defaultMode: "enabled",
      efforts: ["low", "high", "max"],
      modes: ["enabled"],
      supported: true,
    },
    vision: true,
  },
  {
    contextWindow: 262_144,
    key: "kimi-k2.6",
    label: "Kimi K2.6",
    pricing: {
      moonshot: {
        cachedInput: 1.1,
        currency: "CNY",
        input: 6.5,
        output: 27,
        source: src("https://platform.kimi.com/docs/pricing/chat-k26.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.kimi.com/docs/models.md"),
    thinking: THINKING_TOGGLE,
    vision: true,
  },
  {
    contextWindow: 262_144,
    key: "kimi-k2.5",
    label: "Kimi K2.5",
    pricing: {
      moonshot: {
        cachedInput: 0.7,
        currency: "CNY",
        input: 4,
        output: 21,
        source: src("https://platform.kimi.com/docs/pricing/chat-k25.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.kimi.com/docs/models.md"),
    thinking: THINKING_TOGGLE,
    vision: true,
  },

  // ---- Zhipu GLM (docs.bigmodel.cn; USD prices from docs.z.ai) ----
  {
    contextWindow: 1_000_000,
    key: "glm-5.2",
    label: "GLM-5.2",
    maxOutputTokens: 128_000,
    pricing: {
      zhipu: {
        cachedInput: 0.26,
        currency: "USD",
        input: 1.4,
        notes: "国际站美元价；人民币价见 bigmodel.cn 定价页",
        output: 4.4,
        source: src("https://docs.z.ai/guides/overview/pricing"),
        unit: "per-1m-tokens",
      },
      siliconflow: {
        currency: "CNY",
        input: 8,
        output: 28,
        source: src("https://siliconflow.cn/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://docs.bigmodel.cn/cn/guide/start/model-overview"),
    thinking: THINKING_TOGGLE,
    vision: false,
  },
  {
    contextWindow: 200_000,
    key: "glm-4.7",
    label: "GLM-4.7",
    maxOutputTokens: 128_000,
    pricing: {
      zhipu: {
        cachedInput: 0.11,
        currency: "USD",
        input: 0.6,
        notes: "国际站美元价；人民币价见 bigmodel.cn 定价页",
        output: 2.2,
        source: src("https://docs.z.ai/guides/overview/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://docs.bigmodel.cn/cn/guide/start/model-overview"),
    thinking: THINKING_TOGGLE,
    vision: false,
  },
  {
    contextWindow: 200_000,
    key: "glm-5v-turbo",
    label: "GLM-5V Turbo",
    maxOutputTokens: 128_000,
    pricing: {
      zhipu: {
        cachedInput: 0.24,
        currency: "USD",
        input: 1.2,
        notes: "国际站美元价；人民币价见 bigmodel.cn 定价页",
        output: 4,
        source: src("https://docs.z.ai/guides/overview/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://docs.bigmodel.cn/cn/guide/start/model-overview"),
    thinking: THINKING_TOGGLE,
    vision: true,
  },

  // ---- MiniMax (platform.minimaxi.com / platform.minimax.io) ----
  {
    contextWindow: 204_800,
    key: "minimax-m2.7",
    label: "MiniMax M2.7",
    maxOutputTokens: 204_800,
    pricing: {
      minimax: {
        cachedInput: 0.42,
        currency: "CNY",
        input: 2.1,
        output: 8.4,
        source: src("https://platform.minimaxi.com/docs/guides/pricing-paygo.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.minimax.io/docs/api-reference/text-chat-openai.md"),
    thinking: THINKING_TOGGLE,
    vision: false,
  },

  // ---- Alibaba Cloud Model Studio (help.aliyun.com) ----
  {
    contextWindow: 1_000_000,
    key: "qwen3.5-plus",
    label: "Qwen3.5 Plus",
    maxOutputTokens: 65_536,
    pricing: {
      dashscope: {
        cachedInput: 0.08,
        currency: "CNY",
        input: 0.8,
        notes: "输入不超过 128K tokens 档价；更长输入按官方阶梯价格计费",
        output: 4.8,
        source: src("https://help.aliyun.com/en/model-studio/qwen3-5-plus"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://help.aliyun.com/en/model-studio/qwen3-5-plus"),
    thinking: THINKING_TOGGLE,
    vision: true,
  },

  // ---- OpenAI (developers.openai.com) ----
  {
    aliases: ["gpt-5.6"],
    contextWindow: 1_050_000,
    key: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    maxOutputTokens: 128_000,
    pricing: {
      openai: {
        cachedInput: 0.4,
        currency: "USD",
        input: 4,
        notes: "输入超过 272K tokens 的部分：输入 2 倍、输出 1.5 倍计价",
        output: 20,
        source: src("https://developers.openai.com/api/docs/models/gpt-5.6-sol"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://developers.openai.com/api/docs/models/gpt-5.6-sol"),
    thinking: THINKING_OPENAI_56,
    vision: true,
  },
  {
    contextWindow: 1_050_000,
    key: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    maxOutputTokens: 128_000,
    pricing: {
      openai: {
        cachedInput: 0.2,
        currency: "USD",
        input: 2,
        notes: "输入超过 272K tokens 的部分：输入 2 倍、输出 1.5 倍计价",
        output: 12,
        source: src("https://developers.openai.com/api/docs/models/gpt-5.6-terra"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://developers.openai.com/api/docs/models/gpt-5.6-terra"),
    thinking: THINKING_OPENAI_56,
    vision: true,
  },
  {
    contextWindow: 1_050_000,
    key: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    maxOutputTokens: 128_000,
    pricing: {
      openai: {
        cachedInput: 0.02,
        currency: "USD",
        input: 0.2,
        output: 1.2,
        source: src("https://developers.openai.com/api/docs/models/gpt-5.6-luna"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://developers.openai.com/api/docs/models/gpt-5.6-luna"),
    thinking: THINKING_OPENAI_56,
    vision: true,
  },
  {
    contextWindow: 1_050_000,
    key: "gpt-5.5",
    label: "GPT-5.5",
    maxOutputTokens: 128_000,
    pricing: {
      openai: {
        cachedInput: 0.5,
        currency: "USD",
        input: 5,
        notes: "输入超过 272K tokens 的部分适用更高档价",
        output: 30,
        source: src("https://developers.openai.com/api/docs/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://developers.openai.com/api/docs/models/gpt-5.5"),
    thinking: THINKING_OPENAI_55,
    vision: true,
  },
  {
    contextWindow: 400_000,
    key: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    maxOutputTokens: 128_000,
    pricing: {
      openai: {
        cachedInput: 0.075,
        currency: "USD",
        input: 0.75,
        output: 4.5,
        source: src("https://developers.openai.com/api/docs/models/gpt-5.4-mini"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://developers.openai.com/api/docs/models/gpt-5.4-mini"),
    thinking: THINKING_OPENAI_55,
    vision: true,
  },

  // ---- Anthropic (platform.claude.com) ----
  {
    contextWindow: 1_000_000,
    key: "claude-fable-5",
    label: "Claude Fable 5",
    maxOutputTokens: 128_000,
    pricing: {
      anthropic: {
        cachedInput: 1,
        currency: "USD",
        input: 10,
        notes: "缓存写入另计（5 分钟 1.25 倍 / 1 小时 2 倍输入价）",
        output: 50,
        source: src("https://platform.claude.com/docs/en/about-claude/pricing.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.claude.com/docs/en/about-claude/models/overview.md"),
    thinking: {
      ...THINKING_ANTHROPIC_EFFORTS,
      modes: ["auto", "enabled"],
    },
    vision: true,
  },
  {
    contextWindow: 1_000_000,
    key: "claude-opus-5",
    label: "Claude Opus 5",
    maxOutputTokens: 128_000,
    pricing: {
      anthropic: {
        cachedInput: 0.5,
        currency: "USD",
        input: 5,
        output: 25,
        source: src("https://platform.claude.com/docs/en/about-claude/pricing.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.claude.com/docs/en/about-claude/models/overview.md"),
    thinking: THINKING_ANTHROPIC_EFFORTS,
    vision: true,
  },
  {
    contextWindow: 1_000_000,
    key: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    maxOutputTokens: 128_000,
    pricing: {
      anthropic: {
        cachedInput: 0.2,
        currency: "USD",
        input: 2,
        output: 10,
        source: src("https://platform.claude.com/docs/en/about-claude/pricing.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.claude.com/docs/en/about-claude/models/overview.md"),
    thinking: THINKING_ANTHROPIC_EFFORTS,
    vision: true,
  },
  {
    aliases: ["claude-haiku-4-5-20251001"],
    apiVariant: "anthropic-legacy",
    contextWindow: 200_000,
    key: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    maxOutputTokens: 64_000,
    pricing: {
      anthropic: {
        cachedInput: 0.1,
        currency: "USD",
        input: 1,
        output: 5,
        source: src("https://platform.claude.com/docs/en/about-claude/pricing.md"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://platform.claude.com/docs/en/about-claude/models/overview.md"),
    thinking: THINKING_TOGGLE,
    vision: true,
  },

  // ---- Google Gemini (ai.google.dev) ----
  {
    contextWindow: 1_048_576,
    key: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    maxOutputTokens: 65_536,
    pricing: {
      gemini: {
        cachedInput: 0.075,
        currency: "USD",
        input: 0.75,
        notes: "2026-12-31 前价格；2027-01-01 起翻倍",
        output: 3.75,
        source: src("https://ai.google.dev/gemini-api/docs/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash"),
    thinking: {
      efforts: ["low", "medium", "high"],
      modes: ["auto", "enabled"],
      supported: true,
    },
    vision: true,
  },
  {
    contextWindow: 1_048_576,
    key: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    maxOutputTokens: 65_536,
    pricing: {
      gemini: {
        cachedInput: 0.2,
        currency: "USD",
        input: 2,
        notes: "提示 ≤200K tokens 档价；超过 200K 适用更高档",
        output: 12,
        source: src("https://ai.google.dev/gemini-api/docs/pricing"),
        unit: "per-1m-tokens",
      },
    },
    source: src("https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview"),
    thinking: {
      efforts: ["low", "medium", "high"],
      modes: ["auto", "enabled"],
      supported: true,
    },
    vision: true,
  },
];

/** Lower-case the id and strip a vendor path prefix ("org/model") plus common
 *  hosted-variant suffixes so rehosted ids match their canonical record. */
export function normalizeCatalogModelId(modelId: string): string {
  const lower = modelId.trim().toLowerCase();
  const slash = lower.lastIndexOf("/");
  const bare = slash === -1 ? lower : lower.slice(slash + 1);
  return bare.replace(/:(free|extended|exacto)$/, "");
}

/** Curated suggestions for providers without a listing endpoint: the models
 *  whose pricing table names this preset. */
export function listCatalogModelsForPreset(presetId: string): ModelCatalogRecord[] {
  return MODEL_CATALOG.filter((record) => record.pricing?.[presetId as ModelProviderPresetId] !== undefined);
}

/**
 * Resolve curated metadata for a model id. Pricing is only returned when it
 * was recorded for the given preset — a rehosted model keeps its capability
 * facts but never inherits another vendor's prices.
 */
export function lookupModelCatalog(modelId: string, presetId?: string): ModelCatalogEntry | undefined {
  const normalized = normalizeCatalogModelId(modelId);
  const record = MODEL_CATALOG.find((entry) => entry.key === normalized || entry.aliases?.includes(normalized))
    // Date-suffixed snapshots ("<id>-20260423" / "<id>-2026-04-23") match
    // their base record.
    ?? MODEL_CATALOG.find((entry) => normalized.startsWith(`${entry.key}-2`));
  if (!record) return undefined;
  const pricing = presetId === undefined ? undefined : record.pricing?.[presetId as ModelProviderPresetId];
  return {
    ...(record.apiVariant ? { apiVariant: record.apiVariant } : {}),
    label: record.label,
    source: record.source,
    ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
    ...(record.maxOutputTokens !== undefined ? { maxOutputTokens: record.maxOutputTokens } : {}),
    ...(record.vision !== undefined ? { vision: record.vision } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

/** Narrow saved/user-selected thinking values to the official per-model
 * capability. This is also the migration path for legacy values such as
 * GPT-5.5 `max`, which safely becomes its nearest legal `xhigh` value. */
export function constrainCatalogThinking(
  modelId: string,
  mode?: ModelThinkingMode,
  effort?: ModelThinkingEffort,
): { effort: ModelThinkingEffort; mode: ModelThinkingMode } {
  const thinking = lookupModelCatalog(modelId)?.thinking;
  const requestedMode = mode ?? thinking?.defaultMode ?? "auto";
  const requestedEffort = effort ?? thinking?.defaultEffort ?? "high";
  if (!thinking?.supported) return { effort: requestedEffort, mode: requestedMode };

  const modes = thinking.modes;
  const legalMode = modes?.length && !modes.includes(requestedMode)
    ? thinking.defaultMode ?? (modes.includes("auto") ? "auto" : modes[0]!)
    : requestedMode;
  const efforts = thinking.efforts;
  let legalEffort = requestedEffort;
  if (efforts?.length && !efforts.includes(requestedEffort)) {
    legalEffort = requestedEffort === "max" && efforts.includes("xhigh")
      ? "xhigh"
      : thinking.defaultEffort
        ?? (efforts.includes("high") ? "high" : efforts[0]!);
  }
  return { effort: legalEffort, mode: legalMode };
}
