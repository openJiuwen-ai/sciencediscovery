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

import {
  CONNECTOR_FUNCTION_LABELS,
  DOMAIN_LABELS,
  SESSION_TASK_LABELS,
  SUBDOMAIN_LABELS,
  labelFor,
} from "./category-labels.js";

import type { CategoryNode, ConnectorAsset, SessionAsset, SkillAsset } from "./types.js";

function node(id: string, labels: Record<string, { en: string; zh: string }>, count: number): CategoryNode {
  return { count, id, label: labelFor(labels, id) ?? { en: id, zh: id } };
}

function sorted(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.toSorted((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

/**
 * 学科 → 子领域。子领域计数之和等于该学科的资产数。
 * 只统计普通技能：团队技能在站点上有独立的 tab，不进入这棵树，否则分类栏的
 * 计数会与技能列表的总数对不上。
 */
export function skillCategories(assets: SkillAsset[]): CategoryNode[] {
  const domains = new Map<string, { subdomains: Map<string, number>; total: number }>();
  for (const asset of assets) {
    if (asset.kind !== "skill") continue;
    const { domain, subdomain } = asset.category;
    const entry = domains.get(domain) ?? { subdomains: new Map(), total: 0 };
    entry.total += 1;
    entry.subdomains.set(subdomain, (entry.subdomains.get(subdomain) ?? 0) + 1);
    domains.set(domain, entry);
  }
  return sorted([...domains.entries()].map(([domain, entry]) => ({
    ...node(domain, DOMAIN_LABELS, entry.total),
    children: sorted([...entry.subdomains.entries()].map(([subdomain, count]) => node(subdomain, SUBDOMAIN_LABELS, count))),
  })));
}

/** 连接器只有一个层级：功能分组。 */
export function connectorCategories(assets: ConnectorAsset[]): CategoryNode[] {
  const groups = new Map<string, number>();
  for (const asset of assets) {
    const group = asset.category.function;
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  return sorted([...groups.entries()].map(([group, count]) => node(group, CONNECTOR_FUNCTION_LABELS, count)));
}

/** 会话包：任务类型 → 学科，未分类的任务落到 uncategorized。 */
export function sessionCategories(assets: SessionAsset[]): CategoryNode[] {
  const tasks = new Map<string, { domains: Map<string, number>; total: number }>();
  for (const asset of assets) {
    const task = asset.category.task ?? "uncategorized";
    const entry = tasks.get(task) ?? { domains: new Map(), total: 0 };
    entry.total += 1;
    if (asset.category.domain) entry.domains.set(asset.category.domain, (entry.domains.get(asset.category.domain) ?? 0) + 1);
    tasks.set(task, entry);
  }
  return sorted([...tasks.entries()].map(([task, entry]) => ({
    ...node(task, SESSION_TASK_LABELS, entry.total),
    ...(entry.domains.size
      ? { children: sorted([...entry.domains.entries()].map(([domain, count]) => node(domain, DOMAIN_LABELS, count))) }
      : {}),
  })));
}
