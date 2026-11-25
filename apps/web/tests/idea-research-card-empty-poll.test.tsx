// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { IdeaResearchCard } from "../src/IdeaResearchCard.js";
import type { ApiClient } from "../src/api/client.js";

/** A client whose list is empty until `appears()`, and which never emits the
 *  created event — the state a reloaded or reconnected client is in. */
function stubClient(appears: () => boolean) {
  let reads = 0;
  const view = {
    research: {
      id: "research-1",
      objective: "Explore low-cost catalysts",
      status: "running",
      phase: "ideate",
      round: 1,
      settings: { maxRounds: 3 },
      activities: [],
    },
    graph: { nodes: [], edges: [], objective: "", revision: 0, treeId: "", updatedAt: "" },
  };
  return {
    reads: () => reads,
    client: {
      listIdeaResearch: async () => {
        reads += 1;
        return { items: appears() ? [view] : [] };
      },
      // The card follows the active research over SSE once one exists; this test
      // only cares about the list arriving, so the stream stays open and silent.
      subscribeIdeaResearch: async () => new Promise<void>(() => undefined),
    } as unknown as ApiClient,
  };
}

/** The card is a browser component: it reads `window.setTimeout`. */
function installWindow(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previous);
  };
}

/** A list read is a promise: let it settle before judging what is drawn. */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  }
}

test("a research that appears without its created event still reaches the card", async (context) => {
  // The card used to re-read the list only when `idea_research.created` arrived
  // on the run stream, so a client that was not listening at that moment (a
  // reload, a reconnect, a late attach) never showed the research at all. The
  // real L4 journey failed exactly that way: the command ran, the research
  // existed, and the card stayed absent for its whole wait.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restoreWindow = installWindow();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let present = false;
  const { client, reads } = stubClient(() => present);

  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IdeaResearchCard, { client, sessionId: "s1", onError: () => undefined }));
  });
  try {
    // The empty first read draws nothing: no research, no card.
    const panels = () => view!.root.findAllByProps({ className: "idea-research-panel" }).length;
    assert.equal(panels(), 0);
    const afterMount = reads();
    assert.equal(afterMount, 1);

    // The research starts server-side; no event is delivered.
    present = true;
    await act(async () => { context.mock.timers.tick(5_000); });
    await settle();

    assert.ok(reads() > afterMount, "the empty list is re-read on its own timer");
    assert.equal(panels(), 1, "the card appears once the research exists");
    const whileShown = reads();
    await act(async () => { context.mock.timers.tick(60_000); });
    await settle();
    assert.equal(reads(), whileShown, "an item stops the re-read");
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
    restoreWindow();
  }
});

test("an idle Session slows down and then stops asking", async (context) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restoreWindow = installWindow();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { client, reads } = stubClient(() => false);

  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IdeaResearchCard, { client, sessionId: "s1", onError: () => undefined }));
  });
  try {
    // Two minutes at the fast cadence: a research that is starting should reach
    // the card within five seconds of existing. The clock is advanced one
    // interval at a time, because a single large tick replays every callback at
    // the same instant and would say nothing about the cadence.
    for (let i = 0; i < 24; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    const afterFast = reads();
    assert.ok(afterFast > 20, `it polls every five seconds while a research could be starting (saw ${afterFast})`);

    // Then the same window at a twelfth of that cadence, so a slow start does not
    // cost a request every five seconds for ten minutes.
    const beforeSlow = reads();
    for (let i = 0; i < 12; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    const inSlowMinute = reads() - beforeSlow;
    assert.ok(inSlowMinute >= 1 && inSlowMinute <= 3, `after two minutes it slows to about one read per 30s (saw ${inSlowMinute} in a minute)`);

    // The window matches the 600s the journey allows a research to be created:
    // past it the card stops rather than asking forever.
    for (let i = 0; i < 90; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    const atStop = reads();
    for (let i = 0; i < 12; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    await settle();
    assert.equal(reads(), atStop, "the poll stopped on its own");
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
    restoreWindow();
  }
});

test("a caller that passes a fresh callback on every render does not reset the window", async (context) => {
  // `onResearchAvailability` is a dependency of the card's `load`, so a caller
  // that writes it inline (a new function per render) gives `load` a new identity
  // on every render — and with the window anchored in an effect body, each poll
  // would restart it and the timer would never stop. The window is held in a ref
  // and the timer is installed once, so it survives that.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restoreWindow = installWindow();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { client, reads } = stubClient(() => false);

  const element = () => createElement(IdeaResearchCard, {
    client,
    sessionId: "s1",
    onError: () => undefined,
    onResearchAvailability: (_available: boolean) => undefined,
  });
  let view: ReactTestRenderer;
  await act(async () => { view = create(element()); });
  try {
    // Six polls, each followed by a render that hands over a new callback.
    for (const _ of [1, 2, 3, 4, 5, 6]) {
      await act(async () => { context.mock.timers.tick(5_000); });
      await act(async () => { view!.update(element()); });
      await settle();
    }
    const whileWaiting = reads();
    assert.ok(whileWaiting > 1, "it still polls while a research could be starting");
    // Past the ten-minute window the timer must stop for good, whatever the
    // caller does with the callback's identity.
    await act(async () => { context.mock.timers.tick(10 * 60_000); });
    const atStop = reads();
    await act(async () => { context.mock.timers.tick(60_000); });
    await act(async () => { view!.update(element()); });
    await settle();
    assert.equal(reads(), atStop, "the window is not restarted by a new callback identity");
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
    restoreWindow();
  }
});
