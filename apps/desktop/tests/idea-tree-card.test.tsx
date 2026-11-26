// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { IdeaResearchView } from "@sciencediscovery/schema";
import { evolveShortTitle } from "../src/evolve/model.js";
import { TITLE_COLUMNS, columnsOf } from "../src/text/columns.js";
import { IdeaResearchCard, IdeaResearchCards, ideaCardTitle } from "../src/views/idea/IdeaResearchCard.js";
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

test("each card in a session of several opens its own research", async () => {
  const opened: string[] = [];
  let cards!: ReactTestRenderer;
  await act(async () => {
    cards = create(React.createElement(IdeaResearchCards, {
      onOpen: (id) => opened.push(id),
      views: [view(), view({ id: "research-2", objective: "第二个研究" })],
    }));
  });
  const buttons = cards.root.findAll((node) => node.type === "button");
  assert.equal(buttons.length, 2, "one card per research, in list order");
  await act(async () => { buttons[1]!.props.onClick(); });
  assert.deepEqual(opened, ["research-2"]);
  cards.unmount();
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
  assert.equal(ideaCardTitle("第一行\n第二行\t结尾"), "第一行 第二行 结尾", "newlines and runs of whitespace fold to one line");
  assert.equal(ideaCardTitle("   "), t.heading);
  assert.equal(ideaCardTitle("提升膜通量"), "提升膜通量");
  assert.equal(ideaCardTitle("提升膜通量").includes("…"), false, "a title that fits carries no cut mark");
});

test("a long objective is cut by printed width and the cut is marked", () => {
  const objective = "评估不同预处理工艺对水处理膜通量衰减的影响并给出最优参数组合与运行条件";
  const title = ideaCardTitle(objective);
  assert.equal(title.endsWith("…"), true, "the marker tells the reader the objective continues");
  const shown = title.slice(0, -1);
  assert.equal(objective.startsWith(shown), true);
  assert.equal(shown.length, TITLE_COLUMNS / 2, "32 CJK characters: 64 columns, not 64 code points");
  assert.equal(Array.from(shown).every((char) => columnsOf(char) === 2), true);
  assert.equal(title, evolveShortTitle(objective), "the search card beside it follows the same rule");
});

test("the card shortens its visible label but its tooltip keeps the whole objective", async () => {
  const objective = "评估不同预处理工艺对水处理膜通量衰减的影响并给出最优参数组合与运行条件";
  let card!: ReactTestRenderer;
  await act(async () => { card = create(React.createElement(IdeaResearchCard, { onOpen: () => undefined, view: view({ objective }) })); });
  const button = card.root.findAll((node) => node.type === "button")[0]!;
  assert.equal(String(button.props.title).includes(objective), true, "the tooltip still carries the objective in full");
  const labels = card.root.findAll((node) => node.type === "span" && node.props.className === "evolve-run-title");
  assert.equal(labels.length, 1);
  const rendered = String(labels[0]!.children.join(""));
  assert.equal(rendered, ideaCardTitle(objective));
  assert.equal(rendered.endsWith("…"), true, "what the reader sees is marked at the cut");
  card.unmount();
});
