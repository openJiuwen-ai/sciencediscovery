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

import type { JSX } from "react";
import type { CategoryNode } from "../catalog/types.js";
import type { Language } from "../i18n.js";

interface CategoryTreeProps {
  labels: { all: string; categories: string };
  language: Language;
  nodes: CategoryNode[];
  onSelect: (domain: string | null, subdomain: string | null) => void;
  selected: { domain: string | null; subdomain: string | null };
  total: number;
}

export function CategoryTree({ labels, language, nodes, onSelect, selected, total }: CategoryTreeProps): JSX.Element {
  return (
    <nav className="tree" aria-label={labels.categories}>
      <p className="tree-title">{labels.categories}</p>
      <button
        aria-current={selected.domain ? undefined : "true"}
        className="tree-row"
        onClick={() => onSelect(null, null)}
        type="button"
      >
        <span>{labels.all}</span>
        <span className="tree-count">{total}</span>
      </button>
      {nodes.map((node) => {
        const active = selected.domain === node.id;
        return (
          <div key={node.id}>
            <button
              aria-current={active && !selected.subdomain ? "true" : undefined}
              className={`tree-row${active ? " tree-row-open" : ""}`}
              onClick={() => onSelect(node.id, null)}
              type="button"
            >
              <span>{node.label[language]}</span>
              <span className="tree-count">{node.count}</span>
            </button>
            {active && node.children?.length ? (
              <div className="tree-children">
                {node.children.map((child) => (
                  <button
                    aria-current={selected.subdomain === child.id ? "true" : undefined}
                    className="tree-row tree-row-child"
                    key={child.id}
                    onClick={() => onSelect(node.id, child.id)}
                    type="button"
                  >
                    <span>{child.label[language]}</span>
                    <span className="tree-count">{child.count}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
