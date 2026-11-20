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
import { writeEnabled } from "./api/client.js";
import { AccountView } from "./views/Account.js";
import { BackIcon, BrandMark, GlobeIcon, SearchIcon } from "./components/icons.js";
import { counted, useCopy, useLanguage } from "./i18n.js";
import { TABS, useRoute } from "./router.js";
import { ConnectorDetail, SessionDetail, SkillDetail, SpecialistDetail } from "./views/Detail.js";
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
  if (tab === "skills") return catalog.assets.filter((asset) => asset.kind === "skill");
  if (tab === "teams") return catalog.assets.filter((asset) => asset.kind === "team-skill");
  if (tab === "specialists") return catalog.assets.filter((asset) => asset.kind === "specialist");
  if (tab === "connectors") return catalog.assets.filter((asset) => asset.kind === "connector");
  return catalog.assets.filter((asset) => asset.kind === "session-package");
}

export function App(): JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });
  const [hintVisible, setHintVisible] = useState(true);
  const [accountOpen, setAccountOpen] = useState(() => globalThis.location.pathname.replace(/\/+$/u, "").endsWith("/account"));
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

  useEffect(() => {
    const update = (): void => setAccountOpen(globalThis.location.pathname.replace(/\/+$/u, "").endsWith("/account"));
    globalThis.addEventListener("popstate", update);
    return () => globalThis.removeEventListener("popstate", update);
  }, []);

  function openAccount(): void {
    globalThis.history.pushState(null, "", `${BASE_PATH.replace(/\/+$/u, "")}/account`);
    setAccountOpen(true);
  }

  function closeAccount(): void {
    globalThis.history.pushState(null, "", BASE_PATH);
    setAccountOpen(false);
  }

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
    if (asset.kind === "session-package") return <SessionDetail {...props} />;
    return <p className="empty">{copyText("notFound")}</p>;
  }

  function renderBody(): JSX.Element {
    if (state.status === "loading") return <p className="empty">{copy("loading")}</p>;
    if (state.status === "error") return <p className="empty">{copy("error")}: {state.message}</p>;
    const catalog = state.catalog;
    const list = assetsFor(catalog, route.tab);

    if (route.id) {
      return (
        <div className="detail-wrap">
          <button className="back" onClick={() => goTo(route.tab)} type="button">
            <BackIcon size={16} />
            {copy("back")}
          </button>
          {renderDetail(catalog, route, copy)}
        </div>
      );
    }
    if (route.tab === "sessions" && list.length === 0) return <p className="empty">{copy("sessionsEmpty")}</p>;

    return (
      <ListView
        assets={list}
        basePath={BASE_PATH}
        categories={route.tab === "skills"
          ? catalog.categories.skill
          : route.tab === "connectors"
            ? catalog.categories.connector
            : route.tab === "sessions" ? catalog.categories.sessionPackage : undefined}
        copy={copy}
        groupByCategory={route.tab === "connectors"}
        language={language}
        onFilter={(changes) => updateFilters(route.tab, changes)}
        onOpen={(asset) => openAsset(route.tab, asset.id)}
        route={route}
        title={copy(route.tab)}
        total={list.length}
      />
    );
  }

  const summary = counts
    ? ([
      [counts.skills, copy("skills")],
      [counts.teams, copy("teams")],
      [counts.specialists, copy("specialists")],
      [counts.connectors, copy("connectors")],
      [counts.sessions, copy("sessions")],
    ] as [number, string][]).map(([value, label]) => {
      const [number, ...words] = counted(value, label, language).split(" ");
      return <span key={label}><b>{number}</b> {words.join(" ")}</span>;
    })
    : null;

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => goTo("skills")} type="button">
          <BrandMark size={30} />
          <span className="brand-name">ScienceDiscovery <b>Hub</b></span>
        </button>
        <div className="top-actions">
          {writeEnabled ? (
            <button className="lang" onClick={() => { if (accountOpen) closeAccount(); else openAccount(); }} type="button">
              {language === "zh" ? "账号" : "Account"}
            </button>
          ) : null}
          <button aria-label={language === "zh" ? "切换到英文" : "Switch to Chinese"} className="lang" onClick={toggle} type="button">
            <GlobeIcon size={16} />
            {language === "zh" ? "中文" : "EN"}
          </button>
        </div>
      </header>

      {route.id ? null : (
        <section className="hero">
          <div className="hero-inner">
            <h1>ScienceDiscovery <span>Hub</span></h1>
            {summary ? <p className="hero-sub">{summary}</p> : null}
            <nav aria-label={copy("categories")} className="segmented">
              {TABS.map((tab) => (
                <button
                  aria-current={route.tab === tab ? "page" : undefined}
                  className="segment"
                  key={tab}
                  onClick={() => goTo(tab)}
                  type="button"
                >
                  {copy(tab)}
                  {counts ? <span className="segment-count">{counts[tab]}</span> : null}
                </button>
              ))}
            </nav>
            <div className="hero-search">
              <SearchIcon className="hero-search-icon" size={18} />
              <input
                aria-label={copy("search")}
                onChange={(event) => updateFilters(route.tab, { q: event.target.value || null })}
                placeholder={copy("search")}
                type="search"
                value={route.params.get("q") ?? ""}
              />
            </div>
            {hintVisible && route.tab === "sessions" ? (
              <div className="hint">
                <span>{copy("hint")}</span>
                <button aria-label={copy("dismiss")} className="hint-close" onClick={() => setHintVisible(false)} type="button">×</button>
              </div>
            ) : null}
          </div>
        </section>
      )}

      <main className="content">
        {accountOpen ? <AccountView language={language} onClose={closeAccount} /> : renderBody()}
      </main>
    </div>
  );
}
