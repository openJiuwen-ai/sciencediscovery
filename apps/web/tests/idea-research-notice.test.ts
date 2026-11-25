// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import {
  IDEA_RESEARCH_EXPECTED_EVENT,
  announceAttachedRun,
  armIdeaResearchCard,
  asksForIdeaResearch,
} from "../src/ideaResearchNotice.js";

/** The helpers dispatch on `window`, which a browser test has to provide. */
function installWindow(): { restore: () => void; seen: string[] } {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const seen: string[] = [];
  const browser = Object.assign(new EventTarget(), {
    setInterval: (callback: () => void, ms: number) => globalThis.setInterval(callback, ms),
    clearInterval: (id: number) => globalThis.clearInterval(id),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  browser.addEventListener(IDEA_RESEARCH_EXPECTED_EVENT, (event: Event) => {
    seen.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
  });
  return {
    seen,
    restore: () => {
      if (previous === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.defineProperty(globalThis, "window", previous);
    },
  };
}

test("only an /idea-tree command asks for an Idea Tree research", () => {
  // The composer arms the card on the command the agent will act on. A message
  // that merely mentions it, or another slash command, must not keep the card
  // reading the list for ten minutes.
  assert.equal(asksForIdeaResearch("/idea-tree explore low-cost catalysts"), true);
  assert.equal(asksForIdeaResearch("  /idea-tree-team explore low-cost catalysts"), true);
  assert.equal(asksForIdeaResearch("/idea-tree"), true);
  assert.equal(asksForIdeaResearch("/web-usage"), false);
  assert.equal(asksForIdeaResearch("please /idea-tree this later"), false);
  assert.equal(asksForIdeaResearch("/idea-trees are interesting"), false);
});

test("attaching to a Session that replayed a created event arms the card", () => {
  // This is the case the card cannot see: the created event is in the replay the
  // client just read, and the live stream starts after it.
  const window = installWindow();
  try {
    announceAttachedRun("s1", [{ event: { type: "run.status" } }, { event: { type: "idea_research.created" } }], null);
    assert.deepEqual(window.seen, ["s1"]);
  } finally {
    window.restore();
  }
});

test("attaching to an active run arms the card even when the replay is empty", () => {
  // A research started by another client may predate the replay window entirely;
  // the active run is enough to know one may exist.
  const window = installWindow();
  try {
    announceAttachedRun("s2", [], { id: "run-1" });
    assert.deepEqual(window.seen, ["s2"]);
  } finally {
    window.restore();
  }
});

test("an ordinary refresh of a Session with no run does not wake the card", () => {
  const window = installWindow();
  try {
    announceAttachedRun("s3", [{ event: { type: "run.status" } }], null);
    assert.deepEqual(window.seen, []);
    armIdeaResearchCard("s4");
    assert.deepEqual(window.seen, ["s4"], "a command arms it directly");
  } finally {
    window.restore();
  }
});
