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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { fetchTextAsset } from "../catalog/load.js";

import type { JSX } from "react";

export function Markdown({ source }: { source: string }): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => <a href={href} rel="noreferrer" target="_blank">{children}</a>,
        }}
        remarkPlugins={[remarkGfm]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

/** Renders a Markdown file published by the exporter, e.g. a skill's SKILL.md. */
export function MarkdownFile({ basePath, fallback, url }: { basePath: string; fallback?: string; url: string }): JSX.Element {
  const [state, setState] = useState<{ status: "error" | "loading" | "ready"; text: string }>({ status: "loading", text: "" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", text: "" });
    fetchTextAsset(basePath, url)
      .then((text) => {
        if (!cancelled) setState({ status: "ready", text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [basePath, url]);

  if (state.status === "loading") return <p className="muted">…</p>;
  if (state.status === "error") return <p className="muted">{fallback ?? ""}</p>;
  return <Markdown source={state.text} />;
}
