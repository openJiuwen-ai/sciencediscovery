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

import { useEffect, useMemo, useState } from "react";

import { loadCatalog } from "./catalog/load.js";
import { useCopy, useLanguage } from "./i18n.js";
import { TABS, useRoute } from "./router.js";
import { ConnectorDetail, SkillDetail, SpecialistDetail } from "./views/Detail.js";
import { ListView } from "./views/ListView.js";

import type { JSX } from "react";
import type { Asset, Catalog } from "./catalog/types.js";
import type { CopyKey } from "./i18n.js";
import type { Route, Tab } from "./router.js";

const BASE_PATH = import.meta.env.BASE_URL;

type State =
  | { message: string; status: "error" }
  | { status: "loading" }
  | { catalog: Catalog; status: "ready" };

function assetsFor(catalog: Catalog, tab: Tab): Asset[] {
  if (tab === "skills") return catalog.assets.filter((asset) => asset.kind === "skill" || asset.kind === "team-skill");
  if (tab === "specialists") return catalog.assets.filter((asset) => asset.kind === "specialist");
  if (tab === "connectors") return catalog.assets.filter((asset) => asset.kind === "connector");
  return catalog.assets.filter((asset) => asset.kind === "session-package");
}

export function App(): JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });
  const { language, toggle } = useLanguage();
  const copy = useCopy(language);
  const { route, setRoute } = useRoute(BASE_PATH);

  useEffect(() => {
    let cancelled = false;
    loadCatalog(BASE_PATH)
      .then((catalog) => {
        if (!cancelled) setState({ catalog, status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ message: error instanceof Error ? error.message : String(error), status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    if (state.status !== "ready") return null;
    return Object.fromEntries(TABS.map((tab) => [tab, assetsFor(state.catalog, tab).length])) as Record<Tab, number>;
  }, [state]);

  function goTo(tab: Tab): void {
    setRoute({ id: null, params: new URLSearchParams(), tab });
  }

  function openAsset(tab: Tab, id: string): void {
    setRoute({ id, params: route.params, tab });
  }

  function updateFilters(tab: Tab, changes: Record<string, string | null>): void {
    const params = new URLSearchParams(route.params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    setRoute({ id: null, params, tab }, { replace: true });
  }

  function renderDetail(catalog: Catalog, current: Route, copyText: (key: CopyKey) => string): JSX.Element {
    const asset = catalog.assets.find((candidate) => candidate.id === current.id);
    if (!asset) return <p className="empty">{copyText("notFound")}</p>;
    const props = {
      asset,
      basePath: BASE_PATH,
      catalog,
      copy: copyText,
      language,
      onNavigate: openAsset,
    };
    if (asset.kind === "skill" || asset.kind === "team-skill") return <SkillDetail {...props} />;
    if (asset.kind === "specialist") return <SpecialistDetail {...props} />;
    if (asset.kind === "connector") return <ConnectorDetail {...props} />;
    return <p className="empty">{copyText("notFound")}</p>;
  }

  function renderBody(): JSX.Element {
    if (state.status === "loading") return <p className="empty">{copy("loading")}</p>;
    if (state.status === "error") return <p className="empty">{copy("error")}: {state.message}</p>;
    const catalog = state.catalog;
    const list = assetsFor(catalog, route.tab);

    if (route.id) {
      return (
        <>
          <button className="back" onClick={() => goTo(route.tab)} type="button">← {copy("back")}</button>
          {renderDetail(catalog, route, copy)}
        </>
      );
    }
    if (route.tab === "sessions" && list.length === 0) return <p className="empty">{copy("empty")}</p>;

    return (
      <ListView
        assets={list}
        basePath={BASE_PATH}
        categories={route.tab === "skills" ? catalog.categories.skill : route.tab === "connectors" ? catalog.categories.connector : undefined}
        copy={copy}
        groupByCategory={route.tab === "connectors"}
        language={language}
        onFilter={(changes) => updateFilters(route.tab, changes)}
        onOpen={(asset) => openAsset(route.tab, asset.id)}
        route={route}
        total={list.length}
      />
    );
  }

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => goTo("skills")} type="button">
          ScienceDiscovery <span>Hub</span>
        </button>
        <nav className="tabs">
          {TABS.map((tab) => (
            <button
              aria-current={route.tab === tab ? "page" : undefined}
              className="tab"
              key={tab}
              onClick={() => goTo(tab)}
              type="button"
            >
              {copy(tab)}
              {counts ? <span className="tab-count">{counts[tab]}</span> : null}
            </button>
          ))}
        </nav>
        <button className="lang" onClick={toggle} type="button">{language === "zh" ? "EN" : "中文"}</button>
      </header>
      <main className="content">{renderBody()}</main>
    </div>
  );
}
