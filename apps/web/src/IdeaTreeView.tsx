// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { IdeaResearchCard } from "./IdeaResearchCard.js";
import { useCallback, useEffect, useRef, useState } from "react";

import type { IdeaTreeGraph } from "@sciencediscovery/schema";

import type { ApiClient } from "./api.js";
import { StructureIcon } from "./icons.js";
import { IdeaTreeExplorer } from "./IdeaTreeExplorer.js";

const IDEA_TREE_POLL_MS = 5_000;

export function sameIdeaTreeGraphSnapshot(
  current: IdeaTreeGraph | null,
  incoming: IdeaTreeGraph | null,
): boolean {
  if (current === incoming) return true;
  if (!current || !incoming) return false;
  return current.treeId === incoming.treeId
    && current.revision === incoming.revision
    && current.updatedAt === incoming.updatedAt;
}

function sameTreeIds(current: string[], incoming: string[]): boolean {
  return current.length === incoming.length && current.every((treeId, index) => treeId === incoming[index]);
}

function LegacyIdeaTreeView({
  client,
  onOpenArtifact,
  onOpenSubagent,
  onError,
  refreshKey,
  sessionId,
}: {
  client: ApiClient;
  onOpenArtifact?: (id: string) => void;
  onOpenSubagent?: (id: string) => void;
  onError: (message: string) => void;
  refreshKey: string;
  sessionId: string;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [graph, setGraph] = useState<IdeaTreeGraph | null>(null);
  const [hasIdeaTreeRun, setHasIdeaTreeRun] = useState<boolean>();
  const [treeIds, setTreeIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingSequence = useRef(0);
  const requestSequence = useRef(0);
  const selectedTreeId = useRef<string | undefined>(undefined);

  const load = useCallback(async (
    treeId?: string,
    { reportFailure = true, showLoading = false }: { reportFailure?: boolean; showLoading?: boolean } = {},
  ) => {
    if (treeId) selectedTreeId.current = treeId;
    const sequence = ++requestSequence.current;
    if (showLoading) {
      loadingSequence.current = sequence;
      setLoading(true);
    }
    try {
      const result = await client.getIdeaTreeGraph(sessionId, treeId);
      if (sequence !== requestSequence.current) return;
      setLoadError(null);
      setGraph((current) => sameIdeaTreeGraphSnapshot(current, result.graph) ? current : result.graph);
      setHasIdeaTreeRun(result.hasIdeaTreeRun);
      setTreeIds((current) => sameTreeIds(current, result.treeIds) ? current : result.treeIds);
    } catch (error) {
      if (sequence === requestSequence.current) setLoadError(error instanceof Error ? error.message : "Could not load Idea Tree");
      if (sequence === requestSequence.current && reportFailure) {
        onError(error instanceof Error ? error.message : "Could not load Idea Tree");
      }
    } finally {
      if (showLoading && loadingSequence.current === sequence) setLoading(false);
    }
  }, [client, onError, sessionId]);

  useEffect(() => {
    requestSequence.current += 1;
    loadingSequence.current = 0;
    selectedTreeId.current = undefined;
    setLoading(false);
    setGraph(null);
    setLoadError(null);
    setHasIdeaTreeRun(undefined);
    setTreeIds([]);
  }, [sessionId]);

  useEffect(() => {
    void load(selectedTreeId.current);
    // refreshKey deliberately retriggers immediately after visible Run changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  useEffect(() => {
    if (hasIdeaTreeRun === false) return;
    const timer = setInterval(() => void load(selectedTreeId.current, { reportFailure: false }), IDEA_TREE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasIdeaTreeRun, load]);

  if (loadError) return <div role="alert">{loadError} <button type="button" onClick={() => void load(selectedTreeId.current)}>Retry Idea Tree</button></div>;
  if (!graph) return null;
  const completed = graph.nodes.filter((node) => node.status === "done").length;
  const running = graph.nodes.filter((node) => node.status === "running").length;

  return <>
    <button className="idea-tree-view" onClick={() => setOpen(true)} type="button">
      <span className="idea-tree-view-header">
        <span><StructureIcon size={16} /><strong>Idea Tree</strong></span>
        <em>revision {graph.revision}</em>
      </span>
      <span className="idea-tree-view-objective">{graph.objective}</span>
      <span className="idea-tree-view-stats">
        {graph.nodes.length} nodes · {graph.edges.length} branches · {completed} done
        {running ? <i>{running} running</i> : null}
      </span>
      <span className="idea-tree-view-action">查看旧树（只读） →</span>
    </button>
    {open ? <IdeaTreeExplorer
      graph={graph}
    onOpenArtifact={(id) => { setOpen(false); onOpenArtifact?.(id); }}
    onOpenSubagent={(id) => { setOpen(false); onOpenSubagent?.(id); }}
      loading={loading}
      onClose={() => setOpen(false)}
      onSelectTree={(treeId) => void load(treeId, { showLoading: true })}
      treeIds={treeIds}
    /> : null}
  </>;
}

export function IdeaTreeView(props: Parameters<typeof LegacyIdeaTreeView>[0]) {
  return <><IdeaResearchCard key={props.sessionId} client={props.client} sessionId={props.sessionId} onError={props.onError} /><LegacyIdeaTreeView {...props} /></>;
}
