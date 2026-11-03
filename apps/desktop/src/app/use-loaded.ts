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

import { useCallback, useEffect, useRef, useState } from "react";

import { readSettingsCache, writeSettingsCache } from "./settings-cache.js";
import { TEXT } from "../text.js";

export interface Loaded<T> {
  error?: string;
  loading: boolean;
  reload: () => void;
  value?: T;
}

/**
 * Where a page's last answer is kept, so the next visit can paint it at once.
 *
 * `client` scopes the entry: reconnecting yields another object, and nothing
 * from the previous service may show up under it. `key` names the answer
 * within that client, and a project-scoped page puts the project in it — one
 * project's enabled Skills must never be painted as another's.
 */
export interface RememberedAnswer {
  client: object;
  key: string;
}

/**
 * Read one settings page's data when it mounts, and re-read on demand.
 *
 * Every settings page follows the same shape: the server owns the value, the
 * page shows it, a write goes back through the server rather than through
 * local state. That is why there is no "optimistic" path here — after any
 * write the page reloads, so what is on screen is always something the server
 * confirmed.
 *
 * With `remember`, the dialog's habit of unmounting a pane when another group
 * is selected stops costing a loading frame: the page paints the last answer
 * it had and replaces it when the read settles. Without it the page starts
 * empty, and the loading gate is right: the first thing a form shows must be
 * the server's current value, not the previous visit's.
 *
 * `load` is read through a ref rather than listed as a dependency: it is a new
 * closure on every render, and depending on it would re-fetch in a loop. The
 * page reloads when it mounts or when `reload()` is called, and at no other
 * time.
 */
export function useLoaded<T>(load: () => Promise<T>, remember?: RememberedAnswer): Loaded<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  const [state, setState] = useState<{ error?: string; loading: boolean; value?: T }>(() => {
    const value = remember ? readSettingsCache<T>(remember.client, remember.key) : undefined;
    return value === undefined ? { loading: true } : { loading: true, value };
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Read again here rather than trusting the mount-time value: the key can
    // change while the page stays mounted (a Project switch), and the answer
    // kept under the new key is the only one that belongs on screen.
    const cached = remember ? readSettingsCache<T>(remember.client, remember.key) : undefined;
    setState((current) => ({
      error: undefined,
      loading: true,
      value: remember ? cached : current.value,
    }));
    loadRef.current().then(
      (value) => {
        if (cancelled) return;
        if (remember) writeSettingsCache(remember.client, remember.key, value);
        setState({ loading: false, value });
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({
            error: reason instanceof Error ? reason.message : TEXT.errors.generic,
            loading: false,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [nonce, remember?.client, remember?.key]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);
  return { ...state, reload };
}
