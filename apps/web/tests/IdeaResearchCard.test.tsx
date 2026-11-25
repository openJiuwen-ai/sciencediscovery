import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import type { ApiClient } from "../src/api.js";
import { IdeaResearchCard } from "../src/IdeaResearchCard.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { zhCN } from "../src/i18n/messages.js";

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

test('budget exhaustion is ended, explains the used/limit tokens, and offers no end or continue action', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: any;
  try {
    const budget = {
      id: 'r', status: 'budget_exhausted', objective: 'synthetic', phase: 'complete', round: 1,
      settings: { maxRounds: 1, maxTokens: 200000 }, batch: [], batchCompleted: 0,
      tokens: 180000, usageKnown: true,
      reason: 'Remaining token budget cannot fund the next stage. Used 180000 of 200000 tokens',
    };
    const render = async (research: Record<string, unknown>) => {
      const target = { listIdeaResearch: async () => ({ items: [{ research, graph: { treeId: 'r', nodes: [], edges: [] } }] }) };
      await act(async () => {
        renderer = create(createElement(LocaleProvider, { initialLocale: 'zh-CN' },
          createElement(IdeaResearchCard, { client: target as any, sessionId: 's', onError: () => undefined })));
      });
      await act(async () => { renderer.root.findByProps({ className: 'idea-tree-view' }).props.onClick(); });
    };
    const actionLabels = () => renderer.root.findAllByType('button')
      .map((button: any) => button.props.children)
      .filter((child: any) => typeof child === 'string');

    await render(budget);
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /已用 180000 tokens/);
    assert.match(rendered, /上限 200000 tokens/);
    assert.equal(rendered.includes('Remaining token budget cannot fund the next stage'), false);
    assert.equal(actionLabels().includes(zhCN['ideaResearch.end']), false, 'end would only no-op on the terminal state');
    assert.equal(actionLabels().includes(zhCN['ideaResearch.continue']), false, 'continue would hit the same ceiling');
    await act(async () => renderer.unmount());
    renderer = undefined;

    await render({ ...budget, status: 'paused', reason: 'Paused by user' });
    assert.ok(actionLabels().includes(zhCN['ideaResearch.continue']), 'a user pause still resumes');
    assert.ok(actionLabels().includes(zhCN['ideaResearch.end']), 'a user pause can still be ended');
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test("a delayed research list cannot replace a newer paused stream update", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  const view = (status: "running" | "pausing" | "paused", updatedAt: string): IdeaResearchView => ({
    research: {
      id: "r", status, objective: "synthetic", phase: "design", round: 1,
      settings: { maxRounds: 3 }, batch: [], batchCompleted: 0, tokens: 0, usageKnown: true,
    } as IdeaResearchView["research"],
    graph: { treeId: "r", updatedAt, nodes: [], edges: [] } as IdeaResearchView["graph"],
  });
  const running = view("running", "2026-11-25T08:58:38.222635+00:00");
  const pausing = view("pausing", "2026-11-25T08:58:38.222636+00:00");
  const paused = view("paused", "2026-11-25T08:58:38.222637+00:00");
  let resolveList!: (result: { items: IdeaResearchView[] }) => void;
  let onView!: (incoming: IdeaResearchView) => void;
  let attempts = 0;
  const client = {
    listIdeaResearch: () => ++attempts === 1
      ? Promise.resolve({ items: [running] })
      : new Promise(resolve => { resolveList = resolve; }),
    ideaResearchCommand: async () => pausing,
    subscribeIdeaResearch: async (_session: string, _id: string, callback: typeof onView) => { onView = callback; },
  } as unknown as ApiClient;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(IdeaResearchCard, { client, sessionId: "s", onError: error => assert.fail(String(error)) }));
    });
    assert.ok(renderer);
    await act(async () => { renderer.root.findByProps({ className: "idea-tree-view" }).props.onClick(); });
    const action = (label: string) => renderer.root.findAllByType("button").find(button => button.children.includes(label));
    const pause = action("Pause");
    assert.ok(pause);
    await act(async () => { pause.props.onClick(); });
    assert.equal(attempts, 2);
    await act(async () => { onView(paused); });
    assert.ok(action("Continue"));
    await act(async () => { resolveList({ items: [pausing] }); });
    assert.ok(action("Continue"));
  } finally {
    if (renderer) await act(async () => renderer?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
