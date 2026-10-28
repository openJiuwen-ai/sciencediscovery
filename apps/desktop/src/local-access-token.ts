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

import { TOKEN_STORAGE_KEY, readRenamedStorageItem, type ReadableStorage } from "./state/storage.js";

/**
 * Consume the startup link before React mounts or any request starts.
 *
 * The launch banner prints `http://127.0.0.1:4310/#token=<token>`, and the
 * fragment is the right channel because the browser never sends it to the
 * server: it stays out of request logs and out of `Referer`. A query string
 * would do neither.
 *
 * The stored value is written before the fragment is removed, so a second
 * initialisation (React StrictMode runs the tree twice) reads the same
 * credential rather than an emptied URL.
 */
export function loadLocalAccessToken(
  storage: ReadableStorage,
  location: Pick<Location, "href">,
  history: Pick<History, "replaceState" | "state">,
): string {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("token")?.trim();
  if (fragment.has("token")) {
    if (token) {
      try {
        storage.setItem(TOKEN_STORAGE_KEY, token);
      } catch {
        // A storage that rejects writes still gets the token for this session.
      }
    }
    fragment.delete("token");
    url.hash = fragment.toString();
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return token || readRenamedStorageItem(storage, TOKEN_STORAGE_KEY) || "";
}
