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
import type { ApiClient } from "../api.js";

type Listing = Awaited<ReturnType<ApiClient["listMcpSources"]>>;

/** The catalog is separate from selection. A failed read must not imply ready. */
export function useMcpReadiness(client: Pick<ApiClient, "listMcpSources" | "reloadMcpSources">) {
  const [listing, setListing] = useState<Listing>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [client]);
  const applyListing = useCallback((items: Listing) => {
    generation.current++;
    setListing(items); setError(undefined); setRefreshing(false);
  }, []);
  const refresh = useCallback(async (reload = false) => {
    const request = ++generation.current;
    setRefreshing(true);
    try {
      if (reload) await client.reloadMcpSources();
      const items = await client.listMcpSources();
      if (request === generation.current) { setListing(items); setError(undefined); }
    } catch (reason) {
      if (request === generation.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (request === generation.current) setRefreshing(false);
    }
  }, [client]);
  const check = useCallback(() => { void refresh(); }, [refresh]);
  const reload = useCallback(() => { void refresh(true); }, [refresh]);
  return { sources: listing.map(item => item.manifest),
    sourceStatuses: error ? {} : Object.fromEntries(listing.map(item => [item.manifest.id, item.status])),
    applyListing, refresh, check, reload, refreshing, error };
}
