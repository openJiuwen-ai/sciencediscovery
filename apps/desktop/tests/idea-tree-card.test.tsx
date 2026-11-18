// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { IdeaResearchView } from "@sciencediscovery/schema";
import { IdeaResearchCard, ideaCardTitle } from "../src/views/idea/IdeaResearchCard.js";
import { TEXT } from "../src/text.js";

const t = TEXT.ideaTree;

function view(patch: Partial<IdeaResearchView["research"]> = {}): IdeaResearchView {
  return {
    research: {
      id: "research-1", objective: "提升水处理膜的膜通量，同时保持截留率", status: "running", phase: "building_tree",
      round: 2, batch: ["a", "b", "c", "d"], batchCompleted: 1, tokens: 0, usageKnown: false,
      reason: null, modelId: "model-x", currentNodeId: null,
      settings: { maxRounds: 3, candidatesPerRound: 2, maxSearchRounds: 2, maxNodes: 20, maxDepth: 3, maxActiveDirections: 2, pruneThreshold: 0.2 },
      ...patch,
    },
    graph: { edges: [], nodes: [], objective: "提升水处理膜的膜通量，同时保持截留率", revision: 1, treeId: "tree-1", updatedAt: "2026-11-18T00:00:00Z" },
  };
}

test("the whole card is the way into the panel, like a search card", async () => {
  const opened: string[] = [];
  let card!: ReactTestRenderer;
  await act(async () => {
    card = create(React.createElement(IdeaResearchCard, { onOpen: (id) => opened.push(id), view: view() }));
  });
  const buttons = card.root.findAll((node) => node.type === "button");
  assert.equal(buttons.length, 1, "one button: the card itself, no control beside it");
  await act(async () => { buttons[0]!.props.onClick(); });
  assert.deepEqual(opened, ["research-1"]);
  card.unmount();
});

test("the card carries the engine's phase, round, batch and an honest token count", async () => {
  let card!: ReactTestRenderer;
  await act(async () => { card = create(React.createElement(IdeaResearchCard, { onOpen: () => undefined, view: view() })); });
  const text = JSON.stringify(card.toJSON());
  assert.ok(text.includes(t.phase.building_tree));
  assert.ok(text.includes(t.round(2)));
  assert.ok(text.includes(t.batch(1, 4)));
  assert.ok(text.includes(t.tokensUnknown), "reported as unknown, not as 0");
  assert.equal(text.includes("0 tokens"), false);
  assert.equal(text.includes(t.open), false, "no \"open the panel\" control");
});

test("a live research shows the working state, a finished one its own status", async () => {
  let liveCard!: ReactTestRenderer;
  let doneCard!: ReactTestRenderer;
  await act(async () => { liveCard = create(React.createElement(IdeaResearchCard, { onOpen: () => undefined, view: view() })); });
  await act(async () => { doneCard = create(React.createElement(IdeaResearchCard, { onOpen: () => undefined, view: view({ status: "completed", usageKnown: true, tokens: 268290 }) })); });
  const live = JSON.stringify(liveCard.toJSON());
  assert.ok(live.includes(TEXT.evolve.working));
  const done = JSON.stringify(doneCard.toJSON());
  assert.ok(done.includes(t.status.completed));
  assert.equal(done.includes(TEXT.evolve.working), false);
  assert.ok(done.includes(t.tokens(268290)));
});

test("the title is the objective folded to one short line", () => {
  assert.equal(ideaCardTitle("  提升   水处理膜的膜通量 "), "提升 水处理膜的膜通量");
  assert.ok(Array.from(ideaCardTitle("研究".repeat(40))).length <= 28);
  assert.equal(ideaCardTitle("   "), t.heading);
});
