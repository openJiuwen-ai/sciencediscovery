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

import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";

import {
  findMarkdownFigureArtifact,
  MarkdownRenderer,
  resolveMarkdownImageSource,
  type MarkdownRendererProps,
} from "../src/Markdown.js";
import type { ComposerReference, ScientificArtifact } from "@science-agent/schema";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(content: string, references?: ComposerReference[], onChipClick?: (reference: ComposerReference) => void, props: Partial<MarkdownRendererProps> = {}): string {
  return renderToStaticMarkup(createElement(MarkdownRenderer, { content, references, onChipClick, ...props }));
}

function figure(id: string, name: string, sessionId = "session-1", declaredPath?: string): ScientificArtifact {
  return {
    createdAt: "2026-08-11T00:00:00.000Z",
    createdInSessionId: sessionId,
    createdInSessionTitle: "Session",
    currentVersion: 1,
    id,
    kind: "figure",
    logicalName: name,
    name,
    origin: "llm_declared",
    ...(declaredPath ? { originMeta: { declaredPath } } : {}),
    projectId: "project-1",
    sessionId,
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

test("renders GFM structure and math", () => {
  const html = render(`# Result

**Important** insight with $R = C_y^{-1/3}$.

- one
- two

| Metric | Value |
| --- | ---: |
| R | 0.5 |

- [x] verified`);

  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<strong>Important<\/strong>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="markdown-table-scroll"/);
  assert.match(html, /<input type="checkbox"[^>]*>/);
  assert.match(html, /disabled=""/);
  assert.match(html, /checked=""/);
  assert.doesNotMatch(html, /node="\[object Object\]"/);
});

test("does not render raw HTML or unsafe links", () => {
  const html = render(`<script>alert("unsafe")</script>

[unsafe](javascript:alert(1))

[source](https://example.com/paper)`);

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="https:\/\/example\.com\/paper"/);
  assert.match(html, /rel="noreferrer"/);
  assert.match(html, /target="_blank"/);
});

test("classifies direct and current-Session workspace image sources", () => {
  assert.deepEqual(resolveMarkdownImageSource("matrix.png", "session-1"), { kind: "workspace", path: "matrix.png" });
  assert.deepEqual(resolveMarkdownImageSource("./plots/matrix%20map.png", "session-1"), { kind: "workspace", path: "plots/matrix map.png" });
  assert.deepEqual(resolveMarkdownImageSource("/workspace/plots/matrix.png", "session-1"), { kind: "workspace", path: "plots/matrix.png" });
  assert.deepEqual(
    resolveMarkdownImageSource("/api/sessions/session-1/file?path=plots%2Fmatrix.png", "session-1"),
    { kind: "workspace", path: "plots/matrix.png" },
  );
  assert.deepEqual(resolveMarkdownImageSource("https://example.com/matrix.png", "session-1"), {
    kind: "direct",
    src: "https://example.com/matrix.png",
  });
  assert.equal(resolveMarkdownImageSource("/api/sessions/session-2/file?path=matrix.png", "session-1").kind, "unsupported");
  assert.equal(resolveMarkdownImageSource("../outside.png", "session-1").kind, "unsupported");
  assert.equal(resolveMarkdownImageSource("javascript:alert(1)", "session-1").kind, "unsupported");
});

test("matches only an unambiguous current-Session figure artifact", () => {
  const exact = figure("exact", "Display title", "session-1", "plots/matrix.png");
  const otherSession = figure("other-session", "matrix.png", "session-2");
  assert.equal(findMarkdownFigureArtifact([exact, otherSession], "plots/matrix.png", "session-1")?.id, "exact");
  assert.equal(findMarkdownFigureArtifact([exact, otherSession], "matrix.png", "session-1")?.id, "exact");
  assert.equal(findMarkdownFigureArtifact([
    exact,
    figure("ambiguous", "other/matrix.png", "session-1"),
  ], "matrix.png", "session-1"), undefined);
});

test("keeps external images native and replaces unresolved workspace images with guidance", () => {
  const external = render("![remote](https://example.com/plot.png)");
  assert.match(external, /<img[^>]*src="https:\/\/example\.com\/plot\.png"/);
  assert.doesNotMatch(external, /Image unavailable/);

  const unresolved = render("![matrix multiplication](missing.png)");
  assert.doesNotMatch(unresolved, /<img/);
  assert.match(unresolved, /Image unavailable/);
  assert.match(unresolved, /matrix multiplication/);
  assert.match(unresolved, /view it in Artifacts/);
});

test("localizes the image failure guidance", () => {
  const html = renderToStaticMarkup(createElement(
    LocaleProvider,
    { initialLocale: "zh-CN" },
    createElement(MarkdownRenderer, { content: "![热力图](missing.png)" }),
  ));
  assert.match(html, /图片无法加载/);
  assert.match(html, /前往产物面板查看/);
});

test("loads a workspace image through the authenticated reader and revokes its blob URL", async () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:authenticated-image";
  URL.revokeObjectURL = (url) => revoked.push(url);
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(MarkdownRenderer, {
        content: "![matrix](./plots/matrix.png)",
        loadWorkspaceImage: async (path: string) => {
          assert.equal(path, "plots/matrix.png");
          return new Blob(["png"], { type: "image/png" });
        },
        workspaceSessionId: "session-1",
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const image = renderer!.root.findByType("img");
    assert.equal(image.props.alt, "matrix");
    assert.equal(image.props.src, "blob:authenticated-image");
    await act(async () => renderer!.unmount());
    assert.deepEqual(revoked, ["blob:authenticated-image"]);
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("renders a readable failure state when authenticated image loading fails", async () => {
  let opened = false;
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(MarkdownRenderer, {
      content: "![missing heatmap](missing.png)",
      loadWorkspaceImage: async () => { throw new Error("not found"); },
      onOpenArtifacts: () => { opened = true; },
      workspaceSessionId: "session-1",
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.match(JSON.stringify(renderer!.toJSON()), /Image unavailable/);
  assert.match(JSON.stringify(renderer!.toJSON()), /missing heatmap/);
  renderer!.root.findByType("button").props.onClick();
  assert.equal(opened, true);
  await act(async () => renderer!.unmount());
});

test("links canonical connector citations and normalizes a legacy bare PMID", () => {
  const html = render([
    "[ARXIV:2507.23276]",
    "[eUrOpEpMc:PMC3257301]",
    "[pmid:41887499]",
    "[UNIPROT:P04637]",
    "[12524540]",
  ].join(" "));

  assert.match(html, /href="https:\/\/arxiv\.org\/abs\/2507\.23276"[^>]*>arXiv:2507\.23276<\/a>/);
  assert.match(html, /href="https:\/\/europepmc\.org\/article\/PMC\/PMC3257301"[^>]*>EuropePMC:PMC3257301<\/a>/);
  assert.match(html, /href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/41887499\/"[^>]*>PMID:41887499<\/a>/);
  assert.match(html, /href="https:\/\/www\.uniprot\.org\/uniprotkb\/P04637\/entry"[^>]*>UniProt:P04637<\/a>/);
  assert.match(html, /href="https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/12524540\/"[^>]*>PMID:12524540<\/a>/);
});

test("does not rewrite citations that are already linked or inside code", () => {
  const html = render("[PMID:41887499](https://example.com/custom) `[PMID:41887499]` [Europe PMC:PMC3257301]");

  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /href="https:\/\/example\.com\/custom"/);
  assert.match(html, /<code>\[PMID:41887499\]<\/code>/);
  assert.match(html, /\[Europe PMC:PMC3257301\]/);
});

test("graph chips render as buttons when a reference matches the alias", () => {
  const references: ComposerReference[] = [
    { id: "ev-1", kind: "evidence", label: "evidence1" },
    { id: "ev-2", kind: "evidence", label: "evidence2" },
  ];
  const html = render("TP53 mutation frequency ~8-12% [evidence1] [evidence2] [unknown].", references, () => undefined);

  // evidence1 and evidence2 resolve to chips; [unknown] stays plain text.
  assert.match(html, /<button[^>]*class="graph-chip"[^>]*>\[evidence1\]<\/button>/);
  assert.match(html, /<button[^>]*class="graph-chip"[^>]*>\[evidence2\]<\/button>/);
  assert.match(html, /\[unknown\]/);
  assert.doesNotMatch(html, /<button[^>]*>\[unknown\]<\/button>/);
});

test("graph chips stay plain text when no references are provided", () => {
  const html = render("A report with [evidence1] but no reference map.");
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /\[evidence1\]/);
});

// Regression coverage for the literature-review report path: the assistant
// writes the final report into the chat message body with evidence1/evidence2
// / artifact1/artifact2 aliases, and the message carries the drained chip
// references. This pins the exact label set (evidence + artifact kinds) the
// wiring fix must route through the conversation message renderer.
test("evidence and artifact chips render together from message-level references", () => {
  const references: ComposerReference[] = [
    { id: "ev-id-1", kind: "evidence", label: "evidence1" },
    { id: "ev-id-2", kind: "evidence", label: "evidence2" },
    { id: "fig-art", kind: "artifact", label: "artifact1", version: 1 },
    { id: "data-art", kind: "artifact", label: "artifact2", version: 1 },
  ];
  const html = render(
    "Immune pathway enrichment [artifact1] and underlying counts [artifact2] draw on [evidence1] and [evidence2]; [evidence9] is unclaimed.",
    references,
    () => undefined,
  );

  assert.match(html, /<button[^>]*class="graph-chip"[^>]*>\[evidence1\]<\/button>/);
  assert.match(html, /<button[^>]*class="graph-chip"[^>]*>\[evidence2\]<\/button>/);
  assert.match(html, /<button[^>]*class="graph-chip"[^>]*>\[artifact1\]<\/button>/);
  assert.match(html, /<button[^>]*class="graph-chip"[^>]*>\[artifact2\]<\/button>/);
  // An alias with no matching reference stays plain text, not a chip.
  assert.match(html, /\[evidence9\]/);
  assert.doesNotMatch(html, /<button[^>]*>\[evidence9\]<\/button>/);
});
