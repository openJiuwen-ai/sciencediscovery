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
 * Agent memory review panel (V3-C1): the human gate over experiential
 * candidates written by the agent_memory tool or the background reviewer.
 * The machine never self-certifies — only promote() here turns a candidate
 * into a verified rule the system prompt may carry.
 */

import { useCallback, useEffect, useState } from "react";
import type { AgentMemoryCategory, AgentMemoryEntry } from "@sciencediscovery/schema";
import { agentMemoryReliabilityLabel } from "@sciencediscovery/schema";

import type { ApiClient } from "./api/client.js";

const CATEGORY_LABELS: Record<AgentMemoryCategory, string> = {
  convention: "Convention",
  lesson_learned: "Lesson learned",
  tool_technique: "Tool technique",
  workflow: "Workflow",
};

type Filter = "pending" | "verified" | "stale" | "all";

function isPending(entry: AgentMemoryEntry): boolean {
  return entry.status === "active" && entry.provenance?.requiresReview === true;
}

export function AgentMemoryPanel({
  client,
  onError,
}: {
  client: ApiClient;
  onError: (message: string) => void;
}) {
  const [entries, setEntries] = useState<AgentMemoryEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [busyId, setBusyId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editContent, setEditContent] = useState("");

  const refresh = useCallback(async () => {
    try {
      setEntries(await client.listAgentMemories());
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not load agent memories");
    }
  }, [client, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await action();
      await refresh();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Agent memory action failed");
    } finally {
      setBusyId(undefined);
    }
  };

  const visible = entries.filter((entry) => {
    if (filter === "pending") return isPending(entry);
    if (filter === "verified") return entry.status === "active" && !isPending(entry);
    if (filter === "stale") return entry.status === "stale";
    return true;
  });

  const pendingCount = entries.filter(isPending).length;

  return <section className="skill-section">
    <div className="skill-section-header">
      <h4>Agent memory{pendingCount ? ` (${pendingCount} pending review)` : ""}</h4>
      <p className="skill-empty">
        Experiential notes proposed by the agent or the background reviewer. Nothing reaches future
        prompts until a human promotes it here.
      </p>
      <div className="skill-manager-tabs" role="tablist">
        {(["pending", "verified", "stale", "all"] as const).map((value) => (
          <button
            aria-selected={filter === value}
            className={filter === value ? "active" : ""}
            key={value}
            onClick={() => setFilter(value)}
            role="tab"
            type="button"
          >{value}</button>
        ))}
        <button onClick={() => void refresh()} type="button">Refresh</button>
      </div>
    </div>
    {!visible.length ? <p className="skill-empty">No entries.</p> : null}
    {visible.map((entry) => {
      const label = agentMemoryReliabilityLabel(entry.confidence, entry.provenance);
      const busy = busyId === entry.id;
      return <div className="skill-card" key={entry.id}>
        <div className="skill-card-header">
          <strong>{CATEGORY_LABELS[entry.category]}</strong>
          <span className="skill-meta">
            {label.trim()} · {entry.provenance?.kind ?? "manual"} · {entry.status}
            {entry.reviewedAt ? ` · reviewed ${entry.reviewedAt.slice(0, 10)}` : ""}
          </span>
        </div>
        {editingId === entry.id
          ? <div>
              <textarea
                onChange={(event) => setEditContent(event.target.value)}
                rows={3}
                value={editContent}
              />
              <div className="skill-actions">
                <button
                  disabled={busy || !editContent.trim()}
                  onClick={() => {
                    void act(entry.id, async () => {
                      await client.supersedeAgentMemory(entry.id, { content: editContent.trim() });
                      setEditingId(undefined);
                    });
                  }}
                  type="button"
                >Save as superseding entry</button>
                <button onClick={() => setEditingId(undefined)} type="button">Cancel</button>
              </div>
            </div>
          : <p>{entry.content}</p>}
        <div className="skill-actions">
          {isPending(entry) ? <button
            disabled={busy}
            onClick={() => void act(entry.id, () => client.promoteAgentMemory(entry.id))}
            type="button"
          >Promote</button> : null}
          {entry.status === "active" ? <button
            disabled={busy}
            onClick={() => {
              setEditingId(entry.id);
              setEditContent(entry.content);
            }}
            type="button"
          >Edit (supersede)</button> : null}
          {entry.status === "active" ? <button
            disabled={busy}
            onClick={() => void act(entry.id, () => client.markAgentMemoryStale(entry.id))}
            type="button"
          >Mark stale</button> : null}
          <button
            disabled={busy}
            onClick={() => void act(entry.id, () => client.deleteAgentMemory(entry.id))}
            type="button"
          >Delete</button>
        </div>
      </div>;
    })}
  </section>;
}
