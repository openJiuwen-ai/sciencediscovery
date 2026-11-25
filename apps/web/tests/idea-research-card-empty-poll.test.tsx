// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { IdeaResearchCard } from "../src/IdeaResearchCard.js";
import { armIdeaResearchCard } from "../src/ideaResearchNotice.js";
import type { ApiClient } from "../src/api/client.js";

/** One research as the list endpoint returns it. */
function researchView(id: string, objective: string) {
  return {
    research: {
      id,
      objective,
      status: "running",
      phase: "ideate",
      round: 1,
      settings: { maxRounds: 3 },
      activities: [],
    },
    graph: { nodes: [], edges: [], objective: "", revision: 0, treeId: "", updatedAt: "" },
  };
}

/** A client whose list is whatever `items()` returns at the moment of the read,
 *  and which never emits the created event — the state a reloaded, reconnected
 *  or late-attaching client is in. */
function stubClient(items: () => Array<ReturnType<typeof researchView>>) {
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      listIdeaResearch: async () => {
        reads += 1;
        return { items: items() };
      },
      // The card follows the active research over SSE once one exists; these
      // tests only care about the list arriving, so the stream stays silent.
      subscribeIdeaResearch: async () => new Promise<void>(() => undefined),
    } as unknown as ApiClient,
  };
}

/** The card is a browser component: it reads `window.setInterval`. */
function installWindow(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = Object.assign(new EventTarget(), {
    setInterval: (callback: () => void, ms: number) => globalThis.setInterval(callback, ms),
    clearInterval: (id: number) => globalThis.clearInterval(id),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previous);
  };
}

/** The list read is a promise: let it settle before judging what is drawn. */
async function settle(): Promise<void> {
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
  let items: Array<ReturnType<typeof researchView>> = [];
  const { client, reads } = stubClient(() => items);

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
    items = [researchView("research-1", "Explore low-cost catalysts")];
    await act(async () => { context.mock.timers.tick(5_000); });
    await settle();

    assert.ok(reads() > afterMount, "the empty list is re-read on its own timer");
    assert.equal(panels(), 1, "the card appears once the research exists");
    // And once there is an item the read stops: a list that already has a
    // research is not re-read every five seconds.
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
  const { client, reads } = stubClient(() => []);

  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IdeaResearchCard, { client, sessionId: "s1", onError: () => undefined }));
  });
  try {
    // Two minutes at the fast cadence: a research that is starting should reach
    // the card within five seconds of it existing. The clock is advanced one
    // interval at a time, because a single large tick replays every callback at
    // the same instant and would say nothing about the cadence.
    for (let i = 0; i < 24; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    const afterFast = reads();
    assert.ok(afterFast > 20, `it polls every five seconds while a research could be starting (saw ${afterFast})`);
    // Then the same window at a twelfth of the cadence, so a longer wait for a
    // research does not cost a request every five seconds for ten minutes.
    const beforeSlowMinute = reads();
    for (let i = 0; i < 12; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    const inSlowMinute = reads() - beforeSlowMinute;
    assert.ok(inSlowMinute >= 1 && inSlowMinute <= 3, `after two minutes it slows to about one read per 30s (saw ${inSlowMinute} in a minute)`);
    // The window matches the 600s the journey allows a research to be created:
    // past it the card stops asking rather than asking forever.
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
  // that writes it inline (a new function per render) would give `load` a new
  // identity on every render. The window is held in refs and the chain is
  // installed once, so it survives that and still ends.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restoreWindow = installWindow();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { client, reads } = stubClient(() => []);

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
    // Past the ten-minute window the card must stop for good, whatever the
    // caller does with the callback's identity.
    for (let i = 0; i < 120; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    const atStop = reads();
    for (let i = 0; i < 12; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    await act(async () => { view!.update(element()); });
    await settle();
    assert.equal(reads(), atStop, "the window is not restarted by a new callback identity");
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
    restoreWindow();
  }
});

test("a command sent into a Session that has been open for a long time opens a new window", async (context) => {
  // The window used to be anchored at the card's mount, and a Session can stay
  // open for hours before an `/idea-tree` command is sent. With that anchor the
  // window was already spent, so a research created after the command — and whose
  // created event this client missed — never reached the card.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restoreWindow = installWindow();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let items: Array<ReturnType<typeof researchView>> = [];
  const { client, reads } = stubClient(() => items);

  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IdeaResearchCard, { client, sessionId: "s1", onError: () => undefined }));
  });
  try {
    // Nothing happens for eleven minutes: the mount-time window is spent and the
    // card is quiet.
    for (let i = 0; i < 132; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    await settle();
    const quiet = reads();
    for (let i = 0; i < 12; i += 1) await act(async () => { context.mock.timers.tick(5_000); });
    await settle();
    assert.equal(reads(), quiet, "an idle card stops asking");

    // The user sends the command now; the composer arms the card from this moment.
    items = [researchView("research-late", "A research started late in the Session")];
    await act(async () => { armIdeaResearchCard("s1"); });
    await act(async () => { context.mock.timers.tick(5_000); });
    await settle();

    assert.ok(reads() > quiet, "the command opened a new window");
    assert.equal(view!.root.findAllByProps({ className: "idea-research-panel" }).length, 1, "the research started after the command is drawn");
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
    restoreWindow();
  }
});

test("a second research created while the client was away is drawn", async (context) => {
  // The card used to stop re-reading as soon as the list held anything, so a
  // Session that already had one research never learned about the next one if it
  // missed that created event. An expectation after the command keeps the window
  // open and the list is re-read even though it is not empty.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restoreWindow = installWindow();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let items = [researchView("research-1", "The first research")];
  const { client, reads } = stubClient(() => items);

  let view: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(IdeaResearchCard, { client, sessionId: "s1", onError: () => undefined }));
  });
  try {
    await settle();
    const drawn = () => JSON.stringify(view!.toJSON());
    assert.match(drawn(), /The first research/);
    const beforeSecond = reads();
    await act(async () => { context.mock.timers.tick(60_000); });
    await settle();
    assert.equal(reads(), beforeSecond, "a filled list is not polled without an expectation");

    // Another client starts a second research; this client only knows that one
    // may be on its way. The list is newest first, so the second becomes visible.
    items = [researchView("research-2", "The second research"), researchView("research-1", "The first research")];
    await act(async () => { armIdeaResearchCard("s1"); });
    await act(async () => { context.mock.timers.tick(5_000); });
    await settle();

    assert.ok(reads() > beforeSecond, "the expectation re-reads a list that is not empty");
    assert.match(drawn(), /The second research/, "the second research is drawn");
  } finally {
    await act(async () => view!.unmount());
    context.mock.timers.reset();
    restoreWindow();
  }
});
