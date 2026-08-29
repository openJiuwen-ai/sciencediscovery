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
 * Download one models.dev catalog document. The caller decides what to do with
 * it: the control API maps it into catalog records and persists the snapshot.
 * Failures are typed so a manual refresh can report why it failed without the
 * caller having to parse a message.
 */

import { request } from "undici";

import type { ModelsDevPayload, ResolvedProxy } from "@sciencediscovery/schema";

import { proxyDispatcher } from "./client.js";

/** A refresh that did not produce a usable document. The previously loaded
 *  snapshot stays in place; the message is written for a settings dialog. */
export class ModelCatalogFetchError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "ModelCatalogFetchError";
  }
}

const CATALOG_TIMEOUT_MS = 60_000;
/** The published document is a few megabytes; anything far larger is not it. */
const CATALOG_MAX_BYTES = 64 * 1024 * 1024;

export interface ModelCatalogFetchOptions {
  proxy?: ResolvedProxy;
  timeoutMs?: number;
  url: string;
}

export async function fetchModelsDevCatalog(options: ModelCatalogFetchOptions): Promise<ModelsDevPayload> {
  const dispatcher = proxyDispatcher(options.proxy);
  const timeout = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  let statusCode: number;
  let bodyText: string;
  try {
    const response = await request(options.url, {
      method: "GET",
      headers: { accept: "application/json" },
      headersTimeout: timeout,
      bodyTimeout: timeout,
      ...(dispatcher ? { dispatcher } : {}),
    });
    statusCode = response.statusCode;
    bodyText = await response.body.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelCatalogFetchError(`The model catalog is unreachable: ${message}`);
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new ModelCatalogFetchError(
      `The model catalog request failed with status ${statusCode}`,
      statusCode,
    );
  }
  if (bodyText.length > CATALOG_MAX_BYTES) {
    throw new ModelCatalogFetchError("The model catalog response is implausibly large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new ModelCatalogFetchError("The model catalog response is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelCatalogFetchError("The model catalog response is not a provider map");
  }
  const payload = parsed as ModelsDevPayload;
  // One provider carrying models is the cheapest proof that this is the
  // catalog document and not an error page that happened to be valid JSON.
  const usable = Object.values(payload).some((provider) =>
    typeof provider === "object" && provider !== null
    && typeof (provider as { models?: unknown }).models === "object");
  if (!usable) throw new ModelCatalogFetchError("The model catalog response contains no providers");
  return payload;
}
