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

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

import type {
  CreateModelProfileRequest,
  ModelApiProtocol,
  ModelApiVariant,
  ModelFactOverrides,
  ModelProfile,
  ModelThinkingEffort,
  ModelThinkingMode,
  UpdateModelProfileRequest,
  UserModelPricing,
} from "@sciencediscovery/schema";
import {
  constrainCatalogThinking,
  DEFAULT_MODEL_API_VARIANT,
  lookupModelCatalog,
  MODEL_API_VARIANTS,
} from "@sciencediscovery/schema";
import { cleanLabel } from "@sciencediscovery/governance";

const MODEL_SECRET_KEY_BYTES = 32;
const MODEL_SECRET_VERSION = "v1";

/** A token count the user typed. Rejected rather than clamped: silently
 *  turning 1.5 or -1 into something else would store a number the user never
 *  stated and then show it back as fact. */
function factTokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number of tokens`);
  }
  return value;
}

function factRate(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a price per million tokens that is zero or greater`);
  }
  return value;
}

function normalizeUserPricing(value: unknown): UserModelPricing | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("The model price is invalid");
  const pricing = value as Partial<UserModelPricing>;
  if (pricing.currency !== "CNY" && pricing.currency !== "USD") {
    throw new Error("The model price currency must be CNY or USD");
  }
  const input = factRate(pricing.input, "The model input price");
  const output = factRate(pricing.output, "The model output price");
  // Input and output together are what every price display needs; a half
  // price would render as a confident number beside a blank.
  if (input === undefined || output === undefined) {
    throw new Error("The model price must state both an input and an output rate");
  }
  const cachedInput = factRate(pricing.cachedInput, "The model cached input price");
  return {
    ...(cachedInput !== undefined ? { cachedInput } : {}),
    currency: pricing.currency,
    input,
    output,
  };
}

/**
 * Validate the facts a user stated for a model. Absent keys mean "no override"
 * and let the listing and the catalog answer; an empty result is returned as
 * `undefined` so a profile never carries a hollow overrides object.
 */
const THINKING_EFFORTS: readonly ModelThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The effort stops the user says this endpoint accepts. Kept in the product's
 * own raw names because those are the values sent on the wire; the order is
 * normalized to weakest-first so every display shows one ascending scale
 * regardless of how the list was typed.
 */
function normalizeThinkingEfforts(value: unknown): ModelThinkingEffort[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("The model thinking efforts must be a list");
  const seen = new Set<ModelThinkingEffort>();
  for (const entry of value) {
    if (typeof entry !== "string" || !THINKING_EFFORTS.includes(entry as ModelThinkingEffort)) {
      throw new Error(`The model thinking efforts must each be one of ${THINKING_EFFORTS.join(", ")}`);
    }
    seen.add(entry as ModelThinkingEffort);
  }
  if (!seen.size) return undefined;
  return THINKING_EFFORTS.filter((effort) => seen.has(effort));
}

export function normalizeModelFactOverrides(value: unknown): ModelFactOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("The model facts are invalid");
  const facts = value as Partial<ModelFactOverrides>;
  const contextWindow = factTokenCount(facts.contextWindow, "The model context window");
  const maxOutputTokens = factTokenCount(facts.maxOutputTokens, "The model maximum output");
  const pricing = normalizeUserPricing(facts.pricing);
  const thinkingEfforts = normalizeThinkingEfforts(facts.thinkingEfforts);
  if (facts.thinkingSupported !== undefined && typeof facts.thinkingSupported !== "boolean") {
    throw new Error("The model thinking support must be true or false");
  }
  const normalized: ModelFactOverrides = {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(pricing !== undefined ? { pricing } : {}),
    ...(thinkingEfforts !== undefined ? { thinkingEfforts } : {}),
    ...(facts.thinkingSupported !== undefined ? { thinkingSupported: facts.thinkingSupported } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

export function validateLiveModel(
  input: CreateModelProfileRequest | UpdateModelProfileRequest,
): Omit<ModelProfile, "createdAt" | "hasApiToken" | "id" | "proxyPolicy" | "updatedAt"> {
  const name = cleanLabel(input.name ?? "", "Untitled model");
  const model = cleanLabel(input.model ?? "", "");
  if (!model) throw new Error("Model ID is required");

  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl?.trim() ?? "");
  } catch {
    throw new Error("The LLM base URL is invalid");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("The LLM base URL must use http or https");
  }
  const apiProtocol: ModelApiProtocol = input.apiProtocol ?? (
    endpoint.toString().includes("/api/plan") ? "anthropic-messages" : "openai-chat-completions"
  );
  if (!Object.hasOwn(MODEL_API_VARIANTS, apiProtocol)) throw new Error("The model API protocol is invalid");
  let apiVariant: ModelApiVariant = input.apiVariant ?? DEFAULT_MODEL_API_VARIANT[apiProtocol];
  if (!MODEL_API_VARIANTS[apiProtocol].includes(apiVariant)) {
    throw new Error(`Model API variant ${apiVariant} is not valid for ${apiProtocol}`);
  }
  const catalogVariant = lookupModelCatalog(model)?.apiVariant;
  if (catalogVariant && MODEL_API_VARIANTS[apiProtocol].includes(catalogVariant)) {
    apiVariant = catalogVariant;
  }
  const requestedMode: ModelThinkingMode = input.thinkingMode ?? "auto";
  if (!(["auto", "enabled", "disabled"] as const).includes(requestedMode)) {
    throw new Error("The model thinking mode is invalid");
  }
  const requestedEffort: ModelThinkingEffort = input.thinkingEffort ?? "high";
  if (!(["low", "medium", "high", "xhigh", "max"] as const).includes(requestedEffort)) {
    throw new Error("The model thinking effort is invalid");
  }
  const facts = normalizeModelFactOverrides(input.facts);
  const { effort: thinkingEffort, mode: thinkingMode } = constrainCatalogThinking(
    model,
    input.thinkingMode === undefined ? undefined : requestedMode,
    input.thinkingEffort === undefined ? undefined : requestedEffort,
    facts,
  );
  return {
    apiProtocol,
    apiVariant,
    baseUrl: endpoint.toString().replace(/\/$/, ""),
    ...(facts ? { facts } : {}),
    model,
    name,
    thinkingEffort,
    thinkingMode,
    vision: input.vision === true,
  };
}

export function normalizeApiToken(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const token = value.trim();
  if (!token) throw new Error("The LLM API token cannot be empty");
  if (token.length > 16_384) throw new Error("The LLM API token is too long");
  return token;
}

export async function loadOrCreateModelSecretKey(path: string): Promise<Buffer> {
  const readExisting = async (): Promise<Buffer> => {
    const key = await readFile(path);
    if (key.length !== MODEL_SECRET_KEY_BYTES) throw new Error("The model credential key has an invalid length");
    await chmod(path, 0o600);
    return key;
  };
  try {
    return await readExisting();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(MODEL_SECRET_KEY_BYTES);
  try {
    await writeFile(path, key, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await readExisting();
  }
}

export function encryptModelApiToken(secretKey: Buffer, modelId: string, apiToken: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey, nonce);
  cipher.setAAD(Buffer.from(modelId));
  const ciphertext = Buffer.concat([cipher.update(apiToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MODEL_SECRET_VERSION, nonce.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptModelApiToken(secretKey: Buffer, modelId: string, encrypted: string): string {
  const [version, nonce, tag, ciphertext] = encrypted.split(".");
  if (version !== MODEL_SECRET_VERSION || !nonce || !tag || ciphertext === undefined) {
    throw new Error("The saved model credential has an unsupported format");
  }
  const decipher = createDecipheriv("aes-256-gcm", secretKey, Buffer.from(nonce, "base64"));
  decipher.setAAD(Buffer.from(modelId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
