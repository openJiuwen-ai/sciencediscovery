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
