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

import { useEffect, useState } from "react";

import { loadCatalog } from "./catalog/load.js";

import type { JSX } from "react";
import type { Catalog } from "./catalog/types.js";

const BASE_PATH = import.meta.env.BASE_URL;

type State =
  | { status: "error"; message: string }
  | { status: "loading" }
  | { status: "ready"; catalog: Catalog };

export function App(): JSX.Element {
  const [state, setState] = useState<State>({ status: "loading" });

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

  if (state.status === "loading") return <main>加载中…</main>;
  if (state.status === "error") return <main>无法载入目录：{state.message}</main>;

  const count = (kind: string): number => state.catalog.assets.filter((asset) => asset.kind === kind).length;
  return (
    <main>
      <h1>ScienceDiscovery Hub</h1>
      <p>
        技能 {count("skill")} 个 · 团队技能 {count("team-skill")} 个 · 专家 {count("specialist")} 个 · 连接器{" "}
        {count("connector")} 个
      </p>
    </main>
  );
}
