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

import { TEXT } from "../text.js";

export interface Loaded<T> {
  error?: string;
  loading: boolean;
  reload: () => void;
  value?: T;
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
 * `load` is read through a ref rather than listed as a dependency: it is a new
 * closure on every render, and depending on it would re-fetch in a loop. The
 * page reloads when it mounts or when `reload()` is called, and at no other
 * time.
 */
export function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const loadRef = useRef(load);
  loadRef.current = load;

  const [state, setState] = useState<{ error?: string; loading: boolean; value?: T }>({
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ error: undefined, loading: true, value: current.value }));
    loadRef.current().then(
      (value) => {
        if (!cancelled) setState({ loading: false, value });
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
  }, [nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);
  return { ...state, reload };
}
