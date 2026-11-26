// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { IdeaResearchView } from "@sciencediscovery/schema";
import { ArtifactsApiClient } from "../src/api/artifacts.js";

function view(status: string, revision: number, updatedAt: string, insight: string): IdeaResearchView {
  return {
    research: {
      batch: [], batchCompleted: 0, currentNodeId: null, id: "research-1", modelId: "m", objective: "Objective",
      phase: "ideate", reason: null, round: 1, status: status as IdeaResearchView["research"]["status"],
      tokens: 10, usageKnown: true,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneMinAssessments: 3, pruneScoreGap: 2.5 },
    },
    graph: {
      edges: [], nodes: [{
        activeExecutionId: null, artifactRefs: [], attemptCount: 0, childrenIds: [], completedResultHandle: null,
        createdAt: "2026-11-18T00:00:00Z", depth: 0, hypothesis: "Goal", id: "ROOT", insight, lastExecutionId: null,
        parentId: null, priority: 0, pruneReason: null, score: null, searchStatus: "active", status: "done",
        updatedAt: "2026-11-18T00:00:00Z",
      }],
      objective: "Objective", revision, treeId: "research-1", updatedAt,
    },
  };
}

function frame(status: string, revision: number, updatedAt: string, graph: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ research: view(status, revision, updatedAt, "").research, graph: {
    edges: [], full: false, nodes: [], objective: "Objective", removed: [], revision, treeId: "research-1", updatedAt, ...graph,
  } })}\n\n`;
}

test("a gap filled by a whole read does not roll the web view back to the older frame", async () => {
  // The card renders whatever the stream last reported, so a rolled-back view would
  // show a finished research as live again until something else refreshed it.
  const body = [
    frame("running", 4, "2026-11-18T00:00:00Z", { full: true, nodes: [view("running", 4, "", "old").graph.nodes[0]] }),
    frame("running", 5, "2026-11-18T00:05:00Z", { since: 7, nodes: [view("running", 5, "", "stale").graph.nodes[0]] }),
    // Still queued behind the gap, and older than the read: applying it would roll
    // the card back to a live research the service has already paused.
    frame("pausing", 6, "2026-11-18T00:07:00Z", { since: 5, nodes: [view("pausing", 6, "", "older").graph.nodes[0]] }),
  ].join("");
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/events")) return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(view("paused", 7, "2026-11-18T00:10:00Z", "newer")), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as never;
  try {
    const client = new ArtifactsApiClient("token");
    const seen: IdeaResearchView[] = [];
    await client.subscribeIdeaResearch("s1", "research-1", (next) => seen.push(next), new AbortController().signal);
    assert.deepEqual(requests.map((url) => url.endsWith("/events") ? "events" : "read"), ["events", "read"],
      "the lost frame costs exactly one whole read");
    const last = seen.at(-1)!;
    assert.equal(last.research.status, "paused", "the state the read reported is not rolled back");
    assert.equal(last.graph.revision, 7);
    assert.equal(last.graph.updatedAt, "2026-11-18T00:10:00Z");
    assert.equal(last.graph.nodes.find((node) => node.id === "ROOT")!.insight, "newer", "the stale node is not re-applied");
    assert.equal(last.graph.revision, 7, "nor is it rolled back by the frame queued behind the gap");
  } finally {
    globalThis.fetch = original;
  }
});
