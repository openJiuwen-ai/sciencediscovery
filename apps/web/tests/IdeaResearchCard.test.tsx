import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
import { IdeaResearchCard } from "../src/IdeaResearchCard.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("research availability stays unknown until loading succeeds; initial errors allow retry", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  const availability: boolean[] = [];
  let reject!: (error: Error) => void;
  let attempts = 0;
  const client = {
    listIdeaResearch: () => ++attempts === 1
      ? new Promise((_, fail) => { reject = fail; })
      : Promise.resolve({ items: [] }),
  } as unknown as ApiClient;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(createElement(IdeaResearchCard, {
        client, sessionId: "session", onError: () => {},
        onResearchAvailability: available => availability.push(available),
      }));
    });
    assert.deepEqual(availability, []);
    await act(async () => reject(new Error("list unavailable")));
    assert.deepEqual(availability, []);
    assert.match(JSON.stringify(renderer.root.findByProps({ role: "alert" }).children.map(c => typeof c === "string" ? c : "")), /list unavailable/);
    assert.equal(renderer.root.findByType("button").props.className, "secondary-button compact-button");
    await act(async () => renderer.root.findByType("button").props.onClick());
    assert.deepEqual(availability, [false]);
    assert.equal(renderer.toJSON(), null);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test('IdeaTree unknown usage displays admission reserve separately from measured token counts', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: any;
  try {
    const research = { id: 'r', status: 'completed', objective: 'synthetic', phase: 'completed', round: 1, settings: { maxRounds: 1 }, batch: [], batchCompleted: 0, tokens: 7, usageKnown: false, unreportedBudgetEstimate: 321 };
    const client = { listIdeaResearch: async () => ({ items: [{ research, graph: { treeId: 'r', nodes: [], edges: [] } }] }) };
    await act(async () => { renderer = create(createElement(IdeaResearchCard, { client: client as any, sessionId: 's', onError: () => undefined })); });
    await act(async () => { renderer.root.findByProps({ className: 'idea-tree-view' }).props.onClick(); });
    const rendered = JSON.stringify(renderer.toJSON()); assert.match(rendered, /321/); assert.match(rendered, /7/); assert.ok(!rendered.includes('undefined'));
  } finally { if (renderer) await act(async () => renderer.unmount()); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});
