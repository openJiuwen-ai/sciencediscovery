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

import { AssetCard } from "../components/AssetCard.js";
import { CategoryTree } from "../components/CategoryTree.js";
import { counted } from "../i18n.js";
import { HARDWARE_LABELS, SKILL_TYPE_LABELS, SOURCE_LABELS } from "../labels.js";

import type { JSX } from "react";
import type { Asset, CategoryNode } from "../catalog/types.js";
import type { CopyKey, Language } from "../i18n.js";
import type { Route } from "../router.js";

interface ListViewProps {
  assets: Asset[];
  basePath: string;
  categories?: CategoryNode[];
  copy: (key: CopyKey) => string;
  /** Connectors read better grouped by function even when nothing is selected. */
  groupByCategory?: boolean;
  language: Language;
  onOpen: (asset: Asset) => void;
  onFilter: (changes: Record<string, string | null>) => void;
  route: Route;
  /** The tab's own label, shown above the grid. */
  title: string;
  total: number;
}

/** The selected value for the tree, whichever parameter this tab filters by. */
function selectedGroup(route: Route, groupByCategory: boolean): { domain: string | null; subdomain: string | null } {
  return {
    domain: route.params.get(groupByCategory ? "function" : "domain"),
    subdomain: route.params.get("sub"),
  };
}

function categoryFields(asset: Asset): { domain?: string; function?: string; subdomain?: string } {
  // A session package's tree is task → domain, so the tree's parent and child
  // have to map onto the generic two-level parameters the router already uses;
  // reading category.domain here would match nothing.
  if (asset.kind === "session-package") return { domain: asset.category.task, subdomain: asset.category.domain };
  return asset.kind === "specialist" ? {} : asset.category as { domain?: string; function?: string; subdomain?: string };
}

/** Session packages filter by the benchmark's origin, not by how they were published. */
function sourceOf(asset: Asset): string {
  return asset.kind === "session-package" ? asset.category.source : asset.source;
}

function matches(asset: Asset, route: Route): boolean {
  const query = route.params.get("q")?.trim().toLowerCase();
  if (query) {
    const haystack = [asset.name, asset.description, asset.id, ...asset.tags].join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  const source = route.params.get("source");
  if (source && sourceOf(asset) !== source) return false;
  const domain = route.params.get("domain");
  const subdomain = route.params.get("sub");
  const group = route.params.get("function");
  if (domain || subdomain || group) {
    const category = categoryFields(asset);
    if (domain && category.domain !== domain) return false;
    if (subdomain && category.subdomain !== subdomain) return false;
    if (group && category.function !== group) return false;
  }
  if (asset.kind !== "skill" && asset.kind !== "team-skill") return true;
  const type = route.params.get("type");
  if (type && asset.type !== type) return false;
  const hardware = route.params.get("hardware");
  if (hardware && asset.hardware !== hardware) return false;
  return true;
}

function options(assets: Asset[]): { hardware: string[]; type: string[] } {
  const types = new Set<string>();
  const hardware = new Set<string>();
  for (const asset of assets) {
    if (asset.kind !== "skill" && asset.kind !== "team-skill") continue;
    if (asset.type) types.add(asset.type);
    if (asset.hardware) hardware.add(asset.hardware);
  }
  return { hardware: [...hardware].toSorted(), type: [...types].toSorted() };
}

function FilterSelect(props: {
  label: string;
  onChange: (value: string | null) => void;
  options: { label: string; value: string }[];
  value: string | null;
}): JSX.Element {
  return (
    <label className="filter">
      <span>{props.label}</span>
      <select onChange={(event) => props.onChange(event.target.value || null)} value={props.value ?? ""}>
        <option value="">—</option>
        {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

export function ListView(props: ListViewProps): JSX.Element {
  const { assets, categories, copy, language, onFilter, route } = props;
  const visible = assets.filter((asset) => matches(asset, route));
  const { hardware, type } = options(assets);
  const selected = selectedGroup(route, props.groupByCategory === true);
  const sourceOptions = Object.entries(SOURCE_LABELS)
    .filter(([id]) => assets.some((asset) => sourceOf(asset) === id))
    .map(([id, label]) => ({ label: label[language], value: id }));
  // A filter with one possible value is noise: show the section only when it
  // can actually narrow the list.
  const hasFilters = type.length > 0 || hardware.length > 0 || sourceOptions.length > 1;

  const card = (asset: (typeof visible)[number]) => (
    <AssetCard
      asset={asset}
      basePath={props.basePath}
      copy={copy}
      key={asset.id}
      language={language}
      onOpen={() => props.onOpen(asset)}
    />
  );
  const cards = visible.map(card);

  // An empty tree must not turn the tab into "grouped by nothing": fall back
  // to the flat grid, and keep assets whose category matches no node visible.
  const grouped = props.groupByCategory && !route.params.get("function") && categories && categories.length > 0;
  const groups = grouped
    ? (() => {
      const tree = categories ?? [];
      const known = new Set(tree.map((category) => category.id));
      const result: { cards: JSX.Element[]; id: string; label: string }[] = tree.map((category) => ({
        cards: visible.filter((asset) => categoryFields(asset).function === category.id).map(card),
        id: category.id,
        label: category.label[language],
      })).filter((group) => group.cards.length);
      const rest = visible.filter((asset) => !known.has(categoryFields(asset).function ?? ""));
      if (rest.length) {
        result.push({
          cards: rest.map(card),
          id: "__other",
          label: copy("uncategorized"),
        });
      }
      return result;
    })()
    : null;

  return (
    <div className={`layout${categories || hasFilters ? "" : " layout-plain"}`}>
      {categories || hasFilters ? <aside className="sidebar">
        {categories ? (
          <CategoryTree
            labels={{ all: copy("all"), categories: copy("categories") }}
            language={language}
            nodes={categories}
            onSelect={(domain, subdomain) => onFilter(props.groupByCategory
              ? { function: domain, sub: subdomain }
              : { domain, sub: subdomain })}
            selected={selected}
            total={props.total}
          />
        ) : null}
        {hasFilters ? <div className="filters">
          <p className="tree-title">{copy("filters")}</p>
          {type.length ? (
            <FilterSelect
              label={copy("type")}
              onChange={(value) => onFilter({ type: value })}
              options={type.map((id) => ({ label: SKILL_TYPE_LABELS[id]?.[language] ?? id, value: id }))}
              value={route.params.get("type")}
            />
          ) : null}
          {hardware.length ? (
            <FilterSelect
              label={copy("hardware")}
              onChange={(value) => onFilter({ hardware: value })}
              options={hardware.map((id) => ({ label: HARDWARE_LABELS[id]?.[language] ?? id, value: id }))}
              value={route.params.get("hardware")}
            />
          ) : null}
          {sourceOptions.length > 1 ? (
            <FilterSelect
              label={copy("source")}
              onChange={(value) => onFilter({ source: value })}
              options={sourceOptions}
              value={route.params.get("source")}
            />
          ) : null}
        </div> : null}
      </aside> : null}
      <section className="main">
        <div className="list-head">
          <div>
            <h2>{props.title}</h2>
            <p className="muted">{counted(visible.length, copy("count"), language)}</p>
          </div>
          {route.params.get("q") ? (
            <button className="clear" onClick={() => onFilter({ q: null })} type="button">
              {copy("all")}
            </button>
          ) : null}
        </div>
        {visible.length === 0 ? <p className="empty">{copy("empty")}</p> : null}
        {groups ? groups.map((group) => (
          <section key={group.id}>
            <h2 className="group-heading">{group.label}</h2>
            <div className="grid">{group.cards}</div>
          </section>
        )) : <div className="grid">{cards}</div>}
      </section>
    </div>
  );
}
