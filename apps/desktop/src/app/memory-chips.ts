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

/**
 * A final report cites its evidence in prose: `[evidence1]`, `[artifact1]`.
 * The alias → graph-node map is persisted on the report version's
 * `references`, so the renderer can turn each alias into a chip without
 * guessing what the alias means.
 *
 * The transform is done on the Markdown tree, before React sees it, because
 * the alternative — rendering the brackets and attaching a click handler to
 * the text — would put a button inside a sentence in a way that can be split
 * across nodes by emphasis or a line break. A link node survives both.
 */

import type {
  ComposerReference,
  ComposerReferenceKind,
  MemoryGraphNodeLabel,
} from "../api/types.js";

/** The subset of an mdast node this transform reads and writes. The full
 *  tree is typed by the Markdown library, but only these fields matter here
 *  and keeping the shape local avoids a dependency on its internal types. */
export interface ChipNode {
  children?: ChipNode[];
  type: string;
  url?: string;
  value?: string;
}

/** `[alias]` in a report body. Conservative on purpose: only an alias that
 *  resolves to a reference becomes a chip, so a literal `[note]` stays text. */
const CHIP_TOKEN = /\[([^\]\s]{1,80})\]/g;

/**
 * The alias → reference index. A token `[x]` matches a reference whose
 * `label` is `x` (the alias the model chose), failing that whose `id` is `x`,
 * so a node id written directly into the report resolves too.
 */
export function buildChipIndex(references: ComposerReference[] | undefined): Map<string, ComposerReference> {
  const index = new Map<string, ComposerReference>();
  if (references === undefined) return index;
  for (const reference of references) {
    if (reference.label) index.set(reference.label, reference);
    if (reference.id && !index.has(reference.id)) index.set(reference.id, reference);
  }
  return index;
}

export function graphChipUrl(reference: Pick<ComposerReference, "id" | "kind">): string {
  return `graph://${reference.kind}/${encodeURIComponent(reference.id)}`;
}

/** The reverse map the renderer uses: the link node carries only the URL, and
 *  the original reference is what knows the pinned version and Session. */
export function referencesByUrl(
  references: ComposerReference[] | undefined,
): Map<string, ComposerReference> {
  const byUrl = new Map<string, ComposerReference>();
  if (references === undefined) return byUrl;
  for (const reference of references) {
    byUrl.set(graphChipUrl(reference), reference);
  }
  return byUrl;
}

export function parseGraphChipUrl(url: string): { id: string; kind: ComposerReferenceKind } | undefined {
  const match = /^graph:\/\/([^/]+)\/(.+)$/.exec(url);
  if (match === null) return undefined;
  try {
    return { id: decodeURIComponent(match[2]!), kind: match[1] as ComposerReferenceKind };
  } catch {
    // A malformed escape is not a chip; the link renderer leaves it alone.
    return undefined;
  }
}

/** The graph label a reference kind points at, for the detail read. `session`
 *  and `skill` are composer context, not memory nodes, and a Paper is reached
 *  through the Evidence extracted from it rather than cited directly. */
export function referenceNodeLabel(kind: ComposerReferenceKind): MemoryGraphNodeLabel | undefined {
  switch (kind) {
    case "evidence": return "Evidence";
    case "artifact": return "Artifact";
    case "sourcefile": return "SourceFile";
    case "dbrecord": return "DbRecord";
    default: return undefined;
  }
}

/** Replace every resolvable `[alias]` in one text node with a `graph://` link.
 *  Returns `undefined` when the text has no chip, which is the common case and
 *  lets the walk skip allocating a replacement array. */
export function graphChipNodes(
  value: string,
  index: Map<string, ComposerReference>,
): ChipNode[] | undefined {
  if (index.size === 0) return undefined;
  const result: ChipNode[] = [];
  let cursor = 0;
  let linked = false;
  CHIP_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(CHIP_TOKEN)) {
    const reference = index.get(match[1]!);
    if (reference === undefined) continue;
    if (match.index > cursor) result.push({ type: "text", value: value.slice(cursor, match.index) });
    result.push({
      children: [{ type: "text", value: match[0] }],
      type: "link",
      url: graphChipUrl(reference),
    });
    cursor = match.index + match[0].length;
    linked = true;
  }
  if (!linked) return undefined;
  if (cursor < value.length) result.push({ type: "text", value: value.slice(cursor) });
  return result;
}

/**
 * A remark attacher (options → transformer), so react-markdown's
 * `[plugin, options]` tuple threads the chip index in without a module-level
 * variable shared across renders.
 */
export function remarkGraphChips(options: { index: Map<string, ComposerReference> }) {
  return (tree: ChipNode): void => {
    const index = options.index;
    const visit = (node: ChipNode | undefined): void => {
      if (node === undefined || node.children === undefined) return;
      if (node.type === "link" || node.type === "linkReference") return;
      for (let at = 0; at < node.children.length; at += 1) {
        const child = node.children[at]!;
        if (child.type === "text" && child.value) {
          const replacement = graphChipNodes(child.value, index);
          if (replacement !== undefined) {
            node.children.splice(at, 1, ...replacement);
            at += replacement.length - 1;
          }
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}
