// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import type { ModelApiVariant, ModelThinkingEffort, ModelThinkingMode } from "@sciencediscovery/schema";

/** The real E2E endpoint uses DeepSeek wire fields unless the environment overrides its API variant. */
export function realModelApiVariant(env = process.env): ModelApiVariant {
  const variant = env.E2E_LLM_API_VARIANT?.trim() || "deepseek";
  if (!["anthropic-adaptive", "anthropic-legacy", "deepseek", "gemini", "kimi-k3", "minimax", "ollama", "openai", "qwen", "responses"].includes(variant)) {
    throw new Error("Invalid E2E_LLM_API_VARIANT");
  }
  return variant as ModelApiVariant;
}

/** One policy for the registered generator and its session, including background searches. */
export function realModelThinking(env = process.env): { thinkingMode: ModelThinkingMode; thinkingEffort: ModelThinkingEffort } {
  const mode = env.E2E_LLM_THINKING_MODE?.trim() || "enabled";
  const effort = env.E2E_LLM_THINKING_EFFORT?.trim() || "low";
  if (!["auto", "enabled", "disabled"].includes(mode)) throw new Error("Invalid E2E_LLM_THINKING_MODE");
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Invalid E2E_LLM_THINKING_EFFORT");
  return { thinkingMode: mode as ModelThinkingMode, thinkingEffort: effort as ModelThinkingEffort };
}
