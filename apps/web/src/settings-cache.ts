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
 * The Settings dialog unmounts a pane as soon as another group is selected, so
 * every pane used to start from nothing: a spinner, one round trip, then the
 * content. A pane keeps its last answer here — keyed by the client that
 * produced it, so a new connection never reads another one's — and paints it
 * on the next open while the fresh request lands behind it.
 *
 * Only for answers that are cheap to show stale: a list, a status, a flag.
 * Anything the user is about to act on is still read from the server first.
 */
const stores = new WeakMap<object, Map<string, unknown>>();

export function readSettingsCache<T>(client: object, key: string): T | undefined {
  return stores.get(client)?.get(key) as T | undefined;
}

export function writeSettingsCache<T>(client: object, key: string, value: T): void {
  let store = stores.get(client);
  if (!store) {
    store = new Map();
    stores.set(client, store);
  }
  store.set(key, value);
}
