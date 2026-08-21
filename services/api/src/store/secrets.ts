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
  ModelProfile,
  UpdateModelProfileRequest,
} from "@sciencediscovery/schema";
import { cleanLabel } from "@sciencediscovery/governance";

const MODEL_SECRET_KEY_BYTES = 32;
const MODEL_SECRET_VERSION = "v1";

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
  return { baseUrl: endpoint.toString().replace(/\/$/, ""), model, name, vision: input.vision === true };
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
