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

import React, { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes } from "react";
import Markdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ComposerReference, MemoryGraphNodeLabel, ScientificArtifact } from "@science-agent/schema";
import { evidenceCitationUrl, normalizeEvidenceCitationType } from "@science-agent/schema";

import { CopyButton } from "./CopyButton.js";
import { useLocale } from "./i18n/index.js";

export interface MarkdownRendererProps {
  className?: string;
  content: string;
  /** Chip references (alias → graph node) for a report Artifact version. The
   * LLM writes alias tokens like [evidence1]/[artifact1] in the report body; entries
   * whose label matches the alias render as clickable chips. Absent on
   * non-report content and on older reports (tokens stay plain text). */
  references?: ComposerReference[];
  /** Click handler for a graph chip: receives the matched reference so the
   * caller can open the node's detail (e.g. switch to the Memory tab and
   * select it). Chips with no handler still render but are not interactive. */
  onChipClick?: (reference: ComposerReference) => void;
  /** Authenticated reader scoped by the caller to `workspaceSessionId`. */
  loadWorkspaceImage?: (path: string, signal: AbortSignal) => Promise<Blob>;
  /** Expands or focuses the Artifacts panel from an image failure state. */
  onOpenArtifacts?: () => void;
  /** Current Session identity, used to reject cross-Session file URLs. */
  workspaceSessionId?: string;
}

export type MarkdownImageSource =
  | { kind: "direct"; src: string }
  | { kind: "workspace"; path: string }
  | { kind: "unsupported" };

interface MarkdownNode {
  children?: MarkdownNode[];
  type: string;
  url?: string;
  value?: string;
}

const CITATION_TOKEN = /\[(?:(arxiv|europepmc|pmid|uniprot):([^\]\s]+)|(\d{5,9}))\]/gi;

function citationNodes(value: string): MarkdownNode[] | undefined {
  const result: MarkdownNode[] = [];
  let cursor = 0;
  let linked = false;
  CITATION_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(CITATION_TOKEN)) {
    const type = normalizeEvidenceCitationType(match[1] ?? "PMID")!;
    const identifier = match[2] ?? match[3]!;
    const url = evidenceCitationUrl(type, identifier);
    if (!url) continue;
    if (match.index > cursor) result.push({ type: "text", value: value.slice(cursor, match.index) });
    result.push({ children: [{ type: "text", value: `${type}:${identifier}` }], type: "link", url });
    cursor = match.index + match[0].length;
    linked = true;
  }
  if (!linked) return undefined;
  if (cursor < value.length) result.push({ type: "text", value: value.slice(cursor) });
  return result;
}

/** The label→reference index for chip matching. A token [x] matches a
 * reference whose label is "x" (the alias the LLM chose); failing that, whose
 * id is "x" (so a node id used directly as a chip also resolves). */
function buildChipIndex(references: ComposerReference[] | undefined): Map<string, ComposerReference> {
  const index = new Map<string, ComposerReference>();
  if (!references) return index;
  for (const reference of references) {
    if (reference.label) index.set(reference.label, reference);
    if (reference.id && !index.has(reference.id)) index.set(reference.id, reference);
  }
  return index;
}

/** [token] inside a report body: any bracketed alias that resolves to a
 * reference. Conservative on purpose — only matches when the index has the
 * key, so a literal [evidence1] with no reference stays plain text. */
const CHIP_TOKEN = /\[([^\]\s]{1,80})\]/g;

function graphChipNodes(value: string, index: Map<string, ComposerReference>): MarkdownNode[] | undefined {
  if (!index.size) return undefined;
  const result: MarkdownNode[] = [];
  let cursor = 0;
  let linked = false;
  CHIP_TOKEN.lastIndex = 0;
  for (const match of value.matchAll(CHIP_TOKEN)) {
    const reference = index.get(match[1]!);
    if (!reference) continue;
    if (match.index > cursor) result.push({ type: "text", value: value.slice(cursor, match.index) });
    result.push({ children: [{ type: "text", value: match[0] }], type: "link", url: `graph://${reference.kind}/${reference.id}` });
    cursor = match.index + match[0].length;
    linked = true;
  }
  if (!linked) return undefined;
  if (cursor < value.length) result.push({ type: "text", value: value.slice(cursor) });
  return result;
}

/** Link canonical connector citations, including legacy bare PubMed identifiers. */
function remarkEvidenceCitations() {
  return (tree: MarkdownNode): void => {
    function visit(node: MarkdownNode): void {
      if (!node.children || node.type === "link" || node.type === "linkReference") return;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index]!;
        if (child.type === "text" && child.value) {
          const replacement = citationNodes(child.value);
          if (replacement) {
            node.children.splice(index, 1, ...replacement);
            index += replacement.length - 1;
          }
          continue;
        }
        visit(child);
      }
    }
    visit(tree);
  };
}

/** Turn [alias] tokens that resolve to a reference into graph:// chips.
 * A remark attacher (options → transformer) so react-markdown's [plugin,
 * options] tuple form threads the chip index in. */
function remarkGraphChips(options: { index: Map<string, ComposerReference> }) {
  return (tree: MarkdownNode): void => {
    const index = options.index;
    function visit(node: MarkdownNode | undefined): void {
      if (!node || !node.children || node.type === "link" || node.type === "linkReference") return;
      for (let index2 = 0; index2 < node.children.length; index2 += 1) {
        const child = node.children[index2]!;
        if (child.type === "text" && child.value) {
          const replacement = graphChipNodes(child.value, index);
          if (replacement) {
            node.children.splice(index2, 1, ...replacement);
            index2 += replacement.length - 1;
          }
          continue;
        }
        visit(child);
      }
    }
    visit(tree);
  };
}

/** The graph label for a ComposerReferenceKind, for the detail endpoint.
 * `session`/`skill` are composer-context references, not chips, so they have
 * no graph node. `paper` is never a chip kind — a Paper is reached indirectly
 * via the Evidence node extracted from it. */
export const KIND_TO_LABEL: Record<ComposerReference["kind"], MemoryGraphNodeLabel | undefined> = {
  evidence: "Evidence",
  artifact: "Artifact",
  session: undefined,
  skill: undefined,
};

/** Let graph:// chip URLs through unchanged (the custom `a` renderer turns
 * them into buttons); apply the default safety transform to everything else
 * so javascript: and other unsafe protocols stay stripped. */
function preserveGraphChipUrls(url: string, key: string, node: Parameters<NonNullable<Parameters<typeof Markdown>[0]["urlTransform"]>>[2]): string | null | undefined {
  if (url.startsWith("graph://")) return url;
  if (key === "src" && (url.startsWith("blob:") || url.startsWith("data:image/"))) return url;
  return defaultUrlTransform(url);
}

function decodePath(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Normalize a model-authored path without allowing it to escape the Session workspace. */
function normalizeWorkspaceImagePath(value: string): string | undefined {
  const decoded = decodePath(value.replaceAll("\\", "/"));
  if (!decoded) return undefined;
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : undefined;
}

/** Classify an image URL before it reaches a native `<img>` request. */
export function resolveMarkdownImageSource(source: string, workspaceSessionId?: string): MarkdownImageSource {
  const value = source.trim();
  if (/^(?:https?:\/\/|blob:|data:image\/)/i.test(value)) {
    return { kind: "direct", src: value };
  }

  const sessionFileUrl = value.match(/^\/?api\/sessions\/([^/]+)\/file(?:\?|$)/i);
  if (sessionFileUrl) {
    try {
      const parsed = new URL(value.startsWith("/") ? value : `/${value}`, "https://science-agent.local");
      const referencedSessionId = decodePath(sessionFileUrl[1]!);
      const path = parsed.searchParams.get("path");
      const normalized = path ? normalizeWorkspaceImagePath(path) : undefined;
      return referencedSessionId && workspaceSessionId === referencedSessionId && normalized
        ? { kind: "workspace", path: normalized }
        : { kind: "unsupported" };
    } catch {
      return { kind: "unsupported" };
    }
  }

  // Other schemes and root-relative web routes are not Session workspace paths.
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return { kind: "unsupported" };
  let candidate = value.split(/[?#]/, 1)[0] ?? "";
  if (candidate.startsWith("/workspace/")) candidate = candidate.slice("/workspace/".length);
  else if (candidate.startsWith("workspace/")) candidate = candidate.slice("workspace/".length);
  else if (candidate.startsWith("/")) return { kind: "unsupported" };
  const path = normalizeWorkspaceImagePath(candidate);
  return path ? { kind: "workspace", path } : { kind: "unsupported" };
}

/** Match only current-Session figure artifacts, avoiding ambiguous basename guesses. */
export function findMarkdownFigureArtifact(
  artifacts: ScientificArtifact[],
  path: string,
  workspaceSessionId: string,
): ScientificArtifact | undefined {
  const figures = artifacts.filter((artifact) => artifact.kind === "figure" && artifact.createdInSessionId === workspaceSessionId);
  const pathsFor = (artifact: ScientificArtifact): string[] => {
    const declaredPath = artifact.originMeta?.declaredPath;
    return [artifact.name, artifact.logicalName, typeof declaredPath === "string" ? declaredPath : ""]
      .map(normalizeWorkspaceImagePath)
      .filter((candidate): candidate is string => Boolean(candidate));
  };
  const exact = figures.filter((artifact) => pathsFor(artifact).includes(path));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const basename = path.split("/").at(-1);
  const basenameMatches = figures.filter((artifact) => pathsFor(artifact)
    .some((candidate) => candidate.split("/").at(-1) === basename));
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function imageLabel(alt: string | undefined, source: string | undefined): string {
  if (alt?.trim()) return alt.trim();
  const path = source?.split(/[?#]/, 1)[0]?.replaceAll("\\", "/");
  return path?.split("/").filter(Boolean).at(-1) || "image";
}

function MarkdownImageFailure({ alt, onOpenArtifacts, source }: {
  alt?: string;
  onOpenArtifacts?: () => void;
  source?: string;
}) {
  const label = imageLabel(alt, source);
  const { t } = useLocale();
  return (
    <span aria-label={t("markdown.imageUnavailableLabel", { label })} className="markdown-image-state error" role="img">
      <strong>{t("markdown.imageUnavailable")}</strong>
      <span>{label}</span>
      <small>{t("markdown.imageHelp")}</small>
      {onOpenArtifacts ? <button onClick={onOpenArtifacts} type="button">{t("markdown.openArtifacts")}</button> : null}
    </span>
  );
}

function MarkdownImage({
  alt,
  loadWorkspaceImage,
  onOpenArtifacts,
  src,
  workspaceSessionId,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & Pick<MarkdownRendererProps, "loadWorkspaceImage" | "onOpenArtifacts" | "workspaceSessionId">) {
  const { t } = useLocale();
  const resolved = useMemo(() => resolveMarkdownImageSource(src ?? "", workspaceSessionId), [src, workspaceSessionId]);
  const [directFailed, setDirectFailed] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<{ kind: "error" | "loading" } | { kind: "loaded"; url: string }>({ kind: "loading" });

  useEffect(() => setDirectFailed(false), [src]);
  useEffect(() => {
    if (resolved.kind !== "workspace" || !loadWorkspaceImage) {
      setWorkspaceState({ kind: resolved.kind === "workspace" ? "error" : "loading" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let active = true;
    setWorkspaceState({ kind: "loading" });
    void loadWorkspaceImage(resolved.path, controller.signal).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setWorkspaceState({ kind: "loaded", url: objectUrl });
    }).catch(() => {
      if (active) setWorkspaceState({ kind: "error" });
    });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loadWorkspaceImage, resolved]);

  if (resolved.kind === "unsupported" || (resolved.kind === "workspace" && !loadWorkspaceImage)) {
    return <MarkdownImageFailure alt={alt} onOpenArtifacts={onOpenArtifacts} source={src} />;
  }
  if (resolved.kind === "direct") {
    return directFailed
      ? <MarkdownImageFailure alt={alt} onOpenArtifacts={onOpenArtifacts} source={src} />
      : <img {...props} alt={alt ?? ""} onError={() => setDirectFailed(true)} src={resolved.src} />;
  }
  if (workspaceState.kind === "loaded") {
    return <img {...props} alt={alt ?? ""} onError={() => {
      URL.revokeObjectURL(workspaceState.url);
      setWorkspaceState({ kind: "error" });
    }} src={workspaceState.url} />;
  }
  if (workspaceState.kind === "error") {
    return <MarkdownImageFailure alt={alt} onOpenArtifacts={onOpenArtifacts} source={src} />;
  }
  return (
    <span aria-label={t("markdown.loadingImage", { label: imageLabel(alt, src) })} className="markdown-image-state loading" role="status">
      {t("markdown.loadingImage", { label: imageLabel(alt, src) })}
    </span>
  );
}

/** Renders untrusted model and workspace Markdown without enabling raw HTML. */
export function MarkdownRenderer({
  className,
  content,
  loadWorkspaceImage,
  onChipClick,
  onOpenArtifacts,
  references,
  workspaceSessionId,
}: MarkdownRendererProps) {
  const chipIndex = useMemo(() => buildChipIndex(references), [references]);
  const components = useMemo<Components>(() => ({
    a: ({ href, node: _node, ...props }) => {
      const external = href?.startsWith("http://") || href?.startsWith("https://");
      if (href?.startsWith("graph://")) {
        // A chip: parse kind/id, render as a button, call onChipClick.
        const [, kind, id] = href.match(/^graph:\/\/([^/]+)\/(.+)$/) ?? [];
        const reference: ComposerReference | undefined = kind && id
          ? { id, kind: kind as ComposerReference["kind"], label: props.children as string }
          : undefined;
        const label = reference ? KIND_TO_LABEL[reference.kind] : undefined;
        return (
          <button
            className="graph-chip"
            disabled={!onChipClick || !reference || !label}
            onClick={() => reference && onChipClick?.(reference)}
            type="button"
          >{props.children}</button>
        );
      }
      return <a {...props} href={href} rel={external ? "noreferrer" : undefined} target={external ? "_blank" : undefined} />;
    },
    img: ({ node: _node, ...props }) => (
      <MarkdownImage
        {...props}
        loadWorkspaceImage={loadWorkspaceImage}
        onOpenArtifacts={onOpenArtifacts}
        workspaceSessionId={workspaceSessionId}
      />
    ),
    pre: ({ children, node: _node, ...props }) => {
      const preRef = useRef<HTMLPreElement>(null);
      return (
        <div className="markdown-code">
          <pre {...props} ref={preRef}>{children}</pre>
          <CopyButton className="code-copy" getText={() => preRef.current?.textContent ?? ""} label="Copy code" />
        </div>
      );
    },
    table: ({ children, node: _node, ...props }) => (
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    ),
  }), [loadWorkspaceImage, onChipClick, onOpenArtifacts, workspaceSessionId]);
  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <Markdown
        components={components}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        remarkPlugins={[remarkGfm, remarkMath, remarkEvidenceCitations, [remarkGraphChips, { index: chipIndex }]]}
        urlTransform={preserveGraphChipUrls}
      >
        {content}
      </Markdown>
    </div>
  );
}
