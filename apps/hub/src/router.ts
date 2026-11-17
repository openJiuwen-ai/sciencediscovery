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

import { useCallback, useEffect, useState } from "react";

export const TABS = ["skills", "specialists", "connectors", "sessions"] as const;

export type Tab = (typeof TABS)[number];

export interface Route {
  id: string | null;
  params: URLSearchParams;
  tab: Tab;
}

function normalizeBase(basePath: string): string {
  return basePath.replace(/\/+$/u, "");
}

export function parseRoute(basePath: string, location: Location = globalThis.location): Route {
  const base = normalizeBase(basePath);
  let rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname;
  rest = rest.replace(/^\/+/u, "").replace(/\/+$/u, "");
  const [segment, id] = rest.split("/");
  const tab = (TABS as readonly string[]).includes(segment ?? "") ? segment as Tab : "skills";
  return {
    id: id ? decodeURIComponent(id) : null,
    params: new URLSearchParams(location.search),
    tab,
  };
}

export function routePath(basePath: string, route: Route): string {
  const base = normalizeBase(basePath);
  const segments = [route.tab, route.id].filter((part): part is string => Boolean(part));
  const search = route.params.toString();
  return `${base || ""}/${segments.map((part) => encodeURIComponent(part)).join("/")}${search ? `?${search}` : ""}`;
}

export function useRoute(basePath: string): { route: Route; setRoute: (route: Route, options?: { replace?: boolean }) => void } {
  const [route, setCurrent] = useState<Route>(() => parseRoute(basePath));

  useEffect(() => {
    const update = (): void => setCurrent(parseRoute(basePath));
    globalThis.addEventListener("popstate", update);
    return () => globalThis.removeEventListener("popstate", update);
  }, [basePath]);

  const setRoute = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const url = routePath(basePath, next);
    if (options.replace) globalThis.history.replaceState(null, "", url);
    else globalThis.history.pushState(null, "", url);
    setCurrent(next);
    globalThis.scrollTo({ top: 0 });
  }, [basePath]);

  return { route, setRoute };
}
