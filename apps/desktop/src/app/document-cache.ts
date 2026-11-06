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
 * Version bytes, read once.
 *
 * Opening an artifact used to read the version's bytes every time, so pressing
 * the same chip twice paid two round trips for a document that cannot have
 * changed: a version id names one immutable CAS blob. The dialog also wants the
 * bytes as soon as the version list names a version, while the version effect
 * only runs after that list has been rendered — this cache is what lets both
 * paths ask for the same read and share one request instead of queueing two.
 *
 * Bounded in both directions: one document larger than `MAX_ENTRY_BYTES` is
 * served but not kept, and the cache as a whole drops its least recently used
 * documents once it passes `MAX_TOTAL_BYTES`. The hold is per `ApiClient`, so a
 * client that is replaced on reconnect (and every test's own client) starts
 * empty.
 */

import type { ApiClient } from "../api/client.js";
import { readArtifactVersion, type DocumentBytes } from "../api/sessions.js";

const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

interface Cache {
  /** Kept documents, in least-recently-used first order. */
  entries: Map<string, DocumentBytes>;
  /** Reads in flight, so a second caller joins the first request. */
  pending: Map<string, Promise<DocumentBytes>>;
  bytes: number;
}

const caches = new WeakMap<ApiClient, Cache>();

function cacheOf(client: ApiClient): Cache {
  let cache = caches.get(client);
  if (cache === undefined) {
    cache = { bytes: 0, entries: new Map(), pending: new Map() };
    caches.set(client, cache);
  }
  return cache;
}

/** Both halves are needed: the bytes are addressed by version, and a version
 *  is read through the Session that owns it. */
function keyOf(sessionId: string, versionId: string): string {
  return `${sessionId}\u0000${versionId}`;
}

function evict(cache: Cache): void {
  for (const [key, document] of cache.entries) {
    if (cache.bytes <= MAX_TOTAL_BYTES) return;
    cache.entries.delete(key);
    cache.bytes -= document.bytes.byteLength;
  }
}

/**
 * The version's bytes, from the cache when they are there. A failed read is
 * never cached: the next caller retries, which is what the dialog's 重试 press
 * relies on.
 */
export function readCachedDocument(
  client: ApiClient,
  sessionId: string,
  versionId: string,
): Promise<DocumentBytes> {
  const cache = cacheOf(client);
  const key = keyOf(sessionId, versionId);
  const cached = cache.entries.get(key);
  if (cached !== undefined) {
    // Re-inserting moves the entry to the young end of the eviction order.
    cache.entries.delete(key);
    cache.entries.set(key, cached);
    return Promise.resolve(cached);
  }
  const inFlight = cache.pending.get(key);
  if (inFlight !== undefined) return inFlight;
  const request = readArtifactVersion(client, sessionId, versionId).then(
    (document) => {
      cache.pending.delete(key);
      if (document.bytes.byteLength <= MAX_ENTRY_BYTES) {
        cache.entries.set(key, document);
        cache.bytes += document.bytes.byteLength;
        evict(cache);
      }
      return document;
    },
    (failure: unknown) => {
      cache.pending.delete(key);
      throw failure;
    },
  );
  cache.pending.set(key, request);
  return request;
}

/** Drops everything held for this client. For tests that count requests. */
export function forgetCachedDocuments(client: ApiClient): void {
  caches.delete(client);
}
