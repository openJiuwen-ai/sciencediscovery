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

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The assistant's prose.
 *
 * GitHub-flavoured Markdown is on because tables and task lists are how the
 * model reports most results. Math is not: the prototype renders formulas and
 * the full app bundles KaTeX for them, but carrying that in the first version
 * buys a font and a stylesheet for a case the plain renderer already degrades
 * to readable text.
 *
 * Links open outside the app. Inside an Electron window an unhandled `target`
 * would put a second window on screen, so the shell is configured to hand
 * these to the system browser; in a plain browser this is an ordinary new tab.
 *
 * A table comes out wrapped in a scroller because a table is the one thing here
 * that cannot be made narrower: its columns are as wide as their content, and
 * the widths are the model's, not ours. The workspace panel can be dragged down
 * to 280px, and a table that does not fit has to scroll — its parent clips, so
 * without this the columns on the right would simply be gone.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: label, href }) => (
          <a href={href} rel="noreferrer" target="_blank">{label}</a>
        ),
        table: ({ children: rows }) => (
          <div className="md-scroll">
            <table>{rows}</table>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
});
