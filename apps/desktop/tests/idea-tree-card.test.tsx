// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { IdeaResearchView } from "@sciencediscovery/schema";
import { IdeaResearchCard, ideaControls } from "../src/views/idea/IdeaResearchCard.js";
import { TEXT } from "../src/text.js";

function view(patch: Partial<IdeaResearchView["research"]> = {}): IdeaResearchView {
  return {
    research: {
      id: "research-1", objective: "提升膜通量", status: "running", phase: "building_tree",
      round: 2, batch: ["a", "b", "c", "d"], batchCompleted: 1, tokens: 0, usageKnown: false,
      reason: null, modelId: "model-x", currentNodeId: null,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
      ...patch,
    },
    graph: { edges: [], nodes: [], objective: "提升膜通量", revision: 1, treeId: "tree-1", updatedAt: "2026-11-18T00:00:00Z" },
  };
}

test("unreported token usage stays unreported, not zero", () => {
  const html = renderToStaticMarkup(React.createElement(IdeaResearchCard, { view: view() }));
  assert.ok(html.includes(TEXT.ideaTree.tokensUnknown), "the card says usage is not reported");
  assert.equal(html.includes("0 tokens"), false);
});

test("the card reports phase, round and batch progress from the engine", () => {
  const html = renderToStaticMarkup(React.createElement(IdeaResearchCard, { view: view() }));
  assert.ok(html.includes(TEXT.ideaTree.phase.building_tree));
  assert.ok(html.includes(TEXT.ideaTree.round(2)));
  assert.ok(html.includes(TEXT.ideaTree.batch(1, 4)));
});

test("an unknown engine phase is printed verbatim rather than mapped to a success", () => {
  const html = renderToStaticMarkup(React.createElement(IdeaResearchCard, { view: view({ phase: "engine_only_phase" as never }) }));
  assert.ok(html.includes("engine_only_phase"));
});

test("controls follow the status and never offer to start a research", () => {
  assert.deepEqual(ideaControls("running"), { pause: true, resume: false, end: true });
  assert.deepEqual(ideaControls("paused"), { pause: false, resume: true, end: true });
  assert.deepEqual(ideaControls("completed"), { pause: false, resume: false, end: false });
  assert.deepEqual(ideaControls("ended"), { pause: false, resume: false, end: false });
});

test("a paused research offers continue, a completed one only opens", () => {
  const paused = renderToStaticMarkup(React.createElement(IdeaResearchCard, {
    view: view({ status: "paused" }), onResume: () => undefined, onEnd: () => undefined,
  }));
  // The status label 已暂停 contains 暂停, so match the control, not the text.
  assert.ok(paused.includes(`>${TEXT.ideaTree.resume}</button>`));
  assert.equal(paused.includes(`>${TEXT.ideaTree.pause}</button>`), false);

  const done = renderToStaticMarkup(React.createElement(IdeaResearchCard, {
    view: view({ status: "completed", usageKnown: true, tokens: 1200 }), onOpen: () => undefined,
    onPause: () => undefined, onResume: () => undefined, onEnd: () => undefined,
  }));
  assert.ok(done.includes(`>${TEXT.ideaTree.open}</button>`));
  assert.equal(done.includes(`>${TEXT.ideaTree.pause}</button>`), false);
  assert.equal(done.includes(`>${TEXT.ideaTree.end}</button>`), false);
  assert.ok(done.includes(TEXT.ideaTree.tokens(1200)));
});
